import type { ReviewState } from '../types.js';

export function mapState(stateNum: number): ReviewState {
	switch (stateNum) {
		case 1:
			return 'learning';
		case 2:
			return 'review';
		case 3:
			return 'relearning';
		default:
			return 'new';
	}
}

export function unmapState(state: ReviewState): number {
	switch (state) {
		case 'learning':
			return 1;
		case 'review':
			return 2;
		case 'relearning':
			return 3;
		default:
			return 0;
	}
}

export function humanizeDue(dueMs: number, now = Date.now()): string {
	const diff = dueMs - now;
	if (diff <= 0) return 'Due now';
	const days = Math.round(diff / (1000 * 60 * 60 * 24));
	if (days === 0) return 'Today';
	if (days === 1) return 'Tomorrow';
	return `In ${days} days`;
}

export function humanizeRelative(ms: number, now = Date.now()): string {
	const diff = now - ms;
	if (diff < 60 * 1000) return 'Just now';
	const mins = Math.floor(diff / (1000 * 60));
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
