import * as fs from 'fs';
import * as path from 'path';

import type { Plugin } from 'obsidian';
import { describe, it, expect } from 'vitest';

import { formatMarkdown } from '../src/formatter';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Prettier Formatter', () => {
	const wasmPath = path.join(
		__dirname,
		'../../../crates/formatter-wasm/pkg/formatter_wasm_bg.wasm',
	);
	// Mock only exposes what formatMarkdown reads off the plugin.
	const mockPlugin = {
		manifest: { dir: path.dirname(wasmPath) },
		app: {
			vault: {
				adapter: {
					readBinary: async () => fs.readFileSync(wasmPath),
				},
			},
		},
	} as unknown as Plugin;

	it('initializes lazily and formats markdown consistently', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('preserves existing frontmatter without adding metadata', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'empty_tags_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'empty_tags_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it("uses dprint's PythonMarkdown list indentation", async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'wrap_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'wrap_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('preserves RTL text without injecting hard breaks', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'rtl_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'rtl_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('does not add frontmatter to notes without frontmatter', async () => {
		const formatted = await formatMarkdown('# Hello\nWorld', mockPlugin);

		expect(formatted).not.toMatch(/^---\n/);
	});

	it('formats list continuation lines with HTML tags correctly', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'html_wrap_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'html_wrap_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});

	it('preserves and formats flashcards syntax (inline, cloze, and block cards)', async () => {
		const beforeContent = fs.readFileSync(path.join(FIXTURES_DIR, 'flashcards_before.md'), 'utf-8');
		const formatted = await formatMarkdown(beforeContent, mockPlugin);
		const afterPath = path.join(FIXTURES_DIR, 'flashcards_after.md');
		const afterContent = fs.readFileSync(afterPath, 'utf-8');
		expect(formatted).toBe(afterContent);
	});
});
