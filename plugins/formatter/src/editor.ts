import type { Editor, EditorChange, EditorRangeOrCaret } from 'obsidian';

import { computeDiffHunks, mapOffset, offsetToPos } from './diff';

export function applyFormattedText(editor: Editor, formattedText: string): boolean {
	const originalText = editor.getValue();
	if (originalText === formattedText) return false;

	const hunks = computeDiffHunks(originalText, formattedText);
	if (hunks.length === 0) return false;

	const scrollInfo = editor.getScrollInfo();
	const selections = editor.listSelections();

	const mappedSelections: EditorRangeOrCaret[] = selections.map((sel) => {
		const anchorOffset = editor.posToOffset(sel.anchor);
		const headOffset = editor.posToOffset(sel.head);
		const newAnchorOffset = mapOffset(anchorOffset, hunks);
		const newHeadOffset = mapOffset(headOffset, hunks);

		const anchorPos = offsetToPos(formattedText, newAnchorOffset);
		const headPos = offsetToPos(formattedText, newHeadOffset);

		if (newAnchorOffset === newHeadOffset) {
			return { from: anchorPos };
		}
		if (newAnchorOffset < newHeadOffset) {
			return { from: anchorPos, to: headPos };
		}
		return { from: headPos, to: anchorPos };
	});

	const changes: EditorChange[] = hunks.map((hunk) => ({
		from: editor.offsetToPos(hunk.fromOffset),
		to: editor.offsetToPos(hunk.toOffset),
		text: hunk.text,
	}));

	editor.transaction(
		{
			changes,
			selections: mappedSelections,
		},
		'+format',
	);

	editor.scrollTo(scrollInfo.left, scrollInfo.top);
	return true;
}

export async function formatSelectedText(
	editor: Editor,
	formatFn: (text: string) => Promise<string>,
): Promise<boolean> {
	if (!editor.somethingSelected()) return false;

	const selectedText = editor.getSelection();
	if (!selectedText.trim()) return false;

	let formatted = await formatFn(selectedText);
	// If selection did not end with newline, don't inject a trailing newline
	if (!selectedText.endsWith('\n') && formatted.endsWith('\n')) {
		formatted = formatted.slice(0, -1);
	}

	if (formatted === selectedText) return false;

	editor.replaceSelection(formatted, 'around');
	return true;
}
