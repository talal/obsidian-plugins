import * as fs from 'fs';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FONT_FAMILY, FONT_FILENAME, FontManager } from '../src/fonts';

describe('Fonts', () => {
	it('defines the OpenType Math font configuration', () => {
		expect(FONT_FAMILY).toBe('New Computer Modern Math');
		expect(FONT_FILENAME).toBe('NewCMMath-Book.woff2');
	});

	it('ensures the referenced font file exists on disk in the fonts directory', () => {
		const fontsDir = path.resolve(__dirname, '../fonts');
		const filePath = path.join(fontsDir, FONT_FILENAME);
		expect(fs.existsSync(filePath), `Missing font file: ${FONT_FILENAME}`).toBe(true);
		const stats = fs.statSync(filePath);
		expect(stats.size).toBeGreaterThan(0);
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

		it('loads the font and registers it with document.fonts', async () => {
			expect(fontManager.isLoaded()).toBe(false);
			await fontManager.load(mockPlugin);

			expect(fontManager.isLoaded()).toBe(true);
			expect(addedFaces.length).toBe(1);
			expect(addedFaces[0].family).toBe(FONT_FAMILY);

			// Unload removes the added font
			fontManager.unload();
			expect(fontManager.isLoaded()).toBe(false);
			expect(addedFaces.length).toBe(0);
		});

		it('handles multiple load calls idempotently', async () => {
			await fontManager.load(mockPlugin);
			expect(addedFaces.length).toBe(1);

			await fontManager.load(mockPlugin);
			expect(addedFaces.length).toBe(1);
		});
	});
});
