import type {
	CardPerformanceUpdate,
	ReviewItem,
	ReviewRecord,
	SchedulingCard,
	SessionRecord,
} from '../types.ts';

export interface UndoResult {
	item: ReviewItem;
	previousState: SchedulingCard;
	rating: 'forgot' | 'remembered';
}

/**
 * In-Memory Review Cache (Hashcards Model).
 * Holds all session reviews, card updates, and undo history in memory during active study.
 * No SQL queries or disk writes occur until the session is explicitly committed.
 */
export class ReviewSessionCache {
	private sessionReviews: ReviewRecord[] = [];
	private cardUpdates: Map<number, CardPerformanceUpdate> = new Map();
	private undoStack: Array<{
		item: ReviewItem;
		previousState: SchedulingCard;
		previousCardUpdate: CardPerformanceUpdate | undefined;
		rating: 'forgot' | 'remembered';
	}> = [];
	private forgotCount = 0;
	private rememberedCount = 0;
	private startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	public recordReview(
		item: ReviewItem,
		previousState: SchedulingCard,
		ratingStr: 'forgot' | 'remembered',
		nextCard: SchedulingCard,
		stateNum: number,
		now = Date.now(),
	): void {
		const previousCardUpdate = this.cardUpdates.get(item.cardId);
		const ratingNum = ratingStr === 'forgot' ? 1 : 3;

		if (ratingStr === 'forgot') {
			this.forgotCount++;
		} else {
			this.rememberedCount++;
		}

		this.sessionReviews.push({
			card_id: item.cardId,
			rating: ratingNum,
			state: stateNum,
			due_at: nextCard.due,
			stability: nextCard.stability,
			difficulty: nextCard.difficulty,
			reviewed_at: now,
		});

		this.cardUpdates.set(item.cardId, {
			id: item.cardId,
			state: stateNum,
			due_at: nextCard.due,
			stability: nextCard.stability,
			difficulty: nextCard.difficulty,
			reps: nextCard.reps,
			lapses: nextCard.lapses,
			last_review: now,
			learning_step: nextCard.learning_step,
			relearning_step: nextCard.relearning_step,
		});

		this.undoStack.push({
			item,
			previousState,
			previousCardUpdate,
			rating: ratingStr,
		});
	}

	public undo(): UndoResult | null {
		const entry = this.undoStack.pop();
		const lastReview = this.sessionReviews.pop();
		if (!entry || !lastReview) return null;

		if (entry.rating === 'forgot') {
			this.forgotCount = Math.max(0, this.forgotCount - 1);
		} else {
			this.rememberedCount = Math.max(0, this.rememberedCount - 1);
		}

		if (entry.previousCardUpdate) {
			this.cardUpdates.set(entry.item.cardId, entry.previousCardUpdate);
		} else {
			this.cardUpdates.delete(entry.item.cardId);
		}

		return {
			item: entry.item,
			previousState: entry.previousState,
			rating: entry.rating,
		};
	}

	public getPendingData(
		studied?: number,
		forgot?: number,
		remembered?: number,
		endedAt = Date.now(),
	): {
		session: SessionRecord;
		reviews: ReviewRecord[];
		cardUpdates: CardPerformanceUpdate[];
	} {
		return {
			session: {
				started_at: this.startedAt,
				ended_at: endedAt,
				card_count: studied ?? this.sessionReviews.length,
				forgot_count: forgot ?? this.forgotCount,
				remembered_count: remembered ?? this.rememberedCount,
			},
			reviews: [...this.sessionReviews],
			cardUpdates: Array.from(this.cardUpdates.values()),
		};
	}

	public getReviewsCount(): number {
		return this.sessionReviews.length;
	}

	public getStats(): { studied: number; forgot: number; remembered: number } {
		return {
			studied: this.sessionReviews.length,
			forgot: this.forgotCount,
			remembered: this.rememberedCount,
		};
	}
}
