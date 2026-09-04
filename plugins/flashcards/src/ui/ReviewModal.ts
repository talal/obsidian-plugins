import { App, Modal } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import type { ReviewItem } from '../types.js';
import type { FlashcardsEngine } from '../wasm.js';
import ReviewModalComponent from './components/ReviewModal.svelte';
import { ReviewSession } from './ReviewSession.js';

export class ReviewModal extends Modal {
	private component: ReturnType<typeof ReviewModalComponent> | undefined;
	private session: ReviewSession;

	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
		engine: FlashcardsEngine,
		items: ReviewItem[],
		deckName = 'All Cards',
	) {
		super(app);
		this.session = new ReviewSession(app, plugin, engine, items, deckName);
	}

	onOpen() {
		this.plugin.activeReviewModal = this;
		this.containerEl.addClass('fc-review-modal-container');
		this.modalEl.addClass('fc-review-modal-window');
		this.contentEl.empty();
		this.contentEl.addClass('fc-modal-content-reset');

		this.component = mount(ReviewModalComponent, {
			target: this.contentEl,
			props: {
				app: this.app,
				items: this.session.items,
				deckName: this.session.deckName,
				onGrade: (item: ReviewItem, ratingStr: 'forgot' | 'remembered') =>
					this.session.grade(item, ratingStr),
				onUndo: (_item: ReviewItem) => this.session.undo(),
				onFinishSession: () => this.session.finishSession(),
				onToggleTodo: (item: ReviewItem) => this.session.toggleTodo(item),
				onClose: () => this.close(),
			},
		});
	}

	async onClose() {
		if (this.plugin.activeReviewModal === this) {
			this.plugin.activeReviewModal = null;
		}
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
		await this.session.finishSession();
	}
}
