import { type CardBlockType, DEFAULT_LEECH_TAG } from '../types.ts';

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTag(tag: string): string {
	const trimmed = tag.trim();
	return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

/**
 * Returns a RegExp matching the exact tag with boundary safety.
 * Matches tag preceded by start of string or whitespace, and followed by whitespace, punctuation, or end of string.
 * Prevents `#card/leech` from matching `#card/leech2` or `#mycard/leech`.
 */
function createTagRegex(tag: string, global = false): RegExp {
	const normalized = normalizeTag(tag);
	const flags = global ? 'g' : '';
	return new RegExp(`(?:^|\\s)${escapeRegex(normalized)}(?=[\\s.,;:!?)]|$)`, flags);
}

/**
 * Pure function to check if a specific tag exists on a card in Markdown content.
 */
export function hasCardTag(
	content: string,
	blockId: string,
	blockType: CardBlockType,
	tag: string,
): boolean {
	const normalized = normalizeTag(tag);
	const lines = content.split('\n');

	if (blockType === 'block') {
		const startIdx = lines.findIndex(
			(l) => l.includes('%%') && l.includes('card-start') && l.includes(`id=${blockId}`),
		);
		if (startIdx === -1) return false;
		const endIdx = lines.findIndex(
			(l, idx) => idx > startIdx && l.includes('%%') && l.includes('card-end'),
		);
		const blockEnd = endIdx !== -1 ? endIdx : lines.length - 1;

		for (let i = startIdx; i <= blockEnd; i++) {
			const currentLine = lines[i];
			if (currentLine && createTagRegex(normalized, false).test(currentLine)) {
				return true;
			}
		}
		return false;
	}

	for (const line of lines) {
		if (!line) continue;
		if (line.includes(`^${blockId}`) && createTagRegex(normalized, false).test(line)) {
			return true;
		}
	}
	return false;
}

/**
 * Pure function to add a tag to a card in Markdown content at the canonical location:
 * - For inline / cloze cards: immediately before the trailing `^blockId` token at the end of the line.
 * - For block cards: at the end of the last question line before the `...` (or `---`) divider.
 *
 * Idempotent: If the tag already exists on the card, returns content unchanged.
 */
export function addCardTag(
	content: string,
	blockId: string,
	blockType: CardBlockType,
	tag: string,
): string {
	const normalized = normalizeTag(tag);
	if (hasCardTag(content, blockId, blockType, normalized)) {
		return content;
	}

	const lines = content.split('\n');

	if (blockType === 'block') {
		const startIdx = lines.findIndex(
			(l) => l.includes('%%') && l.includes('card-start') && l.includes(`id=${blockId}`),
		);
		if (startIdx !== -1) {
			const endIdx = lines.findIndex(
				(l, idx) => idx > startIdx && l.includes('%%') && l.includes('card-end'),
			);
			const blockEnd = endIdx !== -1 ? endIdx : lines.length - 1;

			// Find the last non-empty line of the question before the divider
			let targetLineIdx = -1;
			for (let j = startIdx + 1; j < blockEnd; j++) {
				const t = (lines[j] ?? '')
					.replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
					.trim();
				if (t === '::' || t === ':::') {
					break;
				}
				if (t.length > 0) {
					targetLineIdx = j;
				}
			}
			if (targetLineIdx === -1) {
				targetLineIdx = startIdx + 1 < lines.length ? startIdx + 1 : startIdx;
			}
			const targetLine = lines[targetLineIdx] ?? '';
			lines[targetLineIdx] = `${targetLine.trimEnd()} ${normalized}`;
		}
	} else {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			if (line.includes(`^${blockId}`)) {
				const trimmedLine = line.trimEnd();
				const blockIdSuffix = `^${blockId}`;
				const idPos = trimmedLine.lastIndexOf(blockIdSuffix);
				if (idPos !== -1) {
					const before = trimmedLine.slice(0, idPos).trimEnd();
					const after = trimmedLine.slice(idPos);
					lines[i] = before ? `${before} ${normalized} ${after}` : `${normalized} ${after}`;
				} else {
					lines[i] = `${trimmedLine} ${normalized}`;
				}
				break;
			}
		}
	}

	return lines.join('\n');
}

/**
 * Pure function to remove a tag from a card in Markdown content.
 * Cleans up extraneous surrounding spaces without touching block IDs or indentation.
 */
export function removeCardTag(
	content: string,
	blockId: string,
	blockType: CardBlockType,
	tag: string,
): string {
	const normalized = normalizeTag(tag);
	const lines = content.split('\n');

	if (blockType === 'block') {
		const startIdx = lines.findIndex(
			(l) => l.includes('%%') && l.includes('card-start') && l.includes(`id=${blockId}`),
		);
		if (startIdx !== -1) {
			const endIdx = lines.findIndex(
				(l, idx) => idx > startIdx && l.includes('%%') && l.includes('card-end'),
			);
			const blockEnd = endIdx !== -1 ? endIdx : lines.length - 1;

			for (let i = startIdx; i <= blockEnd; i++) {
				const currentLine = lines[i];
				if (currentLine && createTagRegex(normalized, false).test(currentLine)) {
					lines[i] = currentLine
						.replace(createTagRegex(normalized, true), ' ')
						.replace(/[ \t]+/g, ' ')
						.trimEnd();
				}
			}
		}
	} else {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			if (line.includes(`^${blockId}`)) {
				if (createTagRegex(normalized, false).test(line)) {
					const blockIdSuffix = `^${blockId}`;
					const idPos = line.lastIndexOf(blockIdSuffix);
					if (idPos !== -1) {
						const before = line
							.slice(0, idPos)
							.replace(createTagRegex(normalized, true), ' ')
							.replace(/[ \t]+/g, ' ')
							.trimEnd();
						const after = line.slice(idPos);
						lines[i] = before ? `${before} ${after}` : after;
					} else {
						lines[i] = line
							.replace(createTagRegex(normalized, true), ' ')
							.replace(/[ \t]+/g, ' ')
							.trimEnd();
					}
				}
				break;
			}
		}
	}

	return lines.join('\n');
}

/**
 * Pure function to toggle a specific tag on a card in Markdown content.
 */
export function toggleCardTag(
	content: string,
	blockId: string,
	blockType: CardBlockType,
	tag: string,
): string {
	if (hasCardTag(content, blockId, blockType, tag)) {
		return removeCardTag(content, blockId, blockType, tag);
	}
	return addCardTag(content, blockId, blockType, tag);
}

/**
 * Convenience aliases for specific tag workflows.
 */
export function toggleCardTodoInMarkdown(
	content: string,
	blockId: string,
	blockType: CardBlockType,
): string {
	return toggleCardTag(content, blockId, blockType, '#card/todo');
}

export function addCardLeechTagInMarkdown(
	content: string,
	blockId: string,
	blockType: CardBlockType,
	tag = DEFAULT_LEECH_TAG,
): string {
	return addCardTag(content, blockId, blockType, tag);
}

/**
 * Checks whether a card has reached the leech threshold.
 * Triggers at threshold T, and every ceil(T/2) lapses after that.
 */
export function isLeechThresholdMet(lapses: number, threshold = 4): boolean {
	if (threshold <= 0) return false;
	const halfThreshold = Math.max(1, Math.ceil(threshold / 2));
	return lapses >= threshold && (lapses - threshold) % halfThreshold === 0;
}
