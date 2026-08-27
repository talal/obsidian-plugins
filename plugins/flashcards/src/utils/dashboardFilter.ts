export interface FilterableCard {
	noteTitle: string;
	notePath: string;
	front: string;
	back: string;
	tags: string[];
}

export function matchCardTags(cardTags: string[], filterTags: string[]): boolean {
	if (!filterTags || filterTags.length === 0) return true;
	const normalizedFilters = filterTags.map((t) => t.toLowerCase().replace(/^#/, ''));
	const normalizedCardTags = cardTags.map((t) => t.toLowerCase().replace(/^#/, ''));
	return normalizedFilters.some((ft) =>
		normalizedCardTags.some((t) => t === ft || t.startsWith(ft + '/')),
	);
}

export function filterDashboardCard(card: FilterableCard, searchQuery: string): boolean {
	const rawQuery = searchQuery.trim();
	if (!rawQuery) return true;

	const tokens = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
	const tagTokens = tokens
		.filter((t) => t.startsWith('#'))
		.map((t) => t.slice(1))
		.filter(Boolean);
	const textTokens = tokens.filter((t) => !t.startsWith('#'));

	let matchesTags = true;
	if (tagTokens.length > 0) {
		matchesTags = matchCardTags(card.tags, tagTokens);
	}

	let matchesText = true;
	if (textTokens.length > 0) {
		// Text tokens filter by note title / note path or card content
		matchesText = textTokens.every(
			(tok) =>
				card.noteTitle.toLowerCase().includes(tok) ||
				card.notePath.toLowerCase().includes(tok) ||
				card.front.toLowerCase().includes(tok) ||
				card.back.toLowerCase().includes(tok),
		);
	}

	return matchesTags && matchesText;
}
