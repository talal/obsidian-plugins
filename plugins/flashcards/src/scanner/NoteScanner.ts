import type { App, CachedMetadata, TFile } from 'obsidian';

import type { DatabaseManager } from '../db/DatabaseManager.js';
import type { DocumentSyncResult, ObsidianSectionHint, ParsedBlock } from '../types.js';
import { CollisionRegistry, WasmBridge } from '../wasm.js';

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

	// 1. Tags in file body (#tag)
	if (fileCache?.tags) {
		for (const tagRef of fileCache.tags) {
			const clean = tagRef.tag.replace(/^#/, '').trim();
			if (clean) tagsSet.add(clean);
		}
	}

	// 2. Frontmatter tags
	const fmTags = parseFrontMatterTags(fileCache?.frontmatter ?? null) ?? [];
	for (const tag of fmTags) {
		const clean = tag.replace(/^#/, '').trim();
		if (clean) tagsSet.add(clean);
	}

	return Array.from(tagsSet);
}

export class NoteScanner {
	constructor(
		private app: App,
		private db: DatabaseManager,
	) {}

	public async syncFile(
		file: TFile,
		externalCollisionIds?: Set<string> | CollisionRegistry,
		skipPersist = false,
	): Promise<ParsedBlock[]> {
		const fileCache = this.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter;

		// Check if note is marked to be ignored for flashcards
		const isIgnored =
			frontmatter?.['cards-ignore'] === true ||
			String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

		if (isIgnored) {
			this.db.syncNoteBlocks(file.path, []);
			if (!skipPersist) {
				await this.db.persist();
			}
			return [];
		}

		const content = await this.app.vault.cachedRead(file);
		const inheritedTags = getInheritedTags(fileCache);
		const sectionHints = getSectionHints(fileCache);

		let result: DocumentSyncResult;
		if (externalCollisionIds instanceof CollisionRegistry) {
			result = WasmBridge.syncDocumentWithRegistry(
				content,
				externalCollisionIds,
				inheritedTags,
				sectionHints,
			);
		} else {
			const externalIds = externalCollisionIds ?? this.db.getBlockIdsExcludingFile(file.path);
			const registry = WasmBridge.createCollisionRegistry(externalIds);
			try {
				result = WasmBridge.syncDocumentWithRegistry(
					content,
					registry,
					inheritedTags,
					sectionHints,
				);
			} finally {
				registry.free();
			}
		}

		// If missing IDs were generated or duplicate IDs replaced, write updated Markdown once
		if (result.updated_content !== null && result.updated_content !== content) {
			await this.app.vault.modify(file, result.updated_content);
		}

		// Reconcile SQLite database
		this.db.syncNoteBlocks(file.path, result.blocks);

		if (!skipPersist) {
			await this.db.persist();
		}

		return result.blocks;
	}

	public async fullScan(filesToScan?: TFile[]): Promise<{
		filesScanned: number;
		totalBlocks: number;
		failedFiles: string[];
	}> {
		const files = filesToScan ?? this.app.vault.getMarkdownFiles();
		const validPaths = new Set(files.map((f) => f.path));
		let totalBlocks = 0;
		const failedFiles: string[] = [];

		// Scan-scoped registry: lives for the entire duration of the vault scan.
		// Markdown is the authoritative source of truth for block IDs.
		const registry = WasmBridge.createCollisionRegistry();
		try {
			for (const file of files) {
				try {
					const blocks = await this.syncFile(file, registry, true);
					totalBlocks += blocks.length;
				} catch (error) {
					console.error(`[Flashcards] Failed to sync note "${file.path}":`, error);
					failedFiles.push(file.path);
				}
			}

			// Prune any deleted notes from database
			this.db.pruneDeletedNotes(validPaths);
			await this.db.persist();
		} finally {
			registry.free();
		}

		if (failedFiles.length > 0) {
			console.warn(
				`[Flashcards] Full vault scan completed with ${failedFiles.length} failed note(s):`,
				failedFiles,
			);
		}

		return {
			filesScanned: files.length,
			totalBlocks,
			failedFiles,
		};
	}

	public async deleteFile(filePath: string): Promise<void> {
		this.db.syncNoteBlocks(filePath, []);
		await this.db.persist();
	}

	public async renameFile(oldPath: string, newPath: string): Promise<void> {
		this.db.renameNote(oldPath, newPath);
		await this.db.persist();
	}
}
