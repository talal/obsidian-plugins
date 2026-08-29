import type { ReviewItem } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export enum CardPriorityRank {
	New = 1,
	Review = 2,
	InterdayLearning = 3,
	IntradayLearning = 4,
}

/**
 * Computes the priority tier of a card for queue assembly and sibling burying.
 *
 * Priority Tiers (Highest to Lowest):
 * 1. Intraday Learning (Rank 4): Steps < 1 day (e.g. 10m). Never buried to ensure same-day consolidation.
 * 2. Interday Learning (Rank 3): Learning/Relearning steps >= 1 day (e.g. 1d).
 * 3. Review (Rank 2): Mature cards with FSRS intervals.
 * 4. New (Rank 1): Unstudied cards.
 */
export function getCardPriorityRank(
	card: ReviewItem,
	learningSteps: number[],
	relearningSteps: number[],
): CardPriorityRank {
	// Learning (stateNum === 1) or Relearning (stateNum === 3)
	if (card.stateNum === 1 || card.stateNum === 3) {
		const steps = card.stateNum === 1 ? learningSteps : relearningSteps;
		const stepIndex = card.stateNum === 1 ? card.learningStep : card.relearningStep;
		const stepDuration = steps[stepIndex] ?? steps[0] ?? 0;
		if (stepDuration < DAY_MS) {
			return CardPriorityRank.IntradayLearning;
		}
		return CardPriorityRank.InterdayLearning;
	}

	// Review (stateNum === 2)
	if (card.stateNum === 2) {
		return CardPriorityRank.Review;
	}

	// New (stateNum === 0)
	return CardPriorityRank.New;
}

/**
 * Applies sibling burying (Anti-Priming) to an assembled list of due cards.
 *
 * Rules:
 * - Group cards sharing the same blockId.
 * - Intraday learning cards are never buried.
 * - For siblings of the same block:
 *   1. Higher priority rank wins (Intraday > Interday > Review > New).
 *   2. If equal rank: more overdue card wins (dueAt ASC).
 *   3. If equal dueAt: Forward direction wins over Reverse direction.
 * - The winning card is included in the queue; all other siblings are buried for the session.
 */
export function applySiblingBurying(
	items: ReviewItem[],
	learningSteps: number[],
	relearningSteps: number[],
): ReviewItem[] {
	const groups = new Map<string, ReviewItem[]>();
	for (const item of items) {
		const list = groups.get(item.blockId) ?? [];
		list.push(item);
		groups.set(item.blockId, list);
	}

	const filteredQueue: ReviewItem[] = [];

	for (const siblings of groups.values()) {
		const winner = siblings[0];
		if (!winner) continue;

		if (siblings.length === 1) {
			filteredQueue.push(winner);
			continue;
		}

		siblings.sort((a, b) => {
			const rankA = getCardPriorityRank(a, learningSteps, relearningSteps);
			const rankB = getCardPriorityRank(b, learningSteps, relearningSteps);
			if (rankB !== rankA) {
				return rankB - rankA; // Higher rank first
			}

			// Tie-breaker 1: More overdue first
			if (a.dueAt !== b.dueAt) {
				return a.dueAt - b.dueAt;
			}

			// Tie-breaker 2: Forward before Reverse
			if (a.direction === 'forward' && b.direction === 'reverse') return -1;
			if (a.direction === 'reverse' && b.direction === 'forward') return 1;

			return a.cardId - b.cardId;
		});

		// Winner is queued for study; all other siblings are buried for today
		const sortedWinner = siblings[0];
		if (sortedWinner) {
			filteredQueue.push(sortedWinner);
		}
	}

	// Re-sort final queue by dueAt ASC
	filteredQueue.sort((a, b) => a.dueAt - b.dueAt);
	return filteredQueue;
}
