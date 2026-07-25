/**
 * Plugin entry point for Obsidian → Anki Sync.
 * Registers command(s), status bar, and settings tab.
 * Per architecture §5 component breakdown.
 */

import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';

import { DEFAULT_SETTINGS, type PluginSettings } from './config';
import { AnkiSyncSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { SyncCache } from './sync/cache';
import type { SyncResult } from './types';
import { Logger } from './logger';
import { TypstCompiler } from './typstCompiler';

import { ankiIdPlugin } from './editorExtension';
import { initAnkiSyncWasm } from './wasm';

export default class AnkiSyncPlugin extends Plugin {
	settings!: PluginSettings;
	private cache!: SyncCache;
	logger!: Logger;
	typstCompiler!: TypstCompiler;
	private isSyncing = false;

	async onload() {
		this.logger = new Logger(this.app, this, 'Anki Sync');
		await this.loadSettings();

		this.cache = new SyncCache(this);
		this.app.workspace.onLayoutReady(() => {
			this.cache.load().catch((e) => this.logger.logError('Failed to load sync cache', e));
		});

		await initAnkiSyncWasm(this);

		this.typstCompiler = new TypstCompiler();
		if (this.settings.useTypstMath) {
			this.typstCompiler
				.init(this)
				.catch((e) => console.error('Anki Sync: Failed to eager load Typst WASM', e));
		}

		this.registerEditorExtension(ankiIdPlugin);

		// Status bar item (desktop only)
		const statusBarEl = this.addStatusBarItem();
		statusBarEl.empty();

		// Command: Sync current file
		this.addCommand({
			id: 'sync-current-file',
			name: 'Sync current file',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) {
					this.syncCurrentFile(view.file, statusBarEl);
				}
				return true;
			},
		});

		// Command: Force Sync current file
		this.addCommand({
			id: 'force-sync-current-file',
			name: 'Force sync current file (ignore cache)',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) {
					this.syncCurrentFile(view.file, statusBarEl, true);
				}
				return true;
			},
		});

		// Command: Sync all files in vault
		this.addCommand({
			id: 'sync-all-files',
			name: 'Sync all files',
			callback: () => {
				this.syncAllFiles(statusBarEl);
			},
		});

		// Command: Add block note template
		this.addCommand({
			id: 'insert-note-template',
			name: 'Insert card block',
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const template = '%% card start %%\n\n%% card end %%';
				editor.replaceRange(template, cursor);
				editor.setCursor({
					line: cursor.line + 1,
					ch: 0,
				});
			},
		});

		// Settings tab
		this.addSettingTab(new AnkiSyncSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<PluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Sync the currently active file.
	 */
	private async syncCurrentFile(
		file: TFile,
		statusBarEl: HTMLElement,
		force = false,
	): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter?.['anki-deck']) {
			new Notice(`Anki Sync: Missing 'anki-deck' frontmatter in ${file.basename}`);
			return;
		}

		statusBarEl.setText('Anki: syncing...');

		const engine = new SyncEngine(this.app, this.settings, this.cache);

		if (!this.settings.apiKey) {
			new Notice(
				'Anki Sync: API Key is not configured. Please set it in the plugin settings.',
				8000,
			);
			statusBarEl.empty();
			return;
		}

		// Pre-flight: test Anki addon connectivity
		const connectionStatus = await engine.testConnection();
		if (connectionStatus !== 'ok') {
			let msg = '';
			if (connectionStatus === 'unauthorized') {
				msg = 'Anki Sync: Unauthorized. Please check your API key in settings.';
			} else if (connectionStatus === 'profile-not-loaded') {
				msg = 'Anki Sync: Anki profile is not loaded. Please open Anki.';
			} else {
				msg =
					'Anki Sync: Cannot connect to Anki addon. Is Anki running with the sync addon installed?';
			}
			new Notice(msg, 8000);
			statusBarEl.empty();
			return;
		}

		try {
			const result = await engine.syncFile(file, force);
			this.showResult(result, file.basename);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Anki Sync error: ${msg}`, 8000);
			this.logger.logError('Anki Sync error', e);
		}

		statusBarEl.empty();
	}

	/**
	 * Sync all markdown files in the vault that have anki-deck frontmatter.
	 * Per architecture §6: vault-wide variant.
	 */
	private async syncAllFiles(statusBarEl: HTMLElement): Promise<void> {
		if (this.isSyncing) {
			new Notice('Sync already in progress');
			return;
		}
		this.isSyncing = true;
		try {
			statusBarEl.setText('Anki: syncing all...');

			const engine = new SyncEngine(this.app, this.settings, this.cache);

			if (!this.settings.apiKey) {
				new Notice(
					'Anki Sync: API Key is not configured. Please set it in the plugin settings.',
					8000,
				);
				statusBarEl.empty();
				return;
			}

			// Pre-flight
			const connectionStatus = await engine.testConnection();
			if (connectionStatus !== 'ok') {
				let msg = '';
				if (connectionStatus === 'unauthorized') {
					msg = 'Anki Sync: Unauthorized. Please check your API key in settings.';
				} else if (connectionStatus === 'profile-not-loaded') {
					msg = 'Anki Sync: Anki profile is not loaded. Please open Anki.';
				} else {
					msg =
						'Anki Sync: Cannot connect to Anki addon. Is Anki running with the sync addon installed?';
				}
				new Notice(msg, 8000);
				statusBarEl.empty();
				return;
			}

			const files = this.app.vault.getMarkdownFiles();
			const totals: SyncResult = {
				created: 0,
				updated: 0,
				skipped: 0,
				orphaned: 0,
				errors: [],
			};

			let processedCount = 0;
			for (const file of files) {
				// Skip files without anki-deck frontmatter
				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache?.frontmatter?.['anki-deck']) {
					continue;
				}

				// Skip files not modified since last sync (cache optimization)
				if (!this.cache.isStale(file.path, file.stat.mtime)) {
					const cachedEntry = this.cache.getFile(file.path);
					if (cachedEntry) {
						totals.skipped += cachedEntry.cardIds.length;
						if (cachedEntry.cardIds.length > 0) {
							processedCount++;
						}
					}
					continue;
				}

				statusBarEl.setText(`Anki: syncing ${++processedCount}...`);

				try {
					const result = await engine.syncFile(file, false, true);
					totals.created += result.created;
					totals.updated += result.updated;
					totals.skipped += result.skipped;
					totals.orphaned += result.orphaned;
					totals.errors.push(...result.errors);
				} catch (e) {
					const msg = `${file.path}: ${e instanceof Error ? e.message : String(e)}`;
					totals.errors.push(msg);
					this.logger.logError(`Anki Sync error in ${file.path}`, e);
				}
			}

			// Cleanup cache: remove entries for files that no longer exist, and tag their notes as orphan
			const validPaths = new Set(files.map((f) => f.path));
			for (const cachedPath of this.cache.getAllPaths()) {
				if (!validPaths.has(cachedPath)) {
					const entry = this.cache.getFile(cachedPath);
					if (entry && entry.cardIds.length > 0) {
						try {
							await engine.client.markOrphaned(entry.cardIds);
							totals.orphaned += entry.cardIds.length;
							console.info(
								`Anki Sync: File ${cachedPath} deleted. Tagged ${entry.cardIds.length} note(s) as 'orphan' in Anki.`,
							);
						} catch (e) {
							this.logger.logError(
								`Failed to tag orphaned notes from deleted file ${cachedPath}`,
								e,
							);
						}
					}
					this.cache.remove(cachedPath);
				}
			}
			await this.cache.save();

			this.showResult(totals, `${processedCount} files`);
			statusBarEl.empty();
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Display sync results via Notice and console.
	 * Per architecture §6 step 7.
	 */
	private showResult(result: SyncResult, context: string): void {
		const parts: string[] = [];
		if (result.created > 0) parts.push(`${result.created} created`);
		if (result.updated > 0) parts.push(`${result.updated} updated`);
		if (result.skipped > 0) parts.push(`${result.skipped} unchanged`);
		if (result.orphaned > 0) parts.push(`${result.orphaned} orphaned`);
		if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);

		if (parts.length === 0) {
			new Notice(`Anki Sync (${context}): no notes found`);
		} else {
			const msg = `Anki Sync (${context}): ${parts.join(', ')}`;
			new Notice(msg, 5000);
			console.log(msg);
		}

		if (result.errors.length > 0) {
			console.warn('Anki Sync errors:', result.errors);
			result.errors.forEach((err) => this.logger.logError(err));
		}
	}
}
