import { App, Modal, Notice, TFile } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import {
	DEFAULT_LEECH_TAG,
	DEFAULT_MAXIMUM_INTERVAL,
	DEFAULT_REQUEST_RETENTION,
	type FsrsParams,
	type ReviewItem,
	type SchedulingCard,
} from '../types.js';
import {
	addCardLeechTagInMarkdown,
	isLeechThresholdMet,
	toggleCardTodoInMarkdown,
} from '../utils/cardTagModifier.js';
import { ReviewSessionCache } from '../utils/ReviewSessionCache.js';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../utils/studySteps.js';
import { WasmBridge } from '../wasm.js';
import ReviewModalComponent from './components/ReviewModal.svelte';

export class ReviewModal extends Modal {
	private component: ReturnType<typeof ReviewModalComponent> | undefined;
	private cache: ReviewSessionCache;
	private activeSessionId: number | null = null;
	private hasUnsavedChanges = false;

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
		this.plugin.activeReviewModal = this;
		this.containerEl.addClass('fc-review-modal-container');
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
					await this.flushSessionData(studied, forgot, remembered);
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
		const rolloverHour = this.plugin.settings.rolloverHour ?? 4;
		const dueCounts = this.plugin.db.getUpcomingDueCounts(90, now, rolloverHour);
		const sibling = this.plugin.db.getSiblingCard(item.cardId, item.blockId);
		let siblingDueOffset: number | undefined = undefined;
		if (sibling && sibling.due_at > now) {
			siblingDueOffset = Math.max(0, Math.round((sibling.due_at - now) / 86400000));
		}

		const params: FsrsParams = {
			request_retention: this.plugin.settings.requestRetention ?? DEFAULT_REQUEST_RETENTION,
			maximum_interval: this.plugin.settings.maximumInterval ?? DEFAULT_MAXIMUM_INTERVAL,
			weights: rawWeights && rawWeights.length === 21 ? rawWeights : undefined,
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
		this.hasUnsavedChanges = true;

		this.applySchedulingCard(item, candidate.card);

		// Check Leech threshold on lapses (Forgot on review/relearning card)
		const leechThreshold = this.plugin.settings.leechThreshold ?? 4;
		if (
			ratingStr === 'forgot' &&
			(previousCard.state === 'review' || previousCard.state === 'relearning') &&
			isLeechThresholdMet(candidate.card.lapses, leechThreshold)
		) {
			void this.handleCardLeech(item, candidate.card.lapses);
		}
	}

	private handleCardUndo(_item: ReviewItem): void {
		const undoRes = this.cache.undo();
		if (undoRes) {
			this.hasUnsavedChanges = true;
			this.applySchedulingCard(undoRes.item, undoRes.previousState);
		}
	}

	public async flushSessionData(
		studied?: number,
		forgot?: number,
		remembered?: number,
	): Promise<void> {
		if (!this.hasUnsavedChanges || this.cache.getReviewsCount() === 0) return;

		const stats = this.cache.getStats();
		const s = studied ?? stats.studied;
		const f = forgot ?? stats.forgot;
		const r = remembered ?? stats.remembered;

		const { session, reviews, cardUpdates } = this.cache.getPendingData(s, f, r);

		try {
			const sessionId = await this.plugin.db.commitSession(
				session,
				reviews,
				cardUpdates,
				this.activeSessionId ?? undefined,
			);
			this.activeSessionId = sessionId;
			this.hasUnsavedChanges = false;
			this.plugin.refreshDashboardIfOpen();
		} catch (error) {
			console.error('Failed to flush study session checkpoint:', error);
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

	private async handleCardLeech(item: ReviewItem, lapses: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.notePath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			const updated = addCardLeechTagInMarkdown(
				content,
				item.blockId,
				item.blockType,
				DEFAULT_LEECH_TAG,
			);
			if (updated !== content) {
				await this.app.vault.modify(file, updated);
				await this.plugin.scanner.syncFile(file);
				this.plugin.refreshDashboardIfOpen();
				new Notice(`⚡ Card marked as leech (${DEFAULT_LEECH_TAG}) after ${lapses} lapses.`);
			}
		}
	}

	onClose() {
		if (this.plugin.activeReviewModal === this) {
			this.plugin.activeReviewModal = null;
		}
		if (this.hasUnsavedChanges && this.cache.getReviewsCount() > 0) {
			const stats = this.cache.getStats();
			void this.flushSessionData(stats.studied, stats.forgot, stats.remembered);
		}
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
