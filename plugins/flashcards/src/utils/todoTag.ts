import type { CardBlockType } from '../types.ts';

/**
 * Pure function to toggle #todo/card tag in Markdown content.
 * For block cards: adds to the question line before the divider, or removes from anywhere in the block.
 * For inline / cloze cards: adds or removes immediately before the trailing `^blockId`.
 */
export function toggleCardTodoInMarkdown(
	content: string,
	blockId: string,
	blockType: CardBlockType,
): string {
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

			// Check if already tagged anywhere in this block
			let hasTodo = false;
			for (let i = startIdx; i <= blockEnd; i++) {
				const currentLine = lines[i];
				if (currentLine && /(?:^|\s)#todo\/card(?:\s|$)/.test(currentLine)) {
					hasTodo = true;
					lines[i] = currentLine
						.replace(/(?:^|\s)#todo\/card(?:\s|$)/g, ' ')
						.replace(/\s+/g, ' ')
						.trimEnd();
				}
			}

			if (!hasTodo) {
				// Find the last non-empty line of the question before the divider
				let targetLineIdx = -1;
				for (let j = startIdx + 1; j < blockEnd; j++) {
					const t = lines[j]?.trim() ?? '';
					if (t === '...' || t === '. . .' || t === '---') {
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
				lines[targetLineIdx] = `${targetLine.trimEnd()} #todo/card`;
			}
		}
	} else {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			if (line.includes(`^${blockId}`)) {
				if (/(?:^|\s)#todo\/card(?:\s|$)/.test(line)) {
					lines[i] = line
						.replace(/(?:^|\s)#todo\/card(?:\s|$)/g, ' ')
						.replace(/\s+/g, ' ')
						.trimEnd();
				} else {
					const trimmedLine = line.trimEnd();
					const blockIdSuffix = `^${blockId}`;
					const idPos = trimmedLine.lastIndexOf(blockIdSuffix);
					if (idPos !== -1) {
						const before = trimmedLine.slice(0, idPos).trimEnd();
						const after = trimmedLine.slice(idPos);
						lines[i] = `${before} #todo/card ${after}`.trim();
					} else {
						lines[i] = `${trimmedLine} #todo/card`;
					}
				}
				break;
			}
		}
	}

	return lines.join('\n');
}
