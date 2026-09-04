import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import { SnapshotStore } from '../storage.js';
import type { ReviewItem } from '../types.js';
import { getStudyDayCutoff } from '../utils/studyDay.js';
import { WasmBridge } from '../wasm.js';
import DashboardViewComponent from './components/DashboardView.svelte';
import { ReviewModal } from './ReviewModal.js';
import { TagPickerModal } from './TagPickerModal.js';

export const FLASHCARDS_DASHBOARD_VIEW_TYPE = 'flashcards-dashboard-view';

export class DashboardView extends ItemView {
	private component: ReturnType<typeof DashboardViewComponent> | undefined;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: FlashcardsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return FLASHCARDS_DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Flashcards Dashboard';
	}

	getIcon(): string {
		return 'layers';
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass('fc-dashboard-leaf');
		await this.renderComponent();
	}

	public async refresh(): Promise<void> {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
		await this.renderComponent();
	}

	private async renderComponent(): Promise<void> {
		const engine = await SnapshotStore.loadEngine(this.app);
		const now = Date.now();
		const rollover = this.plugin.settings.rolloverHour ?? 4;
		const dueCutoff = getStudyDayCutoff(rollover, new Date(now));
		const items = WasmBridge.getAllCards(engine, now);
		const stats = WasmBridge.getDashboardStats(engine, now, dueCutoff);

		this.component = mount(DashboardViewComponent, {
			target: this.contentEl,
			props: {
				items,
				stats,
				dueCutoff,
				onStartReview: async () => {
					const reviewEngine = await SnapshotStore.loadEngine(this.app);
					const currentNow = Date.now();
					const currentRollover = this.plugin.settings.rolloverHour ?? 4;
					const currentDueCutoff = getStudyDayCutoff(currentRollover, new Date(currentNow));
					const dueItems = WasmBridge.getDueCards(reviewEngine, currentNow, currentDueCutoff);
					if (dueItems.length === 0) {
						new Notice('All due cards completed for today!');
						return;
					}
					new ReviewModal(this.app, this.plugin, reviewEngine, dueItems, 'All Cards').open();
				},
				onStudyDeck: async () => {
					const deckEngine = await SnapshotStore.loadEngine(this.app);
					new TagPickerModal(this.app, this.plugin, deckEngine).open();
				},
				onSync: () => {
					void this.plugin.syncVault();
				},
				onOpenCard: (item: ReviewItem) => {
					const link = item.prompt_id ? `${item.note_path}#^${item.prompt_id}` : item.note_path;
					void this.app.workspace.openLinkText(link, '', false);
				},
			},
		});
	}

	async onClose() {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
