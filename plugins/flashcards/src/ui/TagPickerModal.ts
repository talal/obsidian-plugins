import { App, Modal, Notice } from 'obsidian';
import { mount, unmount } from 'svelte';

import { getStudyDayCutoff } from '../db/DatabaseManager.js';
import type FlashcardsPlugin from '../main.js';
import { matchCardTags } from '../utils/dashboardFilter.js';
import { computeTagDeckStats } from '../utils/tagStats.js';
import TagPickerModalComponent from './components/TagPickerModal.svelte';
import { ReviewModal } from './ReviewModal.js';

export class TagPickerModal extends Modal {
	private component: ReturnType<typeof TagPickerModalComponent> | undefined;

	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle('Study deck');
		this.contentEl.empty();

		const rollover = this.plugin.settings.rolloverHour ?? 4;
		const allCards = this.plugin.db.getAllCards();
		const dueCutoff = getStudyDayCutoff(rollover);
		const tagStats = computeTagDeckStats(allCards, dueCutoff);

		if (tagStats.length === 0) {
			new Notice('No tagged cards found in your vault. Run "Scan entire vault" first.');
			this.close();
			return;
		}

		this.component = mount(TagPickerModalComponent, {
			target: this.contentEl,
			props: {
				tagStats,
				onSelectTags: (tags: string[]) => {
					this.close();
					const dueItems = this.plugin.db.getDueCards(tags, rollover);
					const allDeckItems = allCards.filter((item) => matchCardTags(item.tags, tags));

					const targetQueue = dueItems.length > 0 ? dueItems : allDeckItems;

					if (targetQueue.length === 0) {
						new Notice(`No cards found matching tags: ${tags.join(', ')}`);
						return;
					}

					new ReviewModal(this.app, this.plugin, targetQueue, `#${tags.join(' #')}`).open();
				},
				onClose: () => this.close(),
			},
		});
	}

	onClose() {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
