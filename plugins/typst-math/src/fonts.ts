import type { Plugin } from 'obsidian';

export interface FontDefinition {
	family: string;
	filename: string;
}

export const FONT_DEFINITIONS: readonly FontDefinition[] = [
	{ family: 'New Computer Modern Math', filename: 'NewCMMath-Book.woff2' },
	{ family: 'NewCMMath-Book', filename: 'NewCMMath-Book.woff2' },
];

export class FontManager {
	private loadedFaces: FontFace[] = [];
	private loadPromise: Promise<void> | null = null;

	public async load(plugin: Plugin): Promise<void> {
		if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
			return;
		}

		if (!this.loadPromise) {
			this.loadPromise = this.doLoad(plugin);
			this.loadPromise.catch(() => {
				this.loadPromise = null;
			});
		}
		return this.loadPromise;
	}

	private async doLoad(plugin: Plugin): Promise<void> {
		const bufferCache = new Map<string, ArrayBuffer>();

		for (const def of FONT_DEFINITIONS) {
			try {
				let buffer = bufferCache.get(def.filename);
				if (!buffer) {
					const fontPath = `${plugin.manifest.dir}/fonts/${def.filename}`;
					buffer = await plugin.app.vault.adapter.readBinary(fontPath);
					bufferCache.set(def.filename, buffer);
				}

				const face = new FontFace(def.family, buffer);
				await face.load();
				document.fonts.add(face);
				this.loadedFaces.push(face);
			} catch (e) {
				// Suppress errors when fonts cannot be loaded (e.g. in test runner or incomplete install)
				console.warn(`[typst-math] Failed to load font ${def.family} (${def.filename}):`, e);
			}
		}
	}

	public isLoaded(): boolean {
		return this.loadedFaces.length > 0;
	}

	public unload(): void {
		if (typeof document === 'undefined' || !document.fonts) {
			this.loadedFaces = [];
			return;
		}

		for (const face of this.loadedFaces) {
			document.fonts.delete(face);
		}
		this.loadedFaces = [];
		this.loadPromise = null;
	}
}
