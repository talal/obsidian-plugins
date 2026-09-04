import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect, beforeAll } from 'vitest';

import { TypstCompiler } from '../src/compiler';

// Helper to extract math from markdown
// Returns an array of { source: string, display: boolean }
function extractMath(markdown: string) {
	const results: { source: string; display: boolean }[] = [];

	// Match block math $$ ... $$
	const blockRegex = /\$\$([\s\S]*?)\$\$/g;
	let match;
	while ((match = blockRegex.exec(markdown)) !== null) {
		const source = match[1];
		if (source) {
			results.push({ source: source.trim(), display: true });
		}
	}

	// Match inline math $ ... $
	// Use negative lookbehind and lookahead to avoid matching $$
	const inlineRegex = /(?<!\$)\$(?!\$)(.*?)(?<!\$)\$(?!\$)/g;
	while ((match = inlineRegex.exec(markdown)) !== null) {
		const source = match[1];
		if (source) {
			results.push({ source: source.trim(), display: false });
		}
	}

	return results;
}

describe('TypstCompiler', () => {
	let compiler: TypstCompiler;
	let mockPlugin: any;
	let wasmReads = 0;

	beforeAll(() => {
		compiler = new TypstCompiler();

		mockPlugin = {
			manifest: {
				dir: '../../crates/typst-math-wasm/pkg',
			},
			app: {
				vault: {
					adapter: {
						readBinary: async (filePath: string) => {
							wasmReads++;
							// Resolve relative to the package root
							const absolutePath = path.resolve(__dirname, '..', filePath);
							const buffer = await fs.promises.readFile(absolutePath);
							// Convert Node Buffer to Uint8Array as expected by readBinary
							return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
						},
					},
				},
			},
		};
	});

	it('loads WASM lazily on the first compilation', async () => {
		const lazyCompiler = new TypstCompiler();
		expect(lazyCompiler.isReady()).toBe(false);
		expect(wasmReads).toBe(0);

		const result = await lazyCompiler.compile('x', false, mockPlugin);

		expect(result).toContain('<math');
		expect(lazyCompiler.stylesheet).toContain('mtable');
		expect(lazyCompiler.isReady()).toBe(true);
		expect(lazyCompiler.compileSync('x', false)).toBe(result);
		expect(wasmReads).toBe(1);
	});

	it('ensures styles.css contains Typst MathML reset rules', async () => {
		const stylesPath = path.resolve(__dirname, '../styles.css');
		const stylesCss = await fs.promises.readFile(stylesPath, 'utf-8');

		const lazyCompiler = new TypstCompiler();
		await lazyCompiler.init(mockPlugin);
		const typstCss = lazyCompiler.stylesheet;

		expect(typstCss).toBeTruthy();
		expect(stylesCss).toContain('typst-math mtable.multiline-equation');
		expect(stylesCss).toContain('math-style: inherit');
		expect(stylesCss).toContain("font-feature-settings: 'dtls'");
	});

	it('caches synchronous compilation results and differentiates inline from display', async () => {
		const c = new TypstCompiler();
		await c.init(mockPlugin);

		const inline1 = c.compileSync('alpha + beta', false);
		const inline2 = c.compileSync('alpha + beta', false);
		expect(inline1).toBe(inline2);
		expect(inline1).not.toContain('display="block"');

		const display = c.compileSync('alpha + beta', true);
		expect(display).toContain('display="block"');
		expect(display).not.toBe(inline1);
	});

	it('throws an error synchronously for malformed expressions', async () => {
		const c = new TypstCompiler();
		await c.init(mockPlugin);

		expect(() => c.compileSync('$', false)).toThrow();
	});

	it('resets initPromise on failure so initialization can be retried', async () => {
		const failingCompiler = new TypstCompiler();
		const failingPlugin = {
			manifest: { dir: 'invalid-dir' },
			app: {
				vault: {
					adapter: {
						readBinary: async () => {
							throw new Error('File not found');
						},
					},
				},
			},
		};

		await expect(failingCompiler.init(failingPlugin as any)).rejects.toThrow('File not found');
		expect(failingCompiler.isReady()).toBe(false);

		// Retry with working plugin succeeds
		await failingCompiler.init(mockPlugin);
		expect(failingCompiler.isReady()).toBe(true);
	});

	const VALID_FIXTURES = ['valid-inline.md', 'valid-block-matrices.md', 'valid-block-cases.md'];

	const INVALID_FIXTURES = ['invalid-functions.md', 'invalid-syntax.md'];

	for (const fixture of VALID_FIXTURES) {
		it(`should successfully compile math expressions in ${fixture}`, async () => {
			const mdPath = path.resolve(__dirname, `fixtures/${fixture}`);
			const markdown = await fs.promises.readFile(mdPath, 'utf-8');
			const equations = extractMath(markdown);

			expect(equations.length).toBeGreaterThan(0);

			for (const eq of equations) {
				const result = await compiler.compile(eq.source, eq.display, mockPlugin);
				// MathML should contain a <math> tag
				expect(result).toContain('<math');
				expect(result).toContain('</math>');
				expect(compiler.compileSync(eq.source, eq.display)).toBe(result);
			}
		});
	}

	for (const fixture of INVALID_FIXTURES) {
		it(`should throw errors for incorrect math expressions in ${fixture}`, async () => {
			const mdPath = path.resolve(__dirname, `fixtures/${fixture}`);
			const markdown = await fs.promises.readFile(mdPath, 'utf-8');
			const equations = extractMath(markdown);

			expect(equations.length).toBeGreaterThan(0);

			for (const eq of equations) {
				await expect(compiler.compile(eq.source, eq.display, mockPlugin)).rejects.toThrow();
			}
		});
	}
});
