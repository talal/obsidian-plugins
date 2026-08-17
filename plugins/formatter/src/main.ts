import { Editor, MarkdownView, MarkdownFileInfo, Plugin, Notice, TFile } from 'obsidian';

import { formatMarkdown, initFormatterWasm } from './formatter';

import { DEFAULT_SETTINGS, RustFormatterSettings, RustFormatterSettingTab } from './settings';

import { Logger } from './logger';

export default class RustFormatterPlugin extends Plugin {
	settings!: RustFormatterSettings;
	logger!: Logger;
	originalSaveEditorCallback: any = null;
	originalSaveEditorCheckCallback: any = null;
	originalSaveCheckCallback: any = null;
	originalSaveCallback: any = null;
	isFormatting = false;
	lastFormatTime = 0;

	async onload() {
		this.logger = new Logger(this.app, this, 'Rust Formatter');
		await this.loadSettings();

		await initFormatterWasm(this);

		this.addCommand({
			id: 'format-current-note',
			name: 'Format current note',
			editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const activeFile = ctx.file;
				await this.formatActiveNote(editor, activeFile);
			},
		});

		this.addSettingTab(new RustFormatterSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.setupSaveHook();
		});
	}

	onunload() {
		this.unhookSaveCommand();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<RustFormatterSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.setupSaveHook();
	}

	setupSaveHook() {
		this.unhookSaveCommand();
		if (this.settings.formatOnSave) {
			this.hookSaveCommand();
		}
	}

	hookSaveCommand() {
		// Note (M9): This monkey-patches the internal undocumented 'editor:save-file' command.
		// It is inherently fragile against Obsidian updates and may conflict with other plugins.
		const commandsObj = (this.app as any).commands;
		if (!commandsObj) {
			void this.logger.logError('app.commands object not found');
			return;
		}

		const saveCommand = commandsObj.commands?.['editor:save-file'];
		if (!saveCommand) {
			return;
		}

		if (saveCommand.editorCallback) {
			const original = saveCommand.editorCallback;
			this.originalSaveEditorCallback = original;
			saveCommand.editorCallback = async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				await this.formatActiveNote(editor, ctx.file);
				original.call(saveCommand, editor, ctx);
			};
		} else if (saveCommand.editorCheckCallback) {
			const original = saveCommand.editorCheckCallback;
			this.originalSaveEditorCheckCallback = original;
			saveCommand.editorCheckCallback = (
				checking: boolean,
				editor: Editor,
				ctx: MarkdownView | MarkdownFileInfo,
			) => {
				if (checking) {
					return original.call(saveCommand, true, editor, ctx);
				}
				void (async () => {
					await this.formatActiveNote(editor, ctx.file);
					original.call(saveCommand, false, editor, ctx);
				})();
				return true;
			};
		} else if (saveCommand.checkCallback) {
			const original = saveCommand.checkCallback;
			this.originalSaveCheckCallback = original;
			saveCommand.checkCallback = (checking: boolean) => {
				if (checking) {
					return original.call(saveCommand, true);
				}
				void (async () => {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView && activeView.editor) {
						await this.formatActiveNote(activeView.editor, activeView.file);
					}
					original.call(saveCommand, false);
				})();
				return true;
			};
		} else if (saveCommand.callback) {
			const original = saveCommand.callback;
			this.originalSaveCallback = original;
			saveCommand.callback = async () => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.editor) {
					await this.formatActiveNote(activeView.editor, activeView.file);
				}
				original.call(saveCommand);
			};
		}
	}

	unhookSaveCommand() {
		const commandsObj = (this.app as any).commands;
		if (!commandsObj) return;

		const saveCommand = commandsObj.commands?.['editor:save-file'];
		if (!saveCommand) return;

		if (this.originalSaveEditorCallback) {
			saveCommand.editorCallback = this.originalSaveEditorCallback;
			this.originalSaveEditorCallback = null;
		}
		if (this.originalSaveEditorCheckCallback) {
			saveCommand.editorCheckCallback = this.originalSaveEditorCheckCallback;
			this.originalSaveEditorCheckCallback = null;
		}
		if (this.originalSaveCheckCallback) {
			saveCommand.checkCallback = this.originalSaveCheckCallback;
			this.originalSaveCheckCallback = null;
		}
		if (this.originalSaveCallback) {
			saveCommand.callback = this.originalSaveCallback;
			this.originalSaveCallback = null;
		}
	}

	async formatActiveNote(editor: Editor, _activeFile: TFile | null) {
		// Note (M12): isFormatting is instance-level, so concurrent saves across split panes will skip.
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

			const ctime = _activeFile ? _activeFile.stat.ctime : undefined;

			const formattedText = await this.runFormatter(originalText, ctime);
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

	async runFormatter(text: string, ctime?: number): Promise<string> {
		return await formatMarkdown(text, ctime);
	}
}
