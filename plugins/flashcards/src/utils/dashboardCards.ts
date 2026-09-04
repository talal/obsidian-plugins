import type { CardType, ReviewItem } from '../types.ts';
import { filterDashboardCard } from './dashboardFilter.ts';

export interface DashboardPromptItem {
	prompt_id: string;
	note_title: string;
	note_path: string;
	card_type: CardType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	forward?: ReviewItem;
	reverse?: ReviewItem;
}

/**
 * Groups raw ReviewItem cards by their parent prompt ID so bidirectional cards
 * appear as a single consolidated row in the dashboard table.
 */
export function groupCardsByPrompt(items: ReviewItem[]): DashboardPromptItem[] {
	const map = new Map<string, DashboardPromptItem>();

	for (const card of items) {
		const existing = map.get(card.prompt_id);
		if (!existing) {
			const isRev = card.direction === 'reverse';
			const item: DashboardPromptItem = {
				prompt_id: card.prompt_id,
				note_title: card.note_title,
				note_path: card.note_path,
				card_type: card.card_type,
				reversible: card.reversible,
				front: isRev ? card.back : card.front,
				back: isRev ? card.front : card.back,
				tags: card.tags,
				forward: isRev ? undefined : card,
				reverse: isRev ? card : undefined,
			};
			map.set(card.prompt_id, item);
		} else {
			if (card.direction === 'reverse') {
				existing.reverse = card;
			} else {
				existing.forward = card;
				existing.front = card.front;
				existing.back = card.back;
			}
		}
	}

	return Array.from(map.values());
}

/**
 * Filter a DashboardPromptItem against status filters and search queries.
 */
export function filterDashboardPrompt(
	item: DashboardPromptItem,
	statusFilter: 'all' | 'due' | 'new' | 'learning' | 'review',
	dueCutoff: number,
	searchQuery: string,
): boolean {
	// Status Filter
	if (statusFilter === 'due') {
		const now = Date.now();
		const isDue = (c: ReviewItem | undefined) => {
			if (!c) return false;
			if (c.state === 'new') return true;
			if (c.state === 'learning' || c.state === 'relearning') return c.due_at <= now;
			return c.due_at <= dueCutoff;
		};
		const fDue = isDue(item.forward);
		const rDue = isDue(item.reverse);
		if (!fDue && !rDue) return false;
	} else if (statusFilter === 'new') {
		const fNew = item.forward && item.forward.state === 'new';
		const rNew = item.reverse && item.reverse.state === 'new';
		if (!fNew && !rNew) return false;
	} else if (statusFilter === 'learning') {
		const fLearning = item.forward && item.forward.state === 'learning';
		const rLearning = item.reverse && item.reverse.state === 'learning';
		if (!fLearning && !rLearning) return false;
	} else if (statusFilter === 'review') {
		const fReview = item.forward && item.forward.state === 'review';
		const rReview = item.reverse && item.reverse.state === 'review';
		if (!fReview && !rReview) return false;
	}

	// Text & Tag Search (using forward card representation)
	const rep = item.forward ?? item.reverse;
	if (!rep) return false;
	return filterDashboardCard(rep, searchQuery);
}
