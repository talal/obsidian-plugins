import type { App, CachedMetadata, TFile } from 'obsidian';

import { SnapshotStore } from '../storage.js';
import type { ObsidianSectionHint, ScanResult, SyncNoteResult } from '../types.js';
import { type FlashcardsEngine, WasmBridge } from '../wasm.js';

function parseFrontMatterTags(
	frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
	if (!frontmatter) return null;
	const tags = frontmatter.tags ?? frontmatter.tag;
	if (!tags) return null;
	if (Array.isArray(tags)) {
		return tags.map(String).filter(Boolean);
	}
	if (typeof tags === 'string') {
		return tags
			.split(/[,\s]+/)
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return null;
}

function getSectionHints(fileCache: CachedMetadata | null): ObsidianSectionHint[] {
	return (fileCache?.sections ?? []).map((section) => ({
		type: section.type,
		line_start: section.position.start.line,
		line_end: section.position.end.line,
	}));
}

function getInheritedTags(fileCache: CachedMetadata | null): string[] {
	const tagsSet = new Set<string>();

	// Only frontmatter tags apply to the entire note as inherited tags.
	// Card-level inline tags are extracted directly from prompt text by the Rust parser.
	const fmTags = parseFrontMatterTags(fileCache?.frontmatter ?? null) ?? [];
	for (const tag of fmTags) {
		const clean = tag.replace(/^#/, '').trim();
		if (clean) tagsSet.add(clean);
	}

	return Array.from(tagsSet);
}

export class NoteScanner {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private app: App,
		private engine: FlashcardsEngine,
	) {}

	public setEngine(engine: FlashcardsEngine): void {
		this.engine = engine;
	}

	public runSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.catch(() => undefined).then(operation);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	public syncFile(file: TFile, options?: { force?: boolean }): Promise<SyncNoteResult> {
		return this.runSerialized(async () => {
			const fileCache = this.app.metadataCache.getFileCache(file);
			const frontmatter = fileCache?.frontmatter;

			const isIgnored =
				frontmatter?.['cards-ignore'] === true ||
				String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

			if (isIgnored) {
				this.engine.remove_file(file.path);
				await SnapshotStore.saveEngine(this.app, this.engine);
				return { updated_content: null, prompt_count: 0 };
			}

			const mtime = file.stat?.mtime ?? Date.now();
			const size = file.stat?.size ?? 0;

			if (!options?.force && this.engine.is_file_unchanged(file.path, mtime, size)) {
				return { updated_content: null, prompt_count: 0 };
			}

			const content = await this.app.vault.cachedRead(file);
			const inheritedTags = getInheritedTags(fileCache);
			const sectionHints = getSectionHints(fileCache);

			const result = WasmBridge.syncNote(
				this.engine,
				file.path,
				content,
				mtime,
				size,
				inheritedTags,
				sectionHints,
			);

			if (result.updated_content !== null && result.updated_content !== content) {
				await this.app.vault.modify(file, result.updated_content);
			}

			await SnapshotStore.saveEngine(this.app, this.engine);
			return result;
		});
	}

	public fullScan(filesToScan?: TFile[], options?: { force?: boolean }): Promise<ScanResult> {
		return this.runSerialized(async () => {
			const files = filesToScan ?? this.app.vault.getMarkdownFiles();
			const validPaths = new Set(files.map((f) => f.path));
			const force = options?.force ?? false;

			let totalPrompts = 0;
			let filesScanned = 0;
			let filesSkipped = 0;
			const failedFiles: string[] = [];

			for (const file of files) {
				try {
					const fileCache = this.app.metadataCache.getFileCache(file);
					const frontmatter = fileCache?.frontmatter;

					const isIgnored =
						frontmatter?.['cards-ignore'] === true ||
						String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

					if (isIgnored) {
						this.engine.remove_file(file.path);
						continue;
					}

					const mtime = file.stat?.mtime ?? Date.now();
					const size = file.stat?.size ?? 0;

					if (!force && this.engine.is_file_unchanged(file.path, mtime, size)) {
						filesSkipped++;
						continue;
					}

					const content = await this.app.vault.cachedRead(file);
					const inheritedTags = getInheritedTags(fileCache);
					const sectionHints = getSectionHints(fileCache);

					const result = WasmBridge.syncNote(
						this.engine,
						file.path,
						content,
						mtime,
						size,
						inheritedTags,
						sectionHints,
					);

					if (result.updated_content !== null && result.updated_content !== content) {
						await this.app.vault.modify(file, result.updated_content);
					}

					totalPrompts += result.prompt_count;
					filesScanned++;
				} catch (error) {
					console.error(`[Flashcards] Failed to sync note "${file.path}":`, error);
					failedFiles.push(file.path);
				}
			}

			this.engine.prune_deleted_files(JSON.stringify(Array.from(validPaths)));
			await SnapshotStore.saveEngine(this.app, this.engine);

			return {
				filesScanned,
				filesSkipped,
				totalPrompts,
				failedFiles,
			};
		});
	}

	public deleteFile(filePath: string): Promise<void> {
		return this.runSerialized(async () => {
			this.engine.remove_file(filePath);
			await SnapshotStore.saveEngine(this.app, this.engine);
		});
	}

	public renameFile(oldPath: string, newPath: string): Promise<void> {
		return this.runSerialized(async () => {
			this.engine.rename_file(oldPath, newPath);
			await SnapshotStore.saveEngine(this.app, this.engine);
		});
	}
}
