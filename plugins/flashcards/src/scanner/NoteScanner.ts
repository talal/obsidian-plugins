import { parseFrontMatterTags, type App, type CachedMetadata, type TFile } from 'obsidian';

import type { DatabaseManager } from '../db/DatabaseManager.js';
import type { ObsidianSectionHint } from '../types.js';
import { WasmBridge } from '../wasm.js';
import {
	deduplicateBlockIds,
	generateBlockId,
	resolveNoteIdCollision,
	stampBlockId,
} from './identity.js';

function getSectionHints(fileCache: CachedMetadata | null): ObsidianSectionHint[] {
	return (fileCache?.sections ?? []).map((section) => ({
		type: section.type,
		line_start: section.position.start.line,
		line_end: section.position.end.line,
	}));
}

export class NoteScanner {
	constructor(
		private app: App,
		private db: DatabaseManager,
	) {}

	public generateBlockId(): string {
		return generateBlockId();
	}

	public async scanFile(
		file: TFile,
		registeredNoteIds?: Map<string, string>,
		skipPersist = false,
	): Promise<{
		blocksFound: number;
		modified: boolean;
		idCollisionFixed: boolean;
		duplicateBlocksFixed: number;
		ignored?: boolean;
	}> {
		let content = await this.app.vault.read(file);
		let fileCache = this.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter;
		let sectionHints = getSectionHints(fileCache);

		// Check if note is marked to be ignored for flashcards
		const isIgnored =
			frontmatter?.['cards-ignore'] === true ||
			String(frontmatter?.['cards-ignore']).toLowerCase() === 'true';

		if (isIgnored) {
			const mtime = file.stat?.mtime || Date.now();
			this.db.setNoteIgnoredByPath(file.path, true, mtime);
			if (!skipPersist) {
				await this.db.persist();
			}
			return {
				blocksFound: 0,
				modified: false,
				idCollisionFixed: false,
				duplicateBlocksFixed: 0,
				ignored: true,
			};
		}

		// Extract inherited tags from frontmatter
		const inheritedTags = parseFrontMatterTags(frontmatter ?? null) ?? [];

		// Initial parse to check if this note contains flashcards
		let parsed = WasmBridge.parseMarkdownBlocks(content, inheritedTags, sectionHints);
		let idCollisionFixed = false;

		if (parsed.length > 0) {
			// 1. Ensure Note has a truly unique frontmatter UUID BEFORE modifying file body
			const rawNoteId = frontmatter?.id as string | undefined;
			const conflictingPathInDb = rawNoteId ? this.db.getNotePathById(rawNoteId) : undefined;
			const oldFileExists = conflictingPathInDb
				? this.app.vault.getAbstractFileByPath(conflictingPathInDb) !== null
				: false;

			const collision = resolveNoteIdCollision({
				noteId: rawNoteId,
				filePath: file.path,
				conflictingPathInDb,
				conflictingPathInVault: rawNoteId ? registeredNoteIds?.get(rawNoteId) : undefined,
				oldFileExistsOnDisk: oldFileExists,
			});

			let noteId = collision.noteId;
			if (collision.idCollisionFixed) {
				idCollisionFixed = true;
			}

			if (!noteId) {
				noteId = crypto.randomUUID();
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm.id = noteId;
				});
				// Re-read content after frontmatter modification to ensure accurate line offsets
				content = await this.app.vault.read(file);
				fileCache = this.app.metadataCache.getFileCache(file);
				sectionHints = getSectionHints(fileCache);
				parsed = WasmBridge.parseMarkdownBlocks(content, inheritedTags, sectionHints);
			}

			registeredNoteIds?.set(noteId, file.path);

			// 2. Check for missing block IDs OR duplicate block IDs in this file
			let modifiedContent = content;
			let isModified = false;
			const { duplicateBlocksFixed } = deduplicateBlockIds(parsed);
			const seenBlockIds = new Set<string>();
			for (const b of parsed) {
				if (b.block_id) seenBlockIds.add(b.block_id);
			}

			if (parsed.some((b) => !b.block_id)) {
				const lines = modifiedContent.split('\n');
				for (const b of parsed) {
					if (!b.block_id) {
						let newId = this.generateBlockId();
						while (seenBlockIds.has(newId)) {
							newId = this.generateBlockId();
						}
						b.block_id = newId;
						seenBlockIds.add(newId);

						lines[b.line_start] = stampBlockId(lines[b.line_start] ?? '', b.card_type, newId);
						isModified = true;
					}
				}
				if (isModified) {
					modifiedContent = lines.join('\n');
					await this.app.vault.modify(file, modifiedContent);
					// Re-parse with the updated unique IDs
					parsed = WasmBridge.parseMarkdownBlocks(modifiedContent, inheritedTags, sectionHints);
				}
			}

			const mtime = file.stat?.mtime || Date.now();
			this.db.upsertNote(noteId, file.path, mtime, 0);
			this.db.syncNoteBlocks(noteId, parsed);
			if (!skipPersist) {
				await this.db.persist();
			}

			return {
				blocksFound: parsed.length,
				modified: isModified,
				idCollisionFixed,
				duplicateBlocksFixed,
			};
		} else {
			// If note contains no flashcards, remove any stale records
			this.db.deleteNoteByPath(file.path);
			if (!skipPersist) {
				await this.db.persist();
			}

			return {
				blocksFound: 0,
				modified: false,
				idCollisionFixed: false,
				duplicateBlocksFixed: 0,
			};
		}
	}

	public async scanVault(): Promise<{
		notesScanned: number;
		totalCards: number;
		idCollisionsFixed: number;
		duplicateBlocksFixed: number;
		failedFiles: string[];
	}> {
		const files = this.app.vault.getMarkdownFiles();
		const validPaths = new Set(files.map((f) => f.path));
		const registeredNoteIds = new Map<string, string>();
		let notesScanned = 0;
		let totalCards = 0;
		let idCollisionsFixed = 0;
		let duplicateBlocksFixed = 0;
		const failedFiles: string[] = [];

		for (const file of files) {
			try {
				const res = await this.scanFile(file, registeredNoteIds, true);
				notesScanned++;
				totalCards += res.blocksFound;
				if (res.idCollisionFixed) idCollisionsFixed++;
				duplicateBlocksFixed += res.duplicateBlocksFixed;
			} catch (error) {
				console.error(`[Flashcards] Failed to scan note "${file.path}":`, error);
				failedFiles.push(file.path);
			}
		}

		// Prune any notes in SQLite that no longer exist in the vault
		this.db.pruneDeletedNotes(validPaths);
		await this.db.persist();

		return {
			notesScanned,
			totalCards,
			idCollisionsFixed,
			duplicateBlocksFixed,
			failedFiles,
		};
	}
}
