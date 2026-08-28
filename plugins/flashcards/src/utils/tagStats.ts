import type { ReviewItem } from '../types.ts';

export interface TagDeckStat {
	tag: string;
	total: number;
	due: number;
	newCards: number;
}

/**
 * Computes deck statistics (total, due, new) grouped by tag from a collection of cards.
 * Sorted by due count descending, then tag name alphabetically.
 */
export function computeTagDeckStats(items: ReviewItem[], dueCutoff: number): TagDeckStat[] {
	const map = new Map<string, { total: number; due: number; newCards: number }>();

	for (const card of items) {
		const isDue = card.dueAt <= dueCutoff;
		const isNew = card.state === 'new';

		for (const t of card.tags) {
			let entry = map.get(t);
			if (!entry) {
				entry = { total: 0, due: 0, newCards: 0 };
				map.set(t, entry);
			}
			entry.total++;
			if (isDue) entry.due++;
			if (isNew) entry.newCards++;
		}
	}

	return Array.from(map.entries())
		.map(([tag, stat]) => ({ tag, ...stat }))
		.sort((a, b) => {
			if (b.due !== a.due) return b.due - a.due;
			return a.tag.localeCompare(b.tag);
		});
}
