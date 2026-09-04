import type { App } from 'obsidian';

import { FlashcardsEngine } from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';

export const FLASHCARDS_DATA_DIR = '.flashcards';
export const FLASHCARDS_BIN_PATH = `${FLASHCARDS_DATA_DIR}/cards.bin`;

export class SnapshotStore {
	private static lastKnownSnapshotMtime = 0;
	private static lastKnownSnapshotSize = 0;
	private static saveQueue: Promise<void> = Promise.resolve();

	public static getLastKnownSnapshotMtime(): number {
		return this.lastKnownSnapshotMtime;
	}

	public static setLastKnownSnapshotMtime(mtime: number): void {
		this.lastKnownSnapshotMtime = mtime;
	}

	public static getLastKnownSnapshotSize(): number {
		return this.lastKnownSnapshotSize;
	}

	public static setLastKnownSnapshotSize(size: number): void {
		this.lastKnownSnapshotSize = size;
	}

	public static async loadEngine(app: App): Promise<FlashcardsEngine> {
		let engine: FlashcardsEngine | null = null;

		if (await app.vault.adapter.exists(FLASHCARDS_BIN_PATH)) {
			try {
				const stat = await app.vault.adapter.stat(FLASHCARDS_BIN_PATH);
				const bytes = await app.vault.adapter.readBinary(FLASHCARDS_BIN_PATH);
				engine = FlashcardsEngine.from_bytes(new Uint8Array(bytes));
				this.lastKnownSnapshotMtime = stat?.mtime ?? 0;
				this.lastKnownSnapshotSize = stat?.size ?? 0;
			} catch (err) {
				console.error('[Flashcards] Failed to load cards.bin snapshot, creating new store:', err);
				this.lastKnownSnapshotMtime = 0;
				this.lastKnownSnapshotSize = 0;
				engine = new FlashcardsEngine();
			}
		}

		if (!engine) {
			this.lastKnownSnapshotMtime = 0;
			this.lastKnownSnapshotSize = 0;
			engine = new FlashcardsEngine();
		}

		// Also check for any existing Syncthing conflict files and merge them
		await this.resolveSyncConflicts(app, engine);

		return engine;
	}

	public static async resolveSyncConflicts(app: App, engine: FlashcardsEngine): Promise<boolean> {
		let mergedAny = false;
		try {
			if (await app.vault.adapter.exists(FLASHCARDS_DATA_DIR)) {
				const listResult = await app.vault.adapter.list(FLASHCARDS_DATA_DIR);
				for (const filePath of listResult.files) {
					const fileName = filePath.split('/').pop() ?? '';
					if (fileName.startsWith('cards.sync-conflict-') && fileName.endsWith('.bin')) {
						try {
							const bytes = await app.vault.adapter.readBinary(filePath);
							const changed = engine.merge_from_bytes(new Uint8Array(bytes));
							if (changed) {
								mergedAny = true;
							}
							await app.vault.adapter.remove(filePath);
							console.log(`[Flashcards] Resolved and merged Syncthing conflict file: ${fileName}`);
						} catch (conflictErr) {
							console.error(`[Flashcards] Failed to merge conflict file ${filePath}:`, conflictErr);
						}
					}
				}
			}
		} catch (err) {
			console.error('[Flashcards] Failed to scan for Syncthing conflict files:', err);
		}
		return mergedAny;
	}

	public static async reloadOrMergeIfModified(
		app: App,
		engine: FlashcardsEngine,
	): Promise<boolean> {
		let modified = false;
		try {
			// 1. First resolve any Syncthing conflict files
			const conflictsResolved = await this.resolveSyncConflicts(app, engine);
			if (conflictsResolved) {
				modified = true;
			}

			// 2. Check if primary cards.bin has changed on disk
			if (await app.vault.adapter.exists(FLASHCARDS_BIN_PATH)) {
				const stat = await app.vault.adapter.stat(FLASHCARDS_BIN_PATH);
				const mtime = stat?.mtime ?? 0;
				const size = stat?.size ?? 0;
				if (
					size > 0 &&
					(mtime !== this.lastKnownSnapshotMtime || size !== this.lastKnownSnapshotSize)
				) {
					const bytes = await app.vault.adapter.readBinary(FLASHCARDS_BIN_PATH);
					const changed = engine.merge_from_bytes(new Uint8Array(bytes));
					this.lastKnownSnapshotMtime = mtime;
					this.lastKnownSnapshotSize = size;
					if (changed) {
						modified = true;
					}
				}
			}

			// If conflict files were absorbed, persist the consolidated cards.bin
			if (conflictsResolved) {
				await this.saveEngine(app, engine);
			}
		} catch (err) {
			console.error('[Flashcards] Failed to reload or merge cards.bin:', err);
		}
		return modified;
	}

	public static async saveEngine(app: App, engine: FlashcardsEngine): Promise<void> {
		this.saveQueue = this.saveQueue
			.then(async () => {
				if (!(await app.vault.adapter.exists(FLASHCARDS_DATA_DIR))) {
					await app.vault.adapter.mkdir(FLASHCARDS_DATA_DIR);
				}

				// Pre-save safety guard: if external changes occurred on disk (e.g. Syncthing sync from mobile),
				// merge them into memory first before serializing, so we never clobber remote reviews!
				if (await app.vault.adapter.exists(FLASHCARDS_BIN_PATH)) {
					const stat = await app.vault.adapter.stat(FLASHCARDS_BIN_PATH);
					const diskMtime = stat?.mtime ?? 0;
					const diskSize = stat?.size ?? 0;
					if (
						diskSize > 0 &&
						(diskMtime !== this.lastKnownSnapshotMtime || diskSize !== this.lastKnownSnapshotSize)
					) {
						try {
							const externalBytes = await app.vault.adapter.readBinary(FLASHCARDS_BIN_PATH);
							engine.merge_from_bytes(new Uint8Array(externalBytes));
						} catch (mergeErr) {
							console.error(
								'[Flashcards] Failed to merge external cards.bin before saving:',
								mergeErr,
							);
						}
					}
				}

				// Also resolve any conflict files before saving
				await this.resolveSyncConflicts(app, engine);

				const bytes = engine.to_bytes();
				const copy = new Uint8Array(bytes);
				await app.vault.adapter.writeBinary(FLASHCARDS_BIN_PATH, copy.buffer as ArrayBuffer);
				const newStat = await app.vault.adapter.stat(FLASHCARDS_BIN_PATH);
				this.lastKnownSnapshotMtime = newStat?.mtime ?? Date.now();
				this.lastKnownSnapshotSize = newStat?.size ?? bytes.byteLength;
			})
			.catch((err) => {
				console.error('[Flashcards] Failed to save cards.bin snapshot:', err);
				throw err;
			});

		return this.saveQueue;
	}
}
