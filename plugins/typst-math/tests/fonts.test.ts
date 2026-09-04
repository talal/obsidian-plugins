import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { FONT_DEFINITIONS, FontManager } from '../src/fonts';

describe('Fonts', () => {
	it('defines OpenType Math font definitions', () => {
		expect(FONT_DEFINITIONS.length).toBeGreaterThan(0);
		expect(FONT_DEFINITIONS.some((d) => d.family === 'New Computer Modern Math')).toBe(true);
		expect(FONT_DEFINITIONS.some((d) => d.family === 'NewCMMath-Book')).toBe(true);
	});

	it('ensures all referenced font files exist on disk in the fonts directory', () => {
		const fontsDir = path.resolve(__dirname, '../fonts');
		const uniqueFiles = new Set(FONT_DEFINITIONS.map((d) => d.filename));
		for (const filename of uniqueFiles) {
			const filePath = path.join(fontsDir, filename);
			expect(fs.existsSync(filePath), `Missing font file: ${filename}`).toBe(true);
			const stats = fs.statSync(filePath);
			expect(stats.size).toBeGreaterThan(0);
		}
	});

	describe('FontManager', () => {
		let fontManager: FontManager;
		let mockPlugin: any;
		let addedFaces: any[] = [];

		beforeEach(() => {
			fontManager = new FontManager();
			addedFaces = [];

			// Mock FontFace and document.fonts for Node test environment
			(globalThis as any).FontFace = class MockFontFace {
				family: string;
				source: any;
				constructor(family: string, source: any) {
					this.family = family;
					this.source = source;
				}
				async load() {
					return this;
				}
			};

			(globalThis as any).document = {
				fonts: {
					add: (face: any) => {
						addedFaces.push(face);
					},
					delete: (face: any) => {
						const index = addedFaces.indexOf(face);
						if (index !== -1) addedFaces.splice(index, 1);
					},
				},
			};

			mockPlugin = {
				manifest: {
					dir: 'fonts',
				},
				app: {
					vault: {
						adapter: {
							readBinary: async (filePath: string) => {
								const filename = path.basename(filePath);
								const absolutePath = path.resolve(__dirname, '../fonts', filename);
								const buffer = await fs.promises.readFile(absolutePath);
								return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
							},
						},
					},
				},
			};
		});

		afterEach(() => {
			fontManager.unload();
			delete (globalThis as any).FontFace;
			delete (globalThis as any).document;
		});

		it('loads fonts and registers them with document.fonts', async () => {
			expect(fontManager.isLoaded()).toBe(false);
			await fontManager.load(mockPlugin);

			expect(fontManager.isLoaded()).toBe(true);
			expect(addedFaces.length).toBe(FONT_DEFINITIONS.length);

			// Unload removes all added fonts
			fontManager.unload();
			expect(fontManager.isLoaded()).toBe(false);
			expect(addedFaces.length).toBe(0);
		});

		it('handles multiple load calls idempotently', async () => {
			await fontManager.load(mockPlugin);
			expect(addedFaces.length).toBe(FONT_DEFINITIONS.length);

			await fontManager.load(mockPlugin);
			expect(addedFaces.length).toBe(FONT_DEFINITIONS.length);
		});
	});
});
