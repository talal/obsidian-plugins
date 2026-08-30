import type { App, CachedMetadata, TFile } from 'obsidian';

import type { DatabaseManager } from '../db/DatabaseManager.js';
import type {
	DocumentSyncResult,
	FullScanOptions,
	ObsidianSectionHint,
	ParsedBlock,
	ScanResult,
	SyncFileOptions,
} from '../types.js';
import { fnv1a64 } from '../utils/fnv1a.js';
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
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private app: App,
		private db: DatabaseManager,
	) {}

	/**
	 * Serializes scanner operations (sync, fullScan, rename, delete) to prevent
	 * concurrent database writes or overlapping file synchronizations.
	 */
	public runSerialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.catch(() => undefined).then(operation);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	public syncFile(
		file: TFile,
		optionsOrExternalIds?: Set<string> | CollisionRegistry | SyncFileOptions,
		skipPersist = false,
	): Promise<ParsedBlock[]> {
		return this.runSerialized(async () => {
			let force = false;
			let externalCollisionIds: Set<string> | CollisionRegistry | undefined;
			let shouldSkipPersist = skipPersist;

			if (optionsOrExternalIds) {
				if (
					optionsOrExternalIds instanceof Set ||
					optionsOrExternalIds instanceof CollisionRegistry
				) {
					externalCollisionIds = optionsOrExternalIds;
				} else if (typeof optionsOrExternalIds === 'object') {
					force = optionsOrExternalIds.force ?? false;
					externalCollisionIds = optionsOrExternalIds.externalCollisionIds;
					if (optionsOrExternalIds.skipPersist !== undefined) {
						shouldSkipPersist = optionsOrExternalIds.skipPersist;
					}
				}
			}

			const fileCache = this.app.metadataCache.getFileCache(file);
			const frontmatter = fileCache?.frontmatter;

			// Check if note is marked to be ignored for flashcards
			const isIgnored =
				frontmatter?.['cards-ignore'] === true ||
				String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

			if (isIgnored) {
				this.db.syncNoteBlocks(file.path, []);
				this.db.deleteFileSyncState(file.path);
				if (!shouldSkipPersist) {
					await this.db.persist();
				}
				return [];
			}

			const mtime = file.stat?.mtime;
			const size = file.stat?.size;

			// Check file change detection fingerprint if metadata is available
			if (!force && mtime !== undefined && size !== undefined) {
				const existingState = this.db.getFileSyncState(file.path);
				if (existingState && existingState.modified_at === mtime && existingState.size === size) {
					const existingBlocks = this.db.getBlocksForFile(file.path);
					if (externalCollisionIds instanceof CollisionRegistry) {
						for (const b of existingBlocks) {
							externalCollisionIds.insert(b.id);
						}
					} else if (externalCollisionIds instanceof Set) {
						for (const b of existingBlocks) {
							externalCollisionIds.add(b.id);
						}
					}
					return existingBlocks;
				}
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

			// Update file sync state fingerprint
			const updatedMtime = file.stat?.mtime ?? mtime ?? Date.now();
			const updatedSize = file.stat?.size ?? size ?? content.length;
			const contentHash = fnv1a64(result.updated_content ?? content);
			this.db.upsertFileSyncState({
				file_path: file.path,
				modified_at: updatedMtime,
				size: updatedSize,
				content_hash: contentHash,
				updated_at: Date.now(),
			});

			if (!shouldSkipPersist) {
				await this.db.persist();
			}

			return result.blocks;
		});
	}

	public fullScan(filesToScan?: TFile[], options?: FullScanOptions): Promise<ScanResult> {
		return this.runSerialized(async () => {
			const files = filesToScan ?? this.app.vault.getMarkdownFiles();
			const validPaths = new Set(files.map((f) => f.path));
			const force = options?.force ?? false;

			let totalBlocks = 0;
			let filesScanned = 0;
			let filesSkipped = 0;
			let dbModified = false;
			const failedFiles: string[] = [];

			// Preload in-memory indices for ultra-fast skipping
			const syncStates = this.db.getAllFileSyncStates();
			const fileToBlockIds = this.db.getFileToBlockIdsMap();
			const fileToBlocks = this.db.getFileToBlocksMap();

			// Scan-scoped registry: lives for the entire duration of the vault scan.
			// Markdown is the authoritative source of truth for block IDs.
			const registry = WasmBridge.createCollisionRegistry();
			try {
				for (const file of files) {
					try {
						const fileCache = this.app.metadataCache.getFileCache(file);
						const frontmatter = fileCache?.frontmatter;

						const isIgnored =
							frontmatter?.['cards-ignore'] === true ||
							String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

						if (isIgnored) {
							if (fileToBlocks.has(file.path) || syncStates.has(file.path)) {
								this.db.syncNoteBlocks(file.path, []);
								this.db.deleteFileSyncState(file.path);
								dbModified = true;
							}
							continue;
						}

						const mtime = file.stat?.mtime;
						const size = file.stat?.size;
						const state = syncStates.get(file.path);

						// Change detection: skip unchanged files
						if (
							!force &&
							mtime !== undefined &&
							size !== undefined &&
							state &&
							state.modified_at === mtime &&
							state.size === size
						) {
							const existingIds = fileToBlockIds.get(file.path) ?? [];
							for (const id of existingIds) {
								registry.insert(id);
							}
							const existingBlocks = fileToBlocks.get(file.path) ?? [];
							totalBlocks += existingBlocks.length;
							filesSkipped++;
							continue;
						}

						// File changed or force scan: read and synchronize
						const content = await this.app.vault.cachedRead(file);
						const inheritedTags = getInheritedTags(fileCache);
						const sectionHints = getSectionHints(fileCache);

						const result = WasmBridge.syncDocumentWithRegistry(
							content,
							registry,
							inheritedTags,
							sectionHints,
						);

						if (result.updated_content !== null && result.updated_content !== content) {
							await this.app.vault.modify(file, result.updated_content);
						}

						this.db.syncNoteBlocks(file.path, result.blocks);

						const updatedMtime = file.stat?.mtime ?? mtime ?? Date.now();
						const updatedSize = file.stat?.size ?? size ?? content.length;
						const contentHash = fnv1a64(result.updated_content ?? content);
						this.db.upsertFileSyncState({
							file_path: file.path,
							modified_at: updatedMtime,
							size: updatedSize,
							content_hash: contentHash,
							updated_at: Date.now(),
						});

						totalBlocks += result.blocks.length;
						filesScanned++;
						dbModified = true;
					} catch (error) {
						console.error(`[Flashcards] Failed to sync note "${file.path}":`, error);
						failedFiles.push(file.path);
					}
				}

				// Prune any deleted notes from database
				const pruned = this.db.pruneDeletedNotes(validPaths);
				if (pruned > 0) {
					dbModified = true;
				}

				if (dbModified || force) {
					await this.db.persist();
				}
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
				filesScanned,
				filesSkipped,
				totalBlocks,
				failedFiles,
			};
		});
	}

	public deleteFile(filePath: string): Promise<void> {
		return this.runSerialized(async () => {
			this.db.syncNoteBlocks(filePath, []);
			this.db.deleteFileSyncState(filePath);
			await this.db.persist();
		});
	}

	public renameFile(oldPath: string, newPath: string): Promise<void> {
		return this.runSerialized(async () => {
			this.db.renameNote(oldPath, newPath);
			await this.db.persist();
		});
	}
}
