/**
 * Pure mathematical utilities for flashcard review progress and session metrics.
 */

export interface ProgressResult {
	currentCardNumber: number;
	progressPercent: number;
	progressText: string;
}

/**
 * Calculates current card number, progress percentage (0-100), and display string.
 */
export function calculateProgress(
	currentIndex: number,
	totalCards: number,
	isFinished: boolean,
): ProgressResult {
	if (totalCards <= 0) {
		return {
			currentCardNumber: 0,
			progressPercent: 0,
			progressText: '0 / 0',
		};
	}

	const boundedIndex = Math.max(0, Math.min(currentIndex, totalCards - 1));
	const currentCardNumber = isFinished ? totalCards : boundedIndex + 1;
	const progressPercent = isFinished
		? 100
		: Math.max(0, Math.min(100, Math.round((currentCardNumber / totalCards) * 100)));

	return {
		currentCardNumber,
		progressPercent,
		progressText: `${currentCardNumber} / ${totalCards}`,
	};
}

/**
 * Calculates accuracy / retention percentage (0-100) from remembered and studied counts.
 * Returns 100% when no cards have been studied yet.
 */
export function calculateRetention(studied: number, remembered: number): number {
	if (studied <= 0) return 100;
	const clampedRemembered = Math.max(0, Math.min(remembered, studied));
	return Math.max(0, Math.min(100, Math.round((clampedRemembered / studied) * 100)));
}
