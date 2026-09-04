import { describe, expect, it } from 'vitest';

import { applyHunksToString, computeDiffHunks, mapOffset, offsetToPos } from '../src/diff';

describe('diff engine', () => {
	it('returns empty hunks when texts are identical', () => {
		const text = '# Heading\n\nSome text.\n';
		const hunks = computeDiffHunks(text, text);
		expect(hunks).toEqual([]);
		expect(applyHunksToString(text, hunks)).toBe(text);
	});

	it('computes diff when lines are modified in the middle', () => {
		const original = 'line 1\nline 2\nline 3\nline 4\n';
		const formatted = 'line 1\nline TWO\nline 3\nline 4\n';

		const hunks = computeDiffHunks(original, formatted);
		expect(hunks.length).toBeGreaterThan(0);
		expect(applyHunksToString(original, hunks)).toBe(formatted);
	});

	it('preserves multiple disjoint hunks across a document', () => {
		const original = [
			'# Title',
			'',
			'-   bad indent 1',
			'',
			'Paragraph 1',
			'Paragraph 2',
			'Paragraph 3',
			'',
			'-   bad indent 2',
			'',
			'End of document',
		].join('\n');

		const formatted = [
			'# Title',
			'',
			'- bad indent 1',
			'',
			'Paragraph 1',
			'Paragraph 2',
			'Paragraph 3',
			'',
			'- bad indent 2',
			'',
			'End of document',
		].join('\n');

		const hunks = computeDiffHunks(original, formatted);
		expect(applyHunksToString(original, hunks)).toBe(formatted);
		// Should identify separate hunks rather than replacing the whole document
		expect(hunks.length).toBe(2);
	});

	it('handles pure deletion', () => {
		const original = 'line 1\nline 2\nline 3\n';
		const formatted = 'line 1\nline 3\n';

		const hunks = computeDiffHunks(original, formatted);
		expect(applyHunksToString(original, hunks)).toBe(formatted);
	});

	it('handles pure insertion', () => {
		const original = 'line 1\nline 3\n';
		const formatted = 'line 1\nline 2\nline 3\n';

		const hunks = computeDiffHunks(original, formatted);
		expect(applyHunksToString(original, hunks)).toBe(formatted);
	});

	it('maps cursor offset accurately before, after, and inside edits', () => {
		const original = 'aaa\nbbb\nccc\n';
		const formatted = 'aaa\nBBBBBB\nccc\n';
		const hunks = computeDiffHunks(original, formatted);

		// Cursor at 'aaa' (before edit)
		expect(mapOffset(2, hunks)).toBe(2);

		// Cursor at 'ccc' (after edit, length increased by 3)
		const cccPosOriginal = original.indexOf('ccc');
		const cccPosFormatted = formatted.indexOf('ccc');
		expect(mapOffset(cccPosOriginal, hunks)).toBe(cccPosFormatted);

		// Cursor inside 'bbb'
		const bbbPosOriginal = original.indexOf('bbb') + 1;
		const mappedInside = mapOffset(bbbPosOriginal, hunks);
		expect(mappedInside).toBeGreaterThanOrEqual(formatted.indexOf('BBBBBB'));
		expect(mappedInside).toBeLessThanOrEqual(formatted.indexOf('BBBBBB') + 6);
	});

	it('calculates offsetToPos correctly', () => {
		const text = 'line 1\nline 2\nline 3';
		expect(offsetToPos(text, 0)).toEqual({ line: 0, ch: 0 });
		expect(offsetToPos(text, 6)).toEqual({ line: 0, ch: 6 });
		expect(offsetToPos(text, 7)).toEqual({ line: 1, ch: 0 });
		expect(offsetToPos(text, 10)).toEqual({ line: 1, ch: 3 });
		expect(offsetToPos(text, 100)).toEqual({ line: 2, ch: 6 });
	});
});

it('handles edits at the very beginning of document', () => {
	const original = '# Old Title\n\nContent here.\n';
	const formatted = '# New Title\n\nContent here.\n';
	const hunks = computeDiffHunks(original, formatted);
	expect(applyHunksToString(original, hunks)).toBe(formatted);
});

it('handles edits at the very end of document', () => {
	const original = '# Title\n\n-   item 1\n';
	const formatted = '# Title\n\n- item 1\n';
	const hunks = computeDiffHunks(original, formatted);
	expect(applyHunksToString(original, hunks)).toBe(formatted);
});

it('handles document without trailing newline formatted to with newline', () => {
	const original = '# Title\n\nSome text';
	const formatted = '# Title\n\nSome text\n';
	const hunks = computeDiffHunks(original, formatted);
	expect(applyHunksToString(original, hunks)).toBe(formatted);
});
