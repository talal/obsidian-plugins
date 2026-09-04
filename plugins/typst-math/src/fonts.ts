import type { Plugin } from 'obsidian';

export const FONT_FAMILY = 'New Computer Modern Math';
export const FONT_FILENAME = 'NewCMMath-Book.woff2';

export class FontManager {
	private loadedFace: FontFace | null = null;
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
		try {
			const fontPath = `${plugin.manifest.dir}/fonts/${FONT_FILENAME}`;
			const buffer = await plugin.app.vault.adapter.readBinary(fontPath);
			const face = new FontFace(FONT_FAMILY, buffer);
			await face.load();
			document.fonts.add(face);
			this.loadedFace = face;
		} catch (e) {
			console.warn(`[typst-math] Failed to load font ${FONT_FAMILY}:`, e);
		}
	}

	public isLoaded(): boolean {
		return this.loadedFace !== null;
	}

	public unload(): void {
		if (this.loadedFace && typeof document !== 'undefined' && document.fonts) {
			document.fonts.delete(this.loadedFace);
		}
		this.loadedFace = null;
		this.loadPromise = null;
	}
}
