import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';

import { applyFormattedText, formatSelectedText } from './editor';
import { WasmFormatter } from './formatter';

export default class FormatterPlugin extends Plugin {
	private isFormatting = false;
	private formatter!: WasmFormatter;

	async onload() {
		this.formatter = new WasmFormatter(this);

		this.app.workspace.onLayoutReady(() => {
			void this.formatter.warmup();
		});

		this.addCommand({
			id: 'format-current-note',
			name: 'Format current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView || !activeView.file) return false;
				if (checking) return true;
				void this.formatActiveNote(activeView);
				return true;
			},
		});

		this.addCommand({
			id: 'format-selection',
			name: 'Format selection',
			editorCheckCallback: (checking: boolean, editor: Editor) => {
				if (!editor.somethingSelected()) return false;
				if (checking) return true;
				void this.formatSelection(editor);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => {
						item
							.setTitle('Format note')
							.setIcon('align-left')
							.onClick(() => void this.formatFile(file));
					});
				}
			}),
		);
	}

	onunload() {
		this.formatter.unload();
	}

	async formatActiveNote(activeView: MarkdownView) {
		if (this.isFormatting) return;
		this.isFormatting = true;

		try {
			if (activeView.getMode() === 'source') {
				const originalText = activeView.editor.getValue();
				if (!originalText.trim()) return;

				const formattedText = await this.formatter.format(originalText);
				applyFormattedText(activeView.editor, formattedText);
			} else if (activeView.file) {
				await this.formatFileDirectly(activeView.file);
			}
		} catch (error) {
			this.handleError(error);
		} finally {
			this.isFormatting = false;
		}
	}

	async formatSelection(editor: Editor) {
		if (this.isFormatting) return;
		this.isFormatting = true;

		try {
			await formatSelectedText(editor, (text) => this.formatter.format(text));
		} catch (error) {
			this.handleError(error);
		} finally {
			this.isFormatting = false;
		}
	}

	async formatFile(file: TFile) {
		if (this.isFormatting) return;
		this.isFormatting = true;

		try {
			await this.formatFileDirectly(file);
		} catch (error) {
			this.handleError(error);
		} finally {
			this.isFormatting = false;
		}
	}

	private async formatFileDirectly(file: TFile) {
		const original = await this.app.vault.read(file);
		if (!original.trim()) return;

		const formatted = await this.formatter.format(original);
		if (formatted !== original) {
			await this.app.vault.modify(file, formatted);
			new Notice('Formatted note.');
		} else {
			new Notice('Note is already formatted.');
		}
	}

	private handleError(error: unknown) {
		console.error('Formatter: formatting failed', error);
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Formatter failed: ${message}`);
	}
}
