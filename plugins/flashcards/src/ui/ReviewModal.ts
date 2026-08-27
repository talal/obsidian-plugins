import { App, Modal, TFile } from 'obsidian';
import { mount, unmount } from 'svelte';

import type FlashcardsPlugin from '../main.js';
import type { FsrsParams, ReviewItem, SchedulingCard } from '../types.js';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../utils/studySteps.js';
import { WasmBridge } from '../wasm.js';
import ReviewStage from './components/ReviewStage.svelte';

export class ReviewModal extends Modal {
	private component: ReturnType<typeof ReviewStage> | undefined;
	private sessionId = 0;

	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
		private items: ReviewItem[],
		private deckName = 'All Cards',
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('fc-review-modal-window');
		this.contentEl.empty();
		this.contentEl.addClass('fc-modal-content-reset');

		this.sessionId = this.plugin.db.createSession(this.deckName);

		this.component = mount(ReviewStage, {
			target: this.contentEl,
			props: {
				app: this.app,
				items: this.items,
				deckName: this.deckName,
				onGrade: async (item: ReviewItem, ratingStr: 'forgot' | 'remembered') => {
					await this.handleCardGrade(item, ratingStr);
				},
				onUndo: async (item: ReviewItem) => {
					await this.handleCardUndo(item);
				},
				onFinishSession: async (studied: number, forgot: number, remembered: number) => {
					this.plugin.db.finishSession(this.sessionId, studied, forgot, remembered);
					await this.plugin.db.persist();
					this.plugin.refreshDashboardIfOpen();
				},
				onToggleTodo: async (item: ReviewItem) => {
					await this.handleToggleTodo(item);
				},
				onClose: () => this.close(),
			},
		});
	}

	private async handleCardGrade(
		item: ReviewItem,
		ratingStr: 'forgot' | 'remembered',
	): Promise<void> {
		const previousCard = this.toSchedulingCard(item);
		const rawWeights = this.plugin.settings.customWeights
			? this.plugin.settings.customWeights
					.split(',')
					.map((s) => parseFloat(s.trim()))
					.filter((n) => !isNaN(n))
			: undefined;

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
		};

		const info = WasmBridge.calculateSchedule(previousCard, params, Date.now());
		const targetRating = ratingStr === 'forgot' ? 'again' : 'good';
		const ratingNum = ratingStr === 'forgot' ? 1 : 3;

		const candidate =
			info.next_states.find((c) => c.rating === targetRating) ?? info.next_states[2];
		if (!candidate) return;

		this.plugin.db.recordReview(
			item.id,
			ratingNum,
			candidate.card.state,
			candidate.card.due,
			candidate.card.stability,
			candidate.card.difficulty,
			candidate.card.reps,
			candidate.card.lapses,
			candidate.card.learning_step,
			candidate.card.relearning_step,
			this.sessionId,
		);
		this.applySchedulingCard(item, candidate.card);
		try {
			await this.plugin.db.persist();
		} catch (error) {
			this.plugin.db.rollbackReview(item.id, previousCard, this.sessionId);
			this.applySchedulingCard(item, previousCard);
			try {
				await this.plugin.db.persist();
			} catch {
				// Preserve the original persistence error for the review UI.
			}
			throw error;
		}
		this.plugin.refreshDashboardIfOpen();
	}

	private async handleCardUndo(item: ReviewItem): Promise<void> {
		const previousCard = this.toSchedulingCard(item);
		this.plugin.db.rollbackReview(item.id, previousCard, this.sessionId);
		const liveItem = this.items.find((candidate) => candidate.id === item.id);
		if (liveItem) this.applySchedulingCard(liveItem, previousCard);
		await this.plugin.db.persist();
		this.plugin.refreshDashboardIfOpen();
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
			due: item.due,
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
		item.lastReview = card.last_review;
		item.due = card.due;
		item.dueHuman = this.plugin.db.humanizeDue(card.due);
		item.lastPracticedHuman = card.last_review ? 'Just now' : 'Never';
	}

	private async handleToggleTodo(item: ReviewItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.notePath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				if (line.includes(`^${item.blockId}`) || line.includes(`id=${item.blockId}`)) {
					if (/(?:^|\s)#todo\/card(?:\s|$)/.test(line)) {
						lines[i] = line
							.replace(/(?:^|\s)#todo\/card(?:\s|$)/g, ' ')
							.replace(/\s+/g, ' ')
							.trimEnd();
					} else if (item.cardType !== 'block') {
						const trimmedLine = line.trimEnd();
						const blockIdSuffix = ` ^${item.blockId}`;
						if (trimmedLine.endsWith(blockIdSuffix)) {
							lines[i] =
								`${trimmedLine.slice(0, -blockIdSuffix.length).trimEnd()} #todo/card${blockIdSuffix}`;
						} else {
							lines[i] = `${trimmedLine} #todo/card`;
						}
					} else {
						lines[i] = `${line.trimEnd()} #todo/card`;
					}
					break;
				}
			}
			await this.app.vault.modify(file, lines.join('\n'));
			await this.plugin.scanner.scanFile(file);
			this.plugin.refreshDashboardIfOpen();
		}
	}

	onClose() {
		if (this.sessionId) {
			this.plugin.db.finishSession(this.sessionId);
			void this.plugin.db.persist().catch(() => undefined);
		}
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
		this.contentEl.empty();
	}
}
