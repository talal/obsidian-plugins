import { Editor, Plugin, Notice } from 'obsidian';

import { formatMarkdown, initFormatterWasm } from './formatter';

import { Logger } from './logger';

export default class RustFormatterPlugin extends Plugin {
	logger!: Logger;
	isFormatting = false;
	lastFormatTime = 0;

	async onload() {
		this.logger = new Logger(this.app, this, 'Rust Formatter');

		await initFormatterWasm(this);

		this.addCommand({
			id: 'format-current-note',
			name: 'Format current note',
			editorCallback: async (editor: Editor) => {
				await this.formatActiveNote(editor);
			},
		});
	}

	async formatActiveNote(editor: Editor) {
		// isFormatting is instance-level, so concurrent commands across split panes will skip.
		if (this.isFormatting) return;

		const now = Date.now();
		if (now - this.lastFormatTime < 500) {
			return;
		}
		this.lastFormatTime = now;
		this.isFormatting = true;

		try {
			const originalText = editor.getValue();
			if (!originalText.trim()) {
				return;
			}

			const cursor = editor.getCursor();
			const scrollInfo = editor.getScrollInfo();

			const formattedText = await this.runFormatter(originalText);
			if (formattedText === originalText) {
				return;
			}

			const originalLines = originalText.split('\n').length;
			const formattedLines = formattedText.split('\n').length;
			const lineDiff = formattedLines - originalLines;

			const lastLine = editor.lastLine();
			const lastLineLength = editor.getLine(lastLine).length;
			editor.replaceRange(
				formattedText,
				{ line: 0, ch: 0 },
				{ line: lastLine, ch: lastLineLength },
			);

			if (lineDiff !== 0 && cursor.line > 0) {
				cursor.line += lineDiff;
			}
			editor.setCursor(cursor);
			editor.scrollTo(scrollInfo.left, scrollInfo.top);
		} catch (error: any) {
			void this.logger.logError('Rust formatting failed', error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Rust Formatter failed: ${message}`);
		} finally {
			this.isFormatting = false;
		}
	}

	async runFormatter(text: string): Promise<string> {
		return await formatMarkdown(text);
	}
}
