import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';

import { getStudyDayCutoff } from '../db/DatabaseManager.js';
import type FlashcardsPlugin from '../main.js';
import type { ReviewItem } from '../types.js';
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
		this.renderComponent();
	}

	public refresh(): void {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
		this.renderComponent();
	}

	private renderComponent(): void {
		const rollover = this.plugin.settings.rolloverHour ?? 4;
		const items = this.plugin.db.getAllCards();
		const stats = this.plugin.db.getDashboardStats(rollover);
		const dueCutoff = getStudyDayCutoff(rollover);

		this.component = mount(DashboardViewComponent, {
			target: this.contentEl,
			props: {
				items,
				stats,
				dueCutoff,
				onStartReview: () => {
					const dueItems = this.plugin.db.getDueCards(undefined, rollover);
					const queue = dueItems.length > 0 ? dueItems : items;
					if (queue.length === 0) {
						new Notice('No cards available to study.');
						return;
					}
					new ReviewModal(this.app, this.plugin, queue, 'All Cards').open();
				},
				onStudyDeck: () => {
					new TagPickerModal(this.app, this.plugin).open();
				},
				onOpenCard: (item: ReviewItem) => {
					const link = item.blockId ? `${item.notePath}#^${item.blockId}` : item.notePath;
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
