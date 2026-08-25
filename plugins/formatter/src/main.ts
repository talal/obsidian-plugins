import { Editor, Notice, Plugin } from 'obsidian';

import { formatMarkdown } from './formatter';

interface CursorPosition {
	line: number;
	ch: number;
}

function getCursorOffset(text: string, { line, ch }: CursorPosition): number {
	const lines = text.split('\n');
	let offset = 0;
	for (let i = 0; i < line && i < lines.length; i++) {
		offset += (lines[i]?.length ?? 0) + 1;
	}
	return offset + Math.min(ch, lines[line]?.length ?? 0);
}

function offsetToCursor(text: string, offset: number): CursorPosition {
	let line = 0;
	let lineStart = 0;
	while (true) {
		const newline = text.indexOf('\n', lineStart);
		if (newline === -1 || newline >= offset) break;
		line++;
		lineStart = newline + 1;
	}
	return { line, ch: offset - lineStart };
}

export default class RustFormatterPlugin extends Plugin {
	isFormatting = false;

	async onload() {
		this.addCommand({
			id: 'format-current-note',
			name: 'Format current note',
			editorCallback: (editor: Editor) => this.formatActiveNote(editor),
		});
	}

	async formatActiveNote(editor: Editor) {
		if (this.isFormatting) return;
		this.isFormatting = true;

		try {
			const originalText = editor.getValue();
			if (!originalText.trim()) return;

			const scrollInfo = editor.getScrollInfo();
			const cursorOffset = getCursorOffset(originalText, editor.getCursor());

			// WASM initialization is deferred to the first invocation.
			const formattedText = await formatMarkdown(originalText, this);
			if (formattedText === originalText) return;

			const lastLine = editor.lastLine();
			editor.replaceRange(
				formattedText,
				{ line: 0, ch: 0 },
				{ line: lastLine, ch: editor.getLine(lastLine).length },
			);

			editor.setCursor(offsetToCursor(formattedText, cursorOffset));
			editor.scrollTo(scrollInfo.left, scrollInfo.top);
		} catch (error) {
			console.error('Rust Formatter: formatting failed', error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Rust Formatter failed: ${message}`);
		} finally {
			this.isFormatting = false;
		}
	}
}
