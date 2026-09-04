import { App, Modal, Notice } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import { getStudyDayCutoff } from '../utils/studyDay.js';
import { type FlashcardsEngine, WasmBridge } from '../wasm.js';
import TagPickerModalComponent from './components/TagPickerModal.svelte';
import { ReviewModal } from './ReviewModal.js';

export class TagPickerModal extends Modal {
	private component: ReturnType<typeof TagPickerModalComponent> | undefined;

	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
		private engine: FlashcardsEngine,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle('Study deck');
		this.contentEl.empty();

		const now = Date.now();
		const rollover = this.plugin.settings.rolloverHour ?? 4;
		const dueCutoff = getStudyDayCutoff(rollover, new Date(now));
		const tagStats = WasmBridge.getTagDeckStats(this.engine, now, dueCutoff);

		if (tagStats.length === 0) {
			new Notice('No tagged cards found in your vault. Run "Sync" first.');
			this.close();
			return;
		}

		this.component = mount(TagPickerModalComponent, {
			target: this.contentEl,
			props: {
				tagStats,
				onSelectTags: (tags: string[]) => {
					this.close();
					const dueItems = WasmBridge.getDueCards(this.engine, now, dueCutoff, tags);

					if (dueItems.length === 0) {
						new Notice(`No due cards matching: ${tags.join(', ')}`);
						return;
					}

					new ReviewModal(
						this.app,
						this.plugin,
						this.engine,
						dueItems,
						`#${tags.join(' #')}`,
					).open();
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
