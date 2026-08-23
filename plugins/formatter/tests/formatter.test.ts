import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { formatMarkdown, initFormatterWasm } from '../src/formatter';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Prettier Formatter', () => {
	beforeAll(async () => {
		const wasmPath = path.join(
			__dirname,
			'../../../crates/formatter-wasm/pkg/formatter_wasm_bg.wasm',
		);
		const buffer = fs.readFileSync(wasmPath);
		const mockPlugin = {
			manifest: { dir: path.dirname(wasmPath) },
			app: {
				vault: {
					adapter: {
						readBinary: async () => buffer,
					},
				},
			},
		};
		await initFormatterWasm(mockPlugin);
	});

	it('formats markdown consistently and matches the after.md fixture', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent);
		const afterPath = path.join(FIXTURES_DIR, 'after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('removes tags key if it is empty/null', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'empty_tags_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent);
		const afterPath = path.join(FIXTURES_DIR, 'empty_tags_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('formats list continuation lines with 2 spaces instead of 4', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'wrap_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent);
		const afterPath = path.join(FIXTURES_DIR, 'wrap_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('preserves RTL text without injecting hard breaks', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'rtl_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent);
		const afterPath = path.join(FIXTURES_DIR, 'rtl_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('does not add frontmatter to notes without frontmatter', async () => {
		const formatted = await formatMarkdown('# Hello\nWorld');

		expect(formatted).not.toMatch(/^---\n/);
	});

	it('formats list continuation lines with HTML tags correctly', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'html_wrap_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent);
		const afterPath = path.join(FIXTURES_DIR, 'html_wrap_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});
});
