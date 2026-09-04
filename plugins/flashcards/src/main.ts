import { type Editor, Notice, Plugin, TFile } from 'obsidian';

import { NoteScanner } from './scanner/NoteScanner.js';
import { FlashcardsSettingTab } from './settings.js';
import { SnapshotStore } from './storage.js';
import { type FlashcardsPluginSettings, type ReviewLogEntry } from './types.js';
import { DashboardView, FLASHCARDS_DASHBOARD_VIEW_TYPE } from './ui/DashboardView.js';
import { ReviewModal } from './ui/ReviewModal.js';
import { TagPickerModal } from './ui/TagPickerModal.js';
import { getStudyDayCutoff } from './utils/studyDay.js';
import { WasmBridge } from './wasm.js';

export default class FlashcardsPlugin extends Plugin {
	public settings!: FlashcardsPluginSettings;
	public activeReviewModal: ReviewModal | null = null;

	async onload() {
		await this.loadSettings();

		// 1. Initialize Rust WASM binary
		try {
			await WasmBridge.initialize(this.app, this.manifest);
		} catch (err) {
			console.error('Failed to initialize Flashcards WASM module:', err);
			new Notice('Failed to initialize Flashcards WASM module.');
			return;
		}

		// 2. Register Views & Settings Tab
		this.registerView(FLASHCARDS_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.addSettingTab(new FlashcardsSettingTab(this.app, this));

		// 3. Register Vault File Events
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.deleteFile(file.path);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.renameFile(oldPath, file.path);
				}
			}),
		);

		// 4. Register Commands

		// Command 1: Study all cards (Modal)
		this.addCommand({
			id: 'study-all-cards',
			name: 'Study all cards',
			callback: async () => {
				const engine = await SnapshotStore.loadEngine(this.app);
				const now = Date.now();
				const rollover = this.settings.rolloverHour ?? 4;
				const dueCutoff = getStudyDayCutoff(rollover, new Date(now));
				const dueCards = WasmBridge.getDueCards(engine, now, dueCutoff);
				if (dueCards.length === 0) {
					const allCards = WasmBridge.getAllCards(engine, now);
					if (allCards.length === 0) {
						new Notice('No flashcards found in your vault. Run "Sync" first!');
					} else {
						new Notice('All due cards completed for now!');
					}
					return;
				}

				new ReviewModal(this.app, this, engine, dueCards, 'All Cards').open();
			},
		});

		// Command 2: Study deck
		this.addCommand({
			id: 'study-deck',
			name: 'Study deck',
			callback: async () => {
				const engine = await SnapshotStore.loadEngine(this.app);
				new TagPickerModal(this.app, this, engine).open();
			},
		});

		// Command 4: Open dashboard
		this.addCommand({
			id: 'open-dashboard',
			name: 'Open dashboard',
			callback: async () => {
				await this.activateDashboardView();
			},
		});

		// Command 5: Sync
		this.addCommand({
			id: 'sync',
			name: 'Sync',
			callback: async () => {
				await this.syncVault();
			},
		});

		// Command 6: Insert card block
		this.addCommand({
			id: 'insert-card-block',
			name: 'Insert card block',
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const prefix = cursor.ch !== 0 ? '\n' : '';
				const template = `${prefix}%% card-start %%\n\n::\n\n%% card-end %%\n`;
				editor.replaceRange(template, cursor);
				const targetLine = cursor.line + (cursor.ch !== 0 ? 2 : 1);
				editor.setCursor({ line: targetLine, ch: 0 });
			},
		});
	}

	public async getReviewLogs(): Promise<ReviewLogEntry[]> {
		const engine = await SnapshotStore.loadEngine(this.app);
		const json = engine.get_review_logs();
		return JSON.parse(json) as ReviewLogEntry[];
	}

	public async deleteFile(filePath: string): Promise<void> {
		const engine = await SnapshotStore.loadEngine(this.app);
		engine.remove_file(filePath);
		await SnapshotStore.saveEngine(this.app, engine);
		this.refreshDashboardIfOpen();
	}

	public async renameFile(oldPath: string, newPath: string): Promise<void> {
		const engine = await SnapshotStore.loadEngine(this.app);
		engine.rename_file(oldPath, newPath);
		await SnapshotStore.saveEngine(this.app, engine);
		this.refreshDashboardIfOpen();
	}

	public async syncVault(force = false): Promise<void> {
		new Notice('Syncing flashcards across vault...');
		try {
			const engine = await SnapshotStore.loadEngine(this.app);
			const scanner = new NoteScanner(this.app, engine);
			const res = await scanner.fullScan(undefined, { force });
			const failureNotice =
				res.failedFiles.length > 0
					? ` (${res.failedFiles.length} note(s) had errors, see console)`
					: '';
			const skipNotice = res.filesSkipped > 0 ? ` (${res.filesSkipped} unchanged skipped)` : '';
			new Notice(
				`Vault sync complete: ${res.totalPrompts} cards across ${res.filesScanned} notes scanned${skipNotice}${failureNotice}.`,
			);
			this.refreshDashboardIfOpen();
		} catch (error) {
			console.error('[Flashcards] Vault sync encountered an error:', error);
			new Notice('Vault sync encountered an error. See developer console.');
		}
	}

	public refreshDashboardIfOpen(): void {
		const leaves = this.app.workspace.getLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE);
		for (const leaf of leaves) {
			if (leaf.view instanceof DashboardView) {
				void leaf.view.refresh();
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
		this.app.workspace.detachLeavesOfType(FLASHCARDS_DASHBOARD_VIEW_TYPE);
	}
}
