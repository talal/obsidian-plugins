import { type Editor, Notice, Plugin, TFile } from 'obsidian';

import { DatabaseManager } from './db/DatabaseManager.js';
import { NoteScanner } from './scanner/NoteScanner.js';
import { FlashcardsSettingTab } from './settings.js';
import {
	DEFAULT_MAXIMUM_INTERVAL,
	DEFAULT_REQUEST_RETENTION,
	type FlashcardsPluginSettings,
	type FsrsParams,
	type ReviewLogEntry,
} from './types.js';
import { DashboardView, FLASHCARDS_DASHBOARD_VIEW_TYPE } from './ui/DashboardView.js';
import { ReviewModal } from './ui/ReviewModal.js';
import { TagPickerModal } from './ui/TagPickerModal.js';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from './utils/studySteps.js';
import { WasmBridge } from './wasm.js';

export default class FlashcardsPlugin extends Plugin {
	public db!: DatabaseManager;
	public scanner!: NoteScanner;
	public settings!: FlashcardsPluginSettings;
	public activeReviewModal: ReviewModal | null = null;

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

		// 3. Register Vault File Events
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.scanner.deleteFile(file.path);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.scanner.renameFile(oldPath, file.path);
				}
			}),
		);

		// 4. Register Lifecycle Checkpointing Events
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'hidden' && this.activeReviewModal) {
				void this.activeReviewModal.flushSessionData();
			}
		});

		this.registerDomEvent(window, 'beforeunload', () => {
			if (this.activeReviewModal) {
				void this.activeReviewModal.flushSessionData();
			}
		});

		// 4. Register Commands

		// Command 1: Study all cards
		this.addCommand({
			id: 'study-all-cards',
			name: 'Study all cards',
			callback: () => {
				const rollover = this.settings.rolloverHour ?? 4;
				const learningSteps = parseStudySteps(this.settings.learningSteps, DEFAULT_LEARNING_STEPS);
				const relearningSteps = parseStudySteps(
					this.settings.relearningSteps,
					DEFAULT_RELEARNING_STEPS,
				);
				const dueCards = this.db.getDueCards(undefined, rollover, learningSteps, relearningSteps);
				const queue = dueCards.length > 0 ? dueCards : this.db.getAllCards();

				if (queue.length === 0) {
					new Notice('🎉 No flashcards found in your vault. Run "Sync" first!');
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

		// Command 4: Sync
		this.addCommand({
			id: 'sync',
			name: 'Sync',
			callback: async () => {
				await this.syncVault();
			},
		});

		// Command 5: Insert card block
		this.addCommand({
			id: 'insert-card-block',
			name: 'Insert card block',
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const prefix = cursor.ch !== 0 ? '\n' : '';
				const template = `${prefix}%% card-start %%\n\n...\n\n%% card-end %%\n`;
				editor.replaceRange(template, cursor);
				const targetLine = cursor.line + (cursor.ch !== 0 ? 2 : 1);
				editor.setCursor({ line: targetLine, ch: 0 });
			},
		});

		// Command 6: Optimize FSRS weights
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
						request_retention: this.settings.requestRetention ?? DEFAULT_REQUEST_RETENTION,
						maximum_interval: this.settings.maximumInterval ?? DEFAULT_MAXIMUM_INTERVAL,
						weights: validWeights,
						learning_steps: parseStudySteps(this.settings.learningSteps, DEFAULT_LEARNING_STEPS),
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

		// Command 7: Optimize database
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
					new Notice(`✨ Database optimized: ${res.prunedBlocks} stale blocks cleaned.`);
				}
				this.refreshDashboardIfOpen();
			},
		});
	}

	public getReviewLogs(): ReviewLogEntry[] {
		return this.db.getReviewLogsForOptimization();
	}

	public async syncVault(): Promise<void> {
		new Notice('🔍 Syncing flashcards across vault...');
		try {
			const res = await this.scanner.fullScan();
			const failureNotice =
				res.failedFiles.length > 0
					? ` (${res.failedFiles.length} note(s) had errors, see console)`
					: '';
			new Notice(
				`⚡ Vault sync complete: ${res.totalBlocks} cards across ${res.filesScanned} notes${failureNotice}.`,
			);
			this.refreshDashboardIfOpen();
		} catch (error) {
			console.error('[Flashcards] Vault sync encountered an error:', error);
			new Notice('❌ Vault sync encountered an error. See developer console.');
		}
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
		if (this.activeReviewModal) {
			void this.activeReviewModal.flushSessionData();
		}
		if (this.db) {
			void this.db.persist();
		}
		this.app.workspace.detachLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE);
	}
}
