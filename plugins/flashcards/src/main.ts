import { type Editor, MarkdownView, Notice, Plugin } from 'obsidian';
import { DatabaseManager } from './db/DatabaseManager.js';
import { NoteScanner } from './scanner/NoteScanner.js';
import { FlashcardsSettingTab } from './settings.js';
import type { FlashcardsPluginSettings, FsrsParams, ReviewLogEntry } from './types.js';
import { DashboardView, FLASHCARDS_DASHBOARD_VIEW_TYPE } from './ui/DashboardView.js';
import { ReviewModal } from './ui/ReviewModal.js';
import { TagPickerModal } from './ui/TagPickerModal.js';
import { DEFAULT_RELEARNING_STEPS, parseStudySteps } from './utils/studySteps.js';
import { WasmBridge } from './wasm.js';

export default class FlashcardsPlugin extends Plugin {
	public db!: DatabaseManager;
	public scanner!: NoteScanner;
	public settings!: FlashcardsPluginSettings;

	async onload() {
		await this.loadSettings();

		// 1. Initialize Rust WASM + SQLite WASM
		try {
			await WasmBridge.initialize(this.app, this.manifest);
		} catch (err) {
			console.error('Failed to initialize Flashcards WASM modules:', err);
			new Notice('❌ Failed to initialize Flashcards WASM modules.');
			return;
		}

		try {
			this.db = new DatabaseManager(this.app, this.manifest);
			await this.db.init();
			this.scanner = new NoteScanner(this.app, this.db);
		} catch (err) {
			console.error('Failed to initialize Flashcards SQLite database:', err);
			new Notice('❌ Failed to initialize Flashcards SQLite database.');
			return;
		}

		// 2. Register Dashboard View & Settings Tab
		this.registerView(FLASHCARDS_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.addSettingTab(new FlashcardsSettingTab(this.app, this));

		// 3. Register Commands

		// Command 1: Study all cards
		this.addCommand({
			id: 'study-all-cards',
			name: 'Study all cards',
			callback: () => {
				const rollover = this.settings.rolloverHour ?? 4;
				const dueCards = this.db.getDueReviewItems(undefined, rollover);
				const queue = dueCards.length > 0 ? dueCards : this.db.getAllCards();

				if (queue.length === 0) {
					new Notice('🎉 No flashcards found in your vault. Run "Scan entire vault" first!');
					return;
				}

				new ReviewModal(this.app, this, queue, 'All Cards').open();
			},
		});

		// Command 2: Study deck
		this.addCommand({
			id: 'study-deck',
			name: 'Study deck',
			callback: () => {
				new TagPickerModal(this.app, this).open();
			},
		});

		// Command 3: Open dashboard
		this.addCommand({
			id: 'open-dashboard',
			name: 'Open dashboard',
			callback: async () => {
				await this.activateDashboardView();
			},
		});

		// Command 4: Scan current note
		this.addCommand({
			id: 'scan-current-note',
			name: 'Scan current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					if (!checking) {
						void (async () => {
							try {
								const res = await this.scanner.scanFile(activeView.file!);
								if (res.ignored) {
									new Notice(
										`⚡ Scanned "${activeView.file!.basename}": Note is ignored (cards-ignore: true).`,
									);
									this.refreshDashboardIfOpen();
									return;
								}
								let extra = '';
								if (res.idCollisionFixed) extra += ' (fixed duplicate note ID)';
								if (res.duplicateBlocksFixed > 0)
									extra += ` (fixed ${res.duplicateBlocksFixed} duplicate block IDs)`;
								new Notice(
									`⚡ Scanned "${activeView.file!.basename}": ${res.blocksFound} flashcards synchronized${extra}.`,
								);
								this.refreshDashboardIfOpen();
							} catch (error) {
								console.error(`[Flashcards] Failed to scan "${activeView.file!.path}":`, error);
								new Notice(
									`❌ Failed to scan "${activeView.file!.basename}". See developer console for details.`,
								);
							}
						})();
					}
					return true;
				}
				return false;
			},
		});

		// Command 5: Scan entire vault
		this.addCommand({
			id: 'scan-entire-vault',
			name: 'Scan entire vault',
			callback: async () => {
				new Notice('🔍 Scanning entire vault for flashcards...');
				try {
					const res = await this.scanner.scanVault();
					let extra = '';
					if (res.idCollisionsFixed > 0)
						extra += ` (fixed ${res.idCollisionsFixed} duplicate note IDs)`;
					if (res.duplicateBlocksFixed > 0)
						extra += ` (fixed ${res.duplicateBlocksFixed} duplicate block IDs)`;

					if (res.failedFiles.length > 0) {
						const sample = res.failedFiles
							.slice(0, 3)
							.map((p) => p.split('/').pop()?.replace(/\.md$/, '') || p)
							.join(', ');
						const more =
							res.failedFiles.length > 3 ? ` and ${res.failedFiles.length - 3} more` : '';
						new Notice(
							`⚠️ Vault scan completed with warnings: ${res.totalCards} cards across ${res.notesScanned} notes${extra}.\n❌ Failed to parse ${res.failedFiles.length} notes (${sample}${more}). Check console for details.`,
							10000,
						);
					} else {
						new Notice(
							`⚡ Vault scan complete: ${res.totalCards} cards across ${res.notesScanned} notes${extra}.`,
						);
					}
					this.refreshDashboardIfOpen();
				} catch (error) {
					console.error('[Flashcards] Vault scan encountered a critical error:', error);
					new Notice(
						'❌ Vault scan encountered a critical error. See developer console for details.',
					);
				}
			},
		});

		// Command 6: Insert card block
		this.addCommand({
			id: 'insert-card-block',
			name: 'Insert card block',
			editorCallback: (editor: Editor) => {
				const id = this.scanner.generateBlockId();
				const cursor = editor.getCursor();
				const prefix = cursor.ch !== 0 ? '\n' : '';
				const template = `${prefix}%% card-start id=${id} %%\n\n...\n\n%% card-end %%\n`;
				editor.replaceRange(template, cursor);
				const targetLine = cursor.line + (cursor.ch !== 0 ? 2 : 1);
				editor.setCursor({ line: targetLine, ch: 0 });
			},
		});

		// Command 7: Optimize FSRS weights
		this.addCommand({
			id: 'optimize-fsrs-weights',
			name: 'Optimize FSRS weights',
			callback: async () => {
				const logs = this.getReviewLogs();
				if (logs.length < 8) {
					new Notice('⚠️ Need at least 8 review logs to optimize FSRS weights.');
					return;
				}
				try {
					const rawWeights = this.settings.customWeights
						? this.settings.customWeights
								.split(',')
								.map((s) => parseFloat(s.trim()))
								.filter((n) => !isNaN(n))
						: undefined;

					const validWeights = rawWeights && rawWeights.length === 21 ? rawWeights : undefined;

					const params: FsrsParams = {
						request_retention: this.settings.requestRetention,
						maximum_interval: this.settings.maximumInterval,
						w: validWeights,
						enable_fuzz: this.settings.enableFuzz,
						relearning_steps: parseStudySteps(
							this.settings.relearningSteps,
							DEFAULT_RELEARNING_STEPS,
						),
					};
					const optimized = WasmBridge.optimizeFsrsWeights(params, logs);
					this.settings.customWeights = optimized.map((n) => n.toFixed(5)).join(', ');
					await this.saveSettings();
					new Notice(`🧠 FSRS-6 weights optimized successfully from ${logs.length} review logs!`);
				} catch (err) {
					console.error('Failed to optimize FSRS weights:', err);
					new Notice('❌ Failed to optimize FSRS weights.');
				}
			},
		});

		// Command 8: Optimize database
		this.addCommand({
			id: 'optimize-database',
			name: 'Optimize database',
			callback: async () => {
				new Notice('🧹 Running database health check & optimization...');
				const files = this.app.vault.getMarkdownFiles();
				const validPaths = new Set(files.map((f) => f.path));
				const res = await this.db.optimizeDatabase(validPaths);
				if (!res.integrityOk) {
					new Notice('⚠️ Database integrity check reported warnings.');
				} else {
					new Notice(
						`✨ Database optimized: ${res.prunedNotes} stale notes, ${res.cleanedBlocks} orphaned blocks, ${res.cleanedItems} items cleaned.`,
					);
				}
				this.refreshDashboardIfOpen();
			},
		});
	}

	public getReviewLogs(): ReviewLogEntry[] {
		return this.db.getReviewLogsForOptimization();
	}

	public refreshDashboardIfOpen(): void {
		const leaves = this.app.workspace.getLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof DashboardView) {
				leaf.view.refresh();
			}
		}
	}

	async activateDashboardView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE)[0];

		if (!leaf) {
			const rightLeaf = workspace.getLeaf('tab');
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({
					type: FLASHCARDS_DASHBOARD_VIEW_TYPE,
					active: true,
				});
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = (await this.loadData()) || {};
	}

	async saveSettings() {
		const clean: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(this.settings)) {
			if (v !== undefined && v !== '') {
				clean[k] = v;
			}
		}
		await this.saveData(clean);
	}

	onunload() {
		if (this.db) {
			void this.db.persist();
		}
		this.app.workspace.detachLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE);
	}
}
