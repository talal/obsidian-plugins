import type {
	Editor,
	EditorPosition,
	EditorRangeOrCaret,
	EditorSelection,
	EditorTransaction,
} from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import { offsetToPos } from '../src/diff';
import { applyFormattedText, formatSelectedText } from '../src/editor';

function createMockEditor(
	initialText: string,
	initialSelections: EditorSelection[] = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }],
) {
	let text = initialText;
	let selections = initialSelections;
	let scroll = { left: 10, top: 250 };
	let lastTransaction: { tx: EditorTransaction; origin?: string } | null = null;
	let replacedSelection: { text: string; origin?: string } | null = null;

	const posToOffset = (pos: EditorPosition): number => {
		const lines = text.split('\n');
		let offset = 0;
		for (let i = 0; i < pos.line && i < lines.length; i++) {
			offset += lines[i]!.length + 1;
		}
		return offset + Math.min(pos.ch, lines[pos.line]?.length ?? 0);
	};

	const scrollToSpy = vi.fn((left: number, top: number) => {
		scroll = { left, top };
	});

	const transactionSpy = vi.fn((tx: EditorTransaction, origin?: string) => {
		lastTransaction = { tx, origin };
		if (tx.changes) {
			const sortedChanges = [...tx.changes].sort((a, b) => {
				return posToOffset(b.from) - posToOffset(a.from);
			});
			for (const chg of sortedChanges) {
				const fromOff = posToOffset(chg.from);
				const toOff = chg.to ? posToOffset(chg.to) : fromOff;
				text = text.slice(0, fromOff) + chg.text + text.slice(toOff);
			}
		}
		if (tx.selections) {
			selections = tx.selections.map((s: EditorRangeOrCaret) => ({
				anchor: s.from,
				head: s.to ?? s.from,
			}));
		}
	});

	const replaceSelectionSpy = vi.fn((replacement: string, origin?: string) => {
		replacedSelection = { text: replacement, origin };
	});

	const editor: Editor = {
		getValue: () => text,
		listSelections: () => selections,
		posToOffset,
		offsetToPos: (offset: number) => offsetToPos(text, offset),
		getScrollInfo: () => scroll,
		scrollTo: scrollToSpy,
		transaction: transactionSpy,
		somethingSelected: () => {
			return selections.some((s) => s.anchor.line !== s.head.line || s.anchor.ch !== s.head.ch);
		},
		getSelection: () => {
			const sel = selections[0];
			if (!sel) return '';
			const fromOff = posToOffset(sel.anchor);
			const toOff = posToOffset(sel.head);
			const start = Math.min(fromOff, toOff);
			const end = Math.max(fromOff, toOff);
			return text.slice(start, end);
		},
		replaceSelection: replaceSelectionSpy,
	} as unknown as Editor;

	return {
		editor,
		transactionSpy,
		scrollToSpy,
		replaceSelectionSpy,
		getText: () => text,
		getSelections: () => selections,
		getLastTransaction: () => lastTransaction,
		getReplacedSelection: () => replacedSelection,
	};
}

describe('editor integration', () => {
	it('returns false and does not dispatch transaction when text is identical', () => {
		const text = '# Title\n\n- item\n';
		const { editor, transactionSpy } = createMockEditor(text);

		const changed = applyFormattedText(editor, text);
		expect(changed).toBe(false);
		expect(transactionSpy).not.toHaveBeenCalled();
	});

	it('applies diff transaction and preserves scroll position', () => {
		const original = '# Title\n\n-   bad indent\n';
		const formatted = '# Title\n\n- item\n';
		const { editor, getText, getLastTransaction, transactionSpy, scrollToSpy } =
			createMockEditor(original);

		const changed = applyFormattedText(editor, formatted);
		expect(changed).toBe(true);
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		expect(getLastTransaction()?.origin).toBe('+format');
		expect(scrollToSpy).toHaveBeenCalledWith(10, 250);
		expect(getText()).toBe(formatted);
	});

	it('maps cursor position accurately across edits', () => {
		const original = ['# Title', '', '-   bad indent', '', 'Target line with cursor'].join('\n');

		const formatted = ['# Title', '', '- bad indent', '', 'Target line with cursor'].join('\n');

		// Place cursor at 'with' on line 4
		const targetCh = 'Target line '.length;
		const { editor, getSelections } = createMockEditor(original, [
			{ anchor: { line: 4, ch: targetCh }, head: { line: 4, ch: targetCh } },
		]);

		applyFormattedText(editor, formatted);

		const mapped = getSelections()[0]!;
		expect(mapped.anchor.line).toBe(4);
		expect(mapped.anchor.ch).toBe(targetCh);
	});

	it('preserves multi-cursor across formatting', () => {
		const original = 'first line\nsecond line\nthird line\n';
		const formatted = 'FIRST line\nsecond line\nTHIRD line\n';

		const { editor, getSelections } = createMockEditor(original, [
			{ anchor: { line: 1, ch: 2 }, head: { line: 1, ch: 2 } },
			{ anchor: { line: 2, ch: 3 }, head: { line: 2, ch: 3 } },
		]);

		applyFormattedText(editor, formatted);

		const mapped = getSelections();
		expect(mapped.length).toBe(2);
		expect(mapped[0]?.anchor.line).toBe(1);
		expect(mapped[1]?.anchor.line).toBe(2);
	});

	it('preserves active text selection range across formatting', () => {
		const original = '# Title\n\n-   bad indent\n\nSelected text here\n';
		const formatted = '# Title\n\n- bad indent\n\nSelected text here\n';

		const { editor, getSelections } = createMockEditor(original, [
			{
				anchor: { line: 4, ch: 0 },
				head: { line: 4, ch: 'Selected'.length },
			},
		]);

		applyFormattedText(editor, formatted);

		const mapped = getSelections()[0]!;
		expect(mapped.anchor.line).toBe(4);
		expect(mapped.anchor.ch).toBe(0);
		expect(mapped.head.line).toBe(4);
		expect(mapped.head.ch).toBe('Selected'.length);
	});

	it('formatSelectedText returns false if nothing is selected', async () => {
		const { editor } = createMockEditor('Some text');
		const result = await formatSelectedText(editor, async (t) => t);
		expect(result).toBe(false);
	});

	it('formatSelectedText returns false if selection is only whitespace', async () => {
		const { editor } = createMockEditor('   ', [
			{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 3 } },
		]);
		const result = await formatSelectedText(editor, async (t) => t);
		expect(result).toBe(false);
	});

	it('formatSelectedText trims trailing newline for inline selections', async () => {
		const text = '-   item';
		const { editor, getReplacedSelection } = createMockEditor(text, [
			{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: text.length } },
		]);

		const result = await formatSelectedText(editor, async () => '- item\n');
		expect(result).toBe(true);
		expect(getReplacedSelection()?.text).toBe('- item');
	});
});
