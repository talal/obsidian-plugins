import type { Plugin } from 'obsidian';

export interface SyncCacheData {
	files: Record<string, { mtime: number; cardIds: string[] }>;
	notes: Record<string, string>; // UUID -> Hash
}

const CACHE_FILE = 'cache.json';

export class SyncCache {
	private plugin: Plugin;
	private data: SyncCacheData = { files: {}, notes: {} };

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async load(): Promise<void> {
		try {
			const raw = await this.plugin.app.vault.adapter.read(
				`${this.plugin.manifest.dir}/${CACHE_FILE}`,
			);
			const parsed = JSON.parse(raw);
			this.data = {
				files: parsed.files ?? {},
				notes: parsed.notes ?? {},
			};
		} catch {
			this.data = { files: {}, notes: {} };
		}
	}

	async save(): Promise<void> {
		await this.plugin.app.vault.adapter.write(
			`${this.plugin.manifest.dir}/${CACHE_FILE}`,
			JSON.stringify(this.data, null, '\t'),
		);
	}

	getFile(filePath: string) {
		return this.data.files[filePath];
	}

	setFile(filePath: string, entry: { mtime: number; cardIds: string[] }): void {
		if (entry.cardIds.length === 0) {
			delete this.data.files[filePath];
		} else {
			this.data.files[filePath] = entry;
		}
	}

	isStale(filePath: string, currentMtime: number): boolean {
		const cached = this.data.files[filePath];
		if (!cached) return true;
		return cached.mtime !== currentMtime;
	}

	getAllPaths(): string[] {
		return Object.keys(this.data.files);
	}

	remove(filePath: string): void {
		delete this.data.files[filePath];
	}

	getNotesJsonForFile(filePath: string): string {
		const fileData = this.data.files[filePath];
		if (!fileData || !fileData.cardIds) return '{}';
		const subset: Record<string, string> = {};
		for (const id of fileData.cardIds) {
			if (this.data.notes[id]) {
				subset[id] = this.data.notes[id];
			}
		}
		return JSON.stringify(subset);
	}

	getNotesJson(): string {
		return JSON.stringify(this.data.notes);
	}

	updateNotes(updatedCache: Record<string, string>): void {
		this.data.notes = { ...this.data.notes, ...updatedCache };
	}

	removeNote(uuid: string): void {
		delete this.data.notes[uuid];
	}
}
