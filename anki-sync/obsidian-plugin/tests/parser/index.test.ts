import { describe, it, expect, beforeAll } from 'vitest';
import { scanFile } from '../../src/parser/index';
import { initAnkiSyncWasm } from '../../src/wasm';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const DEFAULT_DECK = 'Obsidian';

describe('scanFile with real .md fixtures', () => {
	beforeAll(async () => {
		await initAnkiSyncWasm();
	});
	it('parses inline-notes.md accurately', () => {
		const content = fs.readFileSync(path.join(FIXTURES_DIR, 'inline-notes.md'), 'utf8');
		const result = scanFile(content, 'inline-notes.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(7);
		expect(result.ankiPayload[0]!.fields.Front).toContain('This is a regular card');
		expect(result.ankiPayload[5]!.fields.Front).toContain('inline code');
		expect(result.ankiPayload[6]!.fields.Front).toContain('math = mc^2');
	});

	it('parses block-notes.md accurately', () => {
		const content = fs.readFileSync(path.join(FIXTURES_DIR, 'block-notes.md'), 'utf8');
		const result = scanFile(content, 'block-notes.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(3);
		expect(result.ankiPayload[0]!.fields.Front).toContain('Front block');
		expect(result.ankiPayload[0]!.fields.Back).toContain('Back block');
		expect(result.ankiPayload[1]!.deckName).toBe('Math::Algebra');
		expect(result.ankiPayload[2]!.deckName).toBe('Math::Calculus');
	});

	it('parses ignored-zones.md accurately', () => {
		const content = fs.readFileSync(path.join(FIXTURES_DIR, 'ignored-zones.md'), 'utf8');
		const result = scanFile(content, 'ignored-zones.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(1);
		expect(result.ankiPayload[0]!.fields.Front).toContain('Indented card');
	});

	it('parses real-world-cs-notes.md accurately', () => {
		const content = fs.readFileSync(path.join(FIXTURES_DIR, 'real-world-cs-notes.md'), 'utf8');
		const result = scanFile(content, 'real-world-cs-notes.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(6);
	});

	it('parses malformed-edge-cases.md accurately', () => {
		const content = fs.readFileSync(path.join(FIXTURES_DIR, 'malformed-edge-cases.md'), 'utf8');
		const result = scanFile(content, 'malformed-edge-cases.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(1);
		expect(result.ankiPayload[0]!.fields.Front).toContain('Q1');
	});

	it('supports alternative block card separators', () => {
		const content = `
%% card start %%
Front using colons
:::
Back using colons
%% card end id=abc %%

%% card start %%
Front using hidden dashes
%% --- %%
Back using hidden dashes
%% card end id=def %%

%% card start %%
Front using hidden back
%% back %%
Back using hidden back
%% card end id=ghi %%

%% card start %%
Front using asterisks
***
Back using asterisks
%% card end id=jkl %%

%% card start %%
Front using dots

. . .

Back using dots
%% card end id=mno %%
		`;
		const result = scanFile(content, 'test.md', DEFAULT_DECK, '{}');

		expect(result.ankiPayload).toHaveLength(5);
		expect(result.ankiPayload[0]!.fields.Front).toContain('Front using colons');
		expect(result.ankiPayload[1]!.fields.Front).toContain('Front using hidden dashes');
		expect(result.ankiPayload[2]!.fields.Front).toContain('Front using hidden back');
		expect(result.ankiPayload[3]!.fields.Front).toContain('Front using asterisks');
		expect(result.ankiPayload[4]!.fields.Front).toContain('Front using dots');
		expect(result.ankiPayload[4]!.fields.Back).toContain('Back using dots');
	});
});
