import type { Database } from 'sql.js';

import type { CardBlockType, CardRecord, ReviewItem } from '../../types.js';
import { matchCardTags } from '../../utils/dashboardFilter.js';
import { applySiblingBurying } from '../../utils/siblingBurying.js';
import { getStudyDayCutoff, getStudyDayStart } from '../../utils/studyDay.js';
import { DEFAULT_LEARNING_STEPS, DEFAULT_RELEARNING_STEPS } from '../../utils/studySteps.js';
import { humanizeDue, humanizeRelative, mapState } from '../formatters.js';

function extractNoteTitle(filePath: string): string {
	const slashIndex = filePath.lastIndexOf('/');
	const base = slashIndex >= 0 ? filePath.slice(slashIndex + 1) : filePath;
	return base.endsWith('.md') ? base.slice(0, -3) : base;
}

function createReviewItem(
	row: Record<string, unknown>,
	filePath: string,
	direction: 'forward' | 'reverse' | null,
	blockType: CardBlockType,
	reversible: boolean,
	front: string,
	back: string,
	tags: string[],
): ReviewItem {
	let cachedDueHuman: string | undefined;
	let cachedLastPracticed: string | undefined;
	let cachedNoteTitle: string | undefined;

	return {
		cardId: row.card_id as number,
		blockId: row.block_id as string,
		get noteTitle(): string {
			if (cachedNoteTitle === undefined) {
				cachedNoteTitle = extractNoteTitle(filePath);
			}
			return cachedNoteTitle;
		},
		set noteTitle(val: string) {
			cachedNoteTitle = val;
		},
		notePath: filePath,
		direction,
		blockType,
		reversible,
		front,
		back,
		tags,
		state: mapState(row.state as number),
		stateNum: row.state as number,
		dueAt: row.due_at as number,
		get dueHuman(): string {
			if (cachedDueHuman === undefined) {
				cachedDueHuman = humanizeDue(row.due_at as number);
			}
			return cachedDueHuman;
		},
		set dueHuman(val: string) {
			cachedDueHuman = val;
		},
		stability: row.stability as number,
		difficulty: row.difficulty as number,
		reps: row.reps as number,
		lapses: row.lapses as number,
		learningStep: row.learning_step as number,
		relearningStep: row.relearning_step as number,
		lastReview: (row.last_review as number) || null,
		get lastPracticedHuman(): string {
			if (cachedLastPracticed === undefined) {
				cachedLastPracticed = row.last_review
					? humanizeRelative(row.last_review as number)
					: 'Never';
			}
			return cachedLastPracticed;
		},
		set lastPracticedHuman(val: string) {
			cachedLastPracticed = val;
		},
	};
}

export function getDueCards(
	db: Database,
	filterTags?: string[],
	rolloverHour = 4,
	learningSteps: number[] = DEFAULT_LEARNING_STEPS,
	relearningSteps: number[] = DEFAULT_RELEARNING_STEPS,
	burySiblings = true,
): ReviewItem[] {
	const cutoff = getStudyDayCutoff(rolloverHour);
	const items: ReviewItem[] = [];

	const query = `
		SELECT c.id as card_id, c.block_id, c.direction, c.state, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.last_review, c.learning_step, c.relearning_step,
		       b.file_path, b.block_type, b.reversible, b.front, b.back, b.tags, b.updated_at
		FROM cards c
		JOIN blocks b ON c.block_id = b.id
		WHERE c.due_at <= ?
		ORDER BY c.due_at ASC
	`;

	const stmt = db.prepare(query);
	stmt.bind([cutoff]);

	while (stmt.step()) {
		const row = stmt.getAsObject();
		const rawTags = row.tags as string;
		const tags = rawTags ? rawTags.split(' ').filter(Boolean) : [];

		if (filterTags && filterTags.length > 0) {
			if (!matchCardTags(tags, filterTags)) continue;
		}

		const filePath = row.file_path as string;
		const direction = (row.direction as 'forward' | 'reverse' | null) ?? null;
		const blockType = row.block_type as CardBlockType;
		const reversible = (row.reversible as number) === 1;

		let front = row.front as string;
		let back = row.back as string;
		if (direction === 'reverse') {
			front = row.back as string;
			back = row.front as string;
		}

		items.push(
			createReviewItem(row, filePath, direction, blockType, reversible, front, back, tags),
		);
	}
	stmt.free();

	if (burySiblings && items.length > 1) {
		return applySiblingBurying(items, learningSteps, relearningSteps);
	}

	return items;
}

