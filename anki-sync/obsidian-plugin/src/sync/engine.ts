import { App, TFile } from 'obsidian';
import type { SyncResult } from '../types';
import type { PluginSettings } from '../config';
import { scanFile } from '../parser/index';
import { AddonClient } from '../anki/client';
import { SyncCache } from './cache';

export class SyncEngine {
	private app: App;
	private settings: PluginSettings;
	public client: AddonClient;
	private cache: SyncCache;

	constructor(app: App, settings: PluginSettings, cache: SyncCache) {
		this.app = app;
		this.settings = settings;
		this.client = new AddonClient();
		this.client.setApiKey(this.settings.apiKey);
		this.cache = cache;
	}

	async syncFile(file: TFile, force = false, skipSave = false): Promise<SyncResult> {
		const result: SyncResult = {
			created: 0,
			updated: 0,
			skipped: 0,
			orphaned: 0,
			errors: [],
		};

		// Read file content
		const content = await this.app.vault.read(file);

		// Resolve deck — frontmatter anki-deck
		const fileCache = this.app.metadataCache.getFileCache(file);
		const deck = fileCache?.frontmatter?.['anki-deck'];
		if (!deck) {
			result.errors.push(`Missing 'anki-deck' frontmatter in ${file.path}`);
			return result;
		}
		// Run thick WASM scan (parses, injects IDs, diffs against cache, generates HTML payload)
		const cacheJson = this.cache.getNotesJsonForFile(file.path);

		let scanResult;
		try {
			scanResult = scanFile(content, file.path, deck, cacheJson, force);
		} catch (e) {
			result.errors.push(`WASM processing failed for ${file.path}: ${e}`);
			return result;
		}

		const { modifiedMarkdown, ankiPayload, updatedCache, currentFileIds } = scanResult;

		// Immediately save markdown if WASM injected any new UUIDs
		if (modifiedMarkdown !== content) {
			await this.app.vault.modify(file, modifiedMarkdown);
			const stat = await this.app.vault.adapter.stat(file.path);
			if (stat) file.stat.mtime = stat.mtime;
		}

		// Push to Anki if there's anything to sync
		if (ankiPayload && ankiPayload.length > 0) {
			try {
				const responseMap = await this.client.syncNotes(ankiPayload);

				// Reconcile response map
				for (const payloadItem of ankiPayload) {
					const uuid = payloadItem.uuid;
					const status = responseMap[uuid];

					if (status === 'success') {
						result.updated++;
					} else {
						// Remove from cache so it retries next time
						delete updatedCache[uuid];
						this.cache.removeNote(uuid);
						result.errors.push(`Card ${uuid}: ${status}`);
					}
				}
			} catch (e) {
				result.errors.push(
					`Network error pushing to Anki: ${e instanceof Error ? e.message : String(e)}`,
				);
				return result;
			}
		}

		// Orphan detection
		const cachedFile = this.cache.getFile(file.path);
		if (cachedFile) {
			const orphanedIds = cachedFile.cardIds.filter(
				(cachedId) => !currentFileIds.includes(cachedId),
			);
			if (orphanedIds.length > 0) {
				result.orphaned = orphanedIds.length;
				const msg = `Anki Sync: ${orphanedIds.length} orphaned note(s) in ${file.path}: IDs [${orphanedIds.join(', ')}]. Tagging as 'orphan' in Anki.`;
				console.warn(msg);

				try {
					await this.client.markOrphaned(orphanedIds);
					// Successfully marked in Anki, prune from our local cache so it doesn't grow forever.
					// If the user un-deletes the card, its missing cache entry will force a fresh sync.
					for (const id of orphanedIds) {
						delete updatedCache[id];
						this.cache.removeNote(id);
					}
				} catch (e) {
					console.error(
						`Anki Sync: Failed to tag orphaned notes: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
		}

		this.cache.updateNotes(updatedCache);
		this.cache.setFile(file.path, {
			mtime: file.stat.mtime,
			cardIds: currentFileIds,
		});
		if (!skipSave) {
			await this.cache.save();
		}

		return result;
	}

	async testConnection(): Promise<'unreachable' | 'unauthorized' | 'profile-not-loaded' | 'ok'> {
		return this.client.testConnection();
	}
}
