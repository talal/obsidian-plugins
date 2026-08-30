import type { ReviewItem } from '../types.ts';
import { filterDashboardCard } from './dashboardFilter.ts';

export interface DashboardBlockItem {
	blockId: string;
	noteTitle: string;
	notePath: string;
	blockType: 'inline' | 'block' | 'cloze';
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	forward?: ReviewItem;
	reverse?: ReviewItem;
}

/**
 * Groups raw ReviewItem cards by their parent block ID so bidirectional cards
 * appear as a single consolidated row in the dashboard table.
 */
export function groupCardsByBlock(items: ReviewItem[]): DashboardBlockItem[] {
	const map = new Map<string, DashboardBlockItem>();

	for (const card of items) {
		const existing = map.get(card.blockId);
		if (!existing) {
			const isRev = card.direction === 'reverse';
			const item: DashboardBlockItem = {
				blockId: card.blockId,
				noteTitle: card.noteTitle,
				notePath: card.notePath,
				blockType: card.blockType,
				reversible: card.reversible,
				front: isRev ? card.back : card.front,
				back: isRev ? card.front : card.back,
				tags: card.tags,
				forward: isRev ? undefined : card,
				reverse: isRev ? card : undefined,
			};
			map.set(card.blockId, item);
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
 * Filter a DashboardBlockItem against status filters and search queries.
 */
export function filterDashboardBlock(
	item: DashboardBlockItem,
	statusFilter: 'all' | 'due' | 'new' | 'learning' | 'review',
	dueCutoff: number,
	searchQuery: string,
): boolean {
	// Status Filter
	if (statusFilter === 'due') {
		const fDue = item.forward && item.forward.dueAt <= dueCutoff;
		const rDue = item.reverse && item.reverse.dueAt <= dueCutoff;
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