export function getUpcomingDueCounts(
	db: Database,
	days = 90,
	nowMs = Date.now(),
	rolloverHour = 4,
): number[] {
	const counts = Array.from({ length: days }, () => 0);
	const studyDayStart = getStudyDayStart(rolloverHour, new Date(nowMs));
	const endMs = studyDayStart + days * 86400000;
	const query = `
		SELECT CAST((due_at - ?) / 86400000 AS INTEGER) as day_offset, COUNT(*) as count
		FROM cards
		WHERE due_at >= ? AND due_at < ?
		GROUP BY day_offset
	`;

	const stmt = db.prepare(query);
	stmt.bind([studyDayStart, studyDayStart, endMs]);

	while (stmt.step()) {
		const row = stmt.getAsObject();
		const offset = row.day_offset as number;
		const count = row.count as number;
		if (offset >= 0 && offset < days) {
			counts[offset] = count;
		}
	}
	stmt.free();
	return counts;
}

export function getSiblingCard(db: Database, cardId: number, blockId: string): CardRecord | null {
	const stmt = db.prepare(
		'SELECT id, block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step FROM cards WHERE block_id = ? AND id != ? LIMIT 1',
	);
	stmt.bind([blockId, cardId]);
	let sibling: CardRecord | null = null;
	if (stmt.step()) {
		const row = stmt.getAsObject();
		sibling = {
			id: row.id as number,
			block_id: row.block_id as string,
			direction: (row.direction as 'forward' | 'reverse' | null) ?? null,
			state: row.state as number,
			due_at: row.due_at as number,
			stability: row.stability as number,
			difficulty: row.difficulty as number,
			reps: row.reps as number,
			lapses: row.lapses as number,
			last_review: (row.last_review as number) || null,
			learning_step: row.learning_step as number,
			relearning_step: row.relearning_step as number,
		};
	}
	stmt.free();
	return sibling;
}

export function getAllCards(db: Database): ReviewItem[] {
	const items: ReviewItem[] = [];

	const query = `
		SELECT c.id as card_id, c.block_id, c.direction, c.state, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.last_review, c.learning_step, c.relearning_step,
		       b.file_path, b.block_type, b.reversible, b.front, b.back, b.tags, b.updated_at
		FROM cards c
		JOIN blocks b ON c.block_id = b.id
		ORDER BY c.due_at ASC
	`;

	const stmt = db.prepare(query);
	while (stmt.step()) {
		const row = stmt.getAsObject();
		const rawTags = row.tags as string;
		const tags = rawTags ? rawTags.split(' ').filter(Boolean) : [];
		const filePath = row.file_path as string;
		const direction = (row.direction as 'forward' | 'reverse' | null) ?? null;
		const blockType = row.block_type as CardBlockType;
		const reversible = (row.reversible as number) === 1;

		let front = row.front as string;
		let back = row.back as string;
		if (direction === 'reverse') {
			front = row.back as string;
			back = row.front as string;
		}

		items.push(
			createReviewItem(row, filePath, direction, blockType, reversible, front, back, tags),
		);
	}
	stmt.free();
	return items;
}

export function getUniqueTags(db: Database): string[] {
	const tagsSet = new Set<string>();
	const stmt = db.prepare("SELECT tags FROM blocks WHERE tags != '' AND tags IS NOT NULL");
	while (stmt.step()) {
		const rawTags = stmt.getAsObject().tags as string;
		if (rawTags) {
			const tags = rawTags.split(' ');
			for (let i = 0; i < tags.length; i++) {
				const t = tags[i]!.trim();
				if (t) tagsSet.add(t);
			}
		}
	}
	stmt.free();
	return Array.from(tagsSet).sort();
}
