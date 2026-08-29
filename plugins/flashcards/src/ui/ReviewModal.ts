import { App, Modal, TFile } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import type { FsrsParams, ReviewItem, SchedulingCard } from '../types.js';
import { ReviewSessionCache } from '../utils/ReviewSessionCache.js';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../utils/studySteps.js';
import { toggleCardTodoInMarkdown } from '../utils/todoTag.js';
import { WasmBridge } from '../wasm.js';
import ReviewModalComponent from './components/ReviewModal.svelte';

export class ReviewModal extends Modal {
	private component: ReturnType<typeof ReviewModalComponent> | undefined;
	private cache: ReviewSessionCache;
	private isCommitted = false;

	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
		private items: ReviewItem[],
		private deckName = 'All Cards',
	) {
		super(app);
		this.cache = new ReviewSessionCache();
	}

	onOpen() {
		this.modalEl.addClass('fc-review-modal-window');
		this.contentEl.empty();
		this.contentEl.addClass('fc-modal-content-reset');

		this.component = mount(ReviewModalComponent, {
			target: this.contentEl,
			props: {
				app: this.app,
				items: this.items,
				deckName: this.deckName,
				onGrade: (item: ReviewItem, ratingStr: 'forgot' | 'remembered') => {
					this.handleCardGrade(item, ratingStr);
				},
				onUndo: (item: ReviewItem) => {
					this.handleCardUndo(item);
				},
				onFinishSession: async (studied: number, forgot: number, remembered: number) => {
					await this.commitSessionData(studied, forgot, remembered);
				},
				onToggleTodo: async (item: ReviewItem) => {
					await this.handleToggleTodo(item);
				},
				onClose: () => this.close(),
			},
		});
	}

	private handleCardGrade(item: ReviewItem, ratingStr: 'forgot' | 'remembered'): void {
		const previousCard = this.toSchedulingCard(item);
		const rawWeights = this.plugin.settings.customWeights
			? this.plugin.settings.customWeights
					.split(',')
					.map((s) => parseFloat(s.trim()))
					.filter((n) => !isNaN(n))
			: undefined;
		const now = Date.now();
		const dueCounts = this.plugin.db.getUpcomingDueCounts(90, now);
		const sibling = this.plugin.db.getSiblingCard(item.cardId, item.blockId);
		let siblingDueOffset: number | undefined = undefined;
		if (sibling && sibling.due_at > now) {
			siblingDueOffset = Math.max(0, Math.round((sibling.due_at - now) / 86400000));
		}

		const params: FsrsParams = {
			request_retention: this.plugin.settings.requestRetention,
			maximum_interval: this.plugin.settings.maximumInterval,
			w: rawWeights && rawWeights.length === 21 ? rawWeights : undefined,
			enable_fuzz: this.plugin.settings.enableFuzz,
			learning_steps: parseStudySteps(this.plugin.settings.learningSteps, DEFAULT_LEARNING_STEPS),
			relearning_steps: parseStudySteps(
				this.plugin.settings.relearningSteps,
				DEFAULT_RELEARNING_STEPS,
			),
			due_counts: dueCounts,
			sibling_due_offset: siblingDueOffset,
		};

		const info = WasmBridge.calculateSchedule(previousCard, params, now);
		const targetRating = ratingStr === 'forgot' ? 'again' : 'good';

		const candidate =
			info.next_states.find((c) => c.rating === targetRating) ?? info.next_states[2];
		if (!candidate) return;

		const stateNum = this.plugin.db.unmapState(candidate.card.state);

		this.cache.recordReview(item, previousCard, ratingStr, candidate.card, stateNum, now);

		this.applySchedulingCard(item, candidate.card);
	}

	private handleCardUndo(_item: ReviewItem): void {
		const undoRes = this.cache.undo();
		if (undoRes) {
			this.applySchedulingCard(undoRes.item, undoRes.previousState);
		}
	}

	private async commitSessionData(
		studied: number,
		forgot: number,
		remembered: number,
	): Promise<void> {
		if (this.isCommitted || this.cache.getReviewsCount() === 0) return;
		this.isCommitted = true;

		const { session, reviews, cardUpdates } = this.cache.getPendingData(
			studied,
			forgot,
			remembered,
		);

		try {
			await this.plugin.db.commitSession(session, reviews, cardUpdates);
			this.plugin.refreshDashboardIfOpen();
		} catch (error) {
			console.error('Failed to commit study session:', error);
		}
	}

	private toSchedulingCard(item: ReviewItem): SchedulingCard {
		return {
			stability: item.stability,
			difficulty: item.difficulty,
			reps: item.reps,
			lapses: item.lapses,
			learning_step: item.learningStep,
			relearning_step: item.relearningStep,
			state: item.state,
			last_review: item.lastReview,
			due: item.dueAt,
		};
	}

	private applySchedulingCard(item: ReviewItem, card: SchedulingCard): void {
		item.stability = card.stability;
		item.difficulty = card.difficulty;
		item.reps = card.reps;
		item.lapses = card.lapses;
		item.learningStep = card.learning_step;
		item.relearningStep = card.relearning_step;
		item.state = card.state;
		item.stateNum = this.plugin.db.unmapState(card.state);
		item.lastReview = card.last_review;
		item.dueAt = card.due;
		item.dueHuman = this.plugin.db.humanizeDue(card.due);
		item.lastPracticedHuman = card.last_review ? 'Just now' : 'Never';
	}

	private async handleToggleTodo(item: ReviewItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.notePath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			const updated = toggleCardTodoInMarkdown(content, item.blockId, item.blockType);
			if (updated !== content) {
				await this.app.vault.modify(file, updated);
				await this.plugin.scanner.syncFile(file);
				this.plugin.refreshDashboardIfOpen();
			}
		}
	}

	onClose() {
		if (!this.isCommitted && this.cache.getReviewsCount() > 0) {
			const stats = this.cache.getStats();
			void this.commitSessionData(stats.studied, stats.forgot, stats.remembered);
		}
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
