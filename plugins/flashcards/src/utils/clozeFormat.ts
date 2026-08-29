/**
 * Formats cloze deletion markers for markdown rendering safely.
 * Replaces {{cloze}} markers with masked spans when unrevealed, or
 * sanitized highlighted marks when revealed.
 */
export function formatClozeText(text: string, isRevealed: boolean): string {
	if (isRevealed) {
		return text.replace(/\{\{([^}]+)\}\}/g, (_match, group1: string) => {
			const escaped = group1.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			return `<mark class="fc-cloze-revealed">${escaped}</mark>`;
		});
	} else {
		return text.replace(/\{\{([^}]+)\}\}/g, '<span class="fc-cloze-mask">[ ... ]</span>');
	}
}
