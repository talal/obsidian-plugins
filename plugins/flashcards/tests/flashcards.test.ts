import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { describe, it, expect, beforeAll } from 'vitest';

import {
	DatabaseManager,
	getStudyDayCutoff,
	getStudyDayKey,
	getStudyDayStart,
} from '../src/db/DatabaseManager.ts';
import {
	deduplicateBlockIds,
	generateBlockId,
	resolveNoteIdCollision,
	stampBlockId,
} from '../src/scanner/identity.ts';
import { DEFAULT_SETTINGS, type ParsedBlock } from '../src/types.ts';
import { filterDashboardCard } from '../src/utils/dashboardFilter.ts';
import { calculateProgress, calculateRetention } from '../src/utils/reviewMetrics.ts';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../src/utils/studySteps.ts';

describe('Study Day Boundary Calculation (4:00 AM Rollover)', () => {
	it('calculates start and cutoff for evening reviews (e.g. 21:00)', () => {
		// 9:00 PM on May 15
		const testTime = new Date(2026, 4, 15, 21, 0, 0, 0);
		const startMs = getStudyDayStart(4, testTime);
		const cutoffMs = getStudyDayCutoff(4, testTime);

		const startDate = new Date(startMs);
		const cutoffDate = new Date(cutoffMs);

		expect(startDate.getDate()).toBe(15);
		expect(startDate.getHours()).toBe(4);

		expect(cutoffDate.getDate()).toBe(16);
		expect(cutoffDate.getHours()).toBe(4);
	});

	it('calculates start and cutoff for late-night reviews before rollover (e.g. 02:30 AM)', () => {
		// 2:30 AM on May 16 (belongs to May 15 study day)
		const testTime = new Date(2026, 4, 16, 2, 30, 0, 0);
		const startMs = getStudyDayStart(4, testTime);
		const cutoffMs = getStudyDayCutoff(4, testTime);

		const startDate = new Date(startMs);
		const cutoffDate = new Date(cutoffMs);

		expect(startDate.getDate()).toBe(15);
		expect(startDate.getHours()).toBe(4);

		expect(cutoffDate.getDate()).toBe(16);
		expect(cutoffDate.getHours()).toBe(4);
	});

	it('calculates start and cutoff right after rollover (e.g. 04:01 AM)', () => {
		// 4:01 AM on May 16 (belongs to May 16 study day)
		const testTime = new Date(2026, 4, 16, 4, 1, 0, 0);
		const startMs = getStudyDayStart(4, testTime);
		const cutoffMs = getStudyDayCutoff(4, testTime);

		const startDate = new Date(startMs);
		const cutoffDate = new Date(cutoffMs);

		expect(startDate.getDate()).toBe(16);
		expect(startDate.getHours()).toBe(4);

		expect(cutoffDate.getDate()).toBe(17);
		expect(cutoffDate.getHours()).toBe(4);
	});

	it('assigns reviews before rollover to the previous local study day', () => {
		const beforeRollover = new Date(2026, 4, 16, 3, 59, 0, 0).getTime();
		const afterRollover = new Date(2026, 4, 16, 4, 0, 0, 0).getTime();

		expect(getStudyDayKey(beforeRollover, 4)).toBe('2026-05-15');
		expect(getStudyDayKey(afterRollover, 4)).toBe('2026-05-16');
	});
});

describe('FSRS study step parsing', () => {
	it('parses supported minute, hour, and day units', () => {
		expect(parseStudySteps('10m 9h 2d', DEFAULT_LEARNING_STEPS)).toEqual([
			10 * 60 * 1000,
			9 * 60 * 60 * 1000,
			2 * 24 * 60 * 60 * 1000,
		]);
	});

	it('uses defaults when no valid step is configured', () => {
		expect(parseStudySteps('not-a-step', DEFAULT_LEARNING_STEPS)).toEqual(DEFAULT_LEARNING_STEPS);
		expect(parseStudySteps('', DEFAULT_RELEARNING_STEPS)).toEqual(DEFAULT_RELEARNING_STEPS);
	});
});

describe('Dashboard Search & Tag Filter Logic', () => {
	const sampleCards = [
		{
			noteTitle: 'Geography Demo',
			notePath: 'Geography Demo.md',
			front: 'Capital of France?',
			back: 'Paris',
			tags: ['geography', 'capitals'],
		},
		{
			noteTitle: 'Computer Science',
			notePath: 'Computer Science.md',
			front: 'What is %rax?',
			back: 'Return register',
			tags: ['cs', 'assembly'],
		},
		{
			noteTitle: 'German Vocab',
			notePath: 'German Vocab.md',
			front: 'die Entscheidung',
			back: 'the decision',
			tags: ['german', 'vocab'],
		},
	];

	it('filters by multiple tags with OR matching (e.g. #cs #geography)', () => {
		const result = sampleCards.filter((c) => filterDashboardCard(c, '#cs #geography'));
		expect(result).toHaveLength(2);
		expect(result.map((c) => c.noteTitle)).toEqual(['Geography Demo', 'Computer Science']);
	});

	it('filters by note text query (e.g. "German")', () => {
		const result = sampleCards.filter((c) => filterDashboardCard(c, 'German'));
		expect(result).toHaveLength(1);
		expect(result[0]?.noteTitle).toBe('German Vocab');
	});

	it('combines text search with tag filter (e.g. "France #geography")', () => {
		const match = sampleCards.filter((c) => filterDashboardCard(c, 'France #geography'));
		expect(match).toHaveLength(1);
		expect(match[0]?.noteTitle).toBe('Geography Demo');

		const nonMatch = sampleCards.filter((c) => filterDashboardCard(c, 'France #cs'));
		expect(nonMatch).toHaveLength(0);
	});

	it('matches hierarchical tags and does not over-match substring tags', () => {
		const cards = [
			{
				noteTitle: 'Art History',
				notePath: 'Art.md',
				front: 'Renaissance',
				back: '14th-17th century',
				tags: ['art', 'art/renaissance'],
			},
			{
				noteTitle: 'Cardiology',
				notePath: 'Cardio.md',
				front: 'Heart function',
				back: 'Pumps blood',
				tags: ['heart', 'cardiology'],
			},
		];

		// #art should match Art History (#art, #art/renaissance) but NOT Cardiology (#heart)
		const artMatches = cards.filter((c) => filterDashboardCard(c, '#art'));
		expect(artMatches).toHaveLength(1);
		expect(artMatches[0]?.noteTitle).toBe('Art History');

		// #art/renaissance matches Art History
		const subtagMatches = cards.filter((c) => filterDashboardCard(c, '#art/renaissance'));
		expect(subtagMatches).toHaveLength(1);
		expect(subtagMatches[0]?.noteTitle).toBe('Art History');
	});

	it('handles non-English (Arabic / Urdu) filenames, notes, and search queries', () => {
		const cards = [
			{
				noteTitle: 'پنجابی دا ذخیرہ الفاظ',
				notePath: 'Notes/پنجابی دا ذخیرہ الفاظ.md',
				front: 'پانی',
				back: 'Water',
				tags: ['پنجابی', 'ذخیرہ'],
			},
			{
				noteTitle: 'English Note',
				notePath: 'Notes/English.md',
				front: 'Hello',
				back: 'World',
				tags: ['english'],
			},
		];

		const matchByUrduTag = cards.filter((c) => filterDashboardCard(c, '#پنجابی'));
		expect(matchByUrduTag).toHaveLength(1);
		expect(matchByUrduTag[0]?.noteTitle).toBe('پنجابی دا ذخیرہ الفاظ');

		const matchByUrduText = cards.filter((c) => filterDashboardCard(c, 'پانی'));
		expect(matchByUrduText).toHaveLength(1);
		expect(matchByUrduText[0]?.front).toBe('پانی');
	});
});

describe('Collision Detection & Self-Healing Identity Logic (Production Modules)', () => {
	it('generates 6-character hex block IDs', () => {
		const id = generateBlockId();
		expect(id).toMatch(/^[0-9a-f]{6}$/);
	});

	it('detects duplicate note UUID across distinct file paths in the same scan', () => {
		const noteAUuid = 'df51ff8d-c34b-4137-b72d-2127ff9c56bd';
		const registeredNoteIds = new Map<string, string>([[noteAUuid, 'Note A.md']]);

		const res = resolveNoteIdCollision({
			noteId: noteAUuid,
			filePath: 'Note B.md',
			conflictingPathInVault: registeredNoteIds.get(noteAUuid),
		});

		expect(res.idCollisionFixed).toBe(true);
		expect(res.noteId).toBeUndefined();
	});

	it('distinguishes note rename from duplicate collision on disk', () => {
		const noteUuid = 'df51ff8d-c34b-4137-b72d-2127ff9c56bd';

		// Case 1: Rename (Old path does not exist on disk)
		const renameRes = resolveNoteIdCollision({
			noteId: noteUuid,
			filePath: 'Note New.md',
			conflictingPathInDb: 'Note Old.md',
			oldFileExistsOnDisk: false,
		});
		expect(renameRes.idCollisionFixed).toBe(false);
		expect(renameRes.noteId).toBe(noteUuid);

		// Case 2: Duplicate file on disk (Old path still exists on disk)
		const duplicateRes = resolveNoteIdCollision({
			noteId: noteUuid,
			filePath: 'Note New.md',
			conflictingPathInDb: 'Note Old.md',
			oldFileExistsOnDisk: true,
		});
		expect(duplicateRes.idCollisionFixed).toBe(true);
		expect(duplicateRes.noteId).toBeUndefined();
	});

	it('detects duplicate block IDs inside the same note and flags them for regeneration', () => {
		const blocks = [
			{ block_id: '8a1b2c', card_type: 'single', line_start: 5 },
			{ block_id: '8a1b2c', card_type: 'single', line_start: 10 },
			{ block_id: 'c9f4d1', card_type: 'single', line_start: 15 },
		];

		const { duplicateBlocksFixed } = deduplicateBlockIds(blocks);
		expect(duplicateBlocksFixed).toBe(1);
		expect(blocks[0]?.block_id).toBe('8a1b2c');
		expect(blocks[1]?.block_id).toBe('');
		expect(blocks[2]?.block_id).toBe('c9f4d1');
	});

	it('correctly stamps block ID onto block and inline markdown lines', () => {
		expect(stampBlockId('%% card-start %%', 'block', 'abcdef')).toBe('%% card-start id=abcdef %%');
		expect(stampBlockId('%% card-start id=old123 %%', 'block', 'abcdef')).toBe(
			'%% card-start id=abcdef %%',
		);
		expect(stampBlockId('Question :: Answer', 'inline_forward', 'abcdef')).toBe(
			'Question :: Answer ^abcdef',
		);
		expect(stampBlockId('Question :: Answer ^old123', 'inline_forward', 'abcdef')).toBe(
			'Question :: Answer ^abcdef',
		);
	});
});

describe('DatabaseManager SQLite Pipeline Integration', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
	});

	function createFreshDb(): { db: DatabaseManager; rawDb: any } {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		return { db, rawDb };
	}

	it('creates and updates note blocks and directional review items', () => {
		const { db } = createFreshDb();
		const noteId = 'note-uuid-1';
		db.upsertNote(noteId, 'Notes/Biology.md', Date.now());

		const parsedBlocks: ParsedBlock[] = [
			{
				block_id: 'blk001',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Mitochondria function?',
				back_raw: 'Powerhouse of the cell',
				tags: ['biology', 'cells'],
				content_hash: 'hash-001',
				line_start: 1,
				line_end: 1,
			},
			{
				block_id: 'blk002',
				card_type: 'block',
				direction: 'both',
				front_raw: 'DNA',
				back_raw: 'Deoxyribonucleic acid',
				tags: ['biology', 'genetics'],
				content_hash: 'hash-002',
				line_start: 3,
				line_end: 7,
			},
		];

		db.syncNoteBlocks(noteId, parsedBlocks);

		const cards = db.getAllCards();
		expect(cards).toHaveLength(3); // 1 forward + 2 (forward & reverse for both)

		const mitoItem = cards.find((c) => c.blockId === 'blk001');
		expect(mitoItem).toBeDefined();
		expect(mitoItem?.direction).toBe('forward');
		expect(mitoItem?.tags).toEqual(['biology', 'cells']);

		const dnaForward = cards.find((c) => c.blockId === 'blk002' && c.direction === 'forward');
		const dnaReverse = cards.find((c) => c.blockId === 'blk002' && c.direction === 'reverse');
		expect(dnaForward).toBeDefined();
		expect(dnaReverse).toBeDefined();
		expect(dnaReverse?.front).toBe('Deoxyribonucleic acid');
		expect(dnaReverse?.back).toBe('DNA');
	});

	it('prunes obsolete directional items when card direction changes from both to forward', () => {
		const { db } = createFreshDb();
		const noteId = 'note-uuid-2';
		db.upsertNote(noteId, 'Notes/Chemistry.md', Date.now());

		// Initially bidirectional
		db.syncNoteBlocks(noteId, [
			{
				block_id: 'chem01',
				card_type: 'block',
				direction: 'both',
				front_raw: 'NaCl',
				back_raw: 'Sodium Chloride',
				tags: ['chemistry'],
				content_hash: 'hash-chem-1',
				line_start: 1,
				line_end: 5,
			},
		]);
		expect(db.getAllCards()).toHaveLength(2);

		// User edits header to direction=forward
		db.syncNoteBlocks(noteId, [
			{
				block_id: 'chem01',
				card_type: 'block',
				direction: 'forward',
				front_raw: 'NaCl',
				back_raw: 'Sodium Chloride',
				tags: ['chemistry'],
				content_hash: 'hash-chem-2',
				line_start: 1,
				line_end: 5,
			},
		]);

		const remainingCards = db.getAllCards();
		expect(remainingCards).toHaveLength(1);
		expect(remainingCards[0]?.direction).toBe('forward');
	});

	it('records review logs and updates card metrics accurately', () => {
		const { db } = createFreshDb();
		const noteId = 'note-uuid-3';
		db.upsertNote(noteId, 'Notes/History.md', Date.now());
		db.syncNoteBlocks(noteId, [
			{
				block_id: 'hist01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Year WW2 ended?',
				back_raw: '1945',
				tags: ['history'],
				content_hash: 'hash-hist-1',
				line_start: 1,
				line_end: 1,
			},
		]);

		const cards = db.getAllCards();
		const card = cards[0]!;
		expect(card.state).toBe('new');
		expect(card.reps).toBe(0);
		expect(card.lapses).toBe(0);

		const sessionId = db.createSession('history');
		const now = Date.now();
		const nextDue = now + 24 * 60 * 60 * 1000;

		db.recordReview(
			card.id,
			3, // Rating::Good
			'review',
			nextDue,
			2.5, // stability
			4.0, // difficulty
			1, // newReps
			0, // newLapses
			0,
			0,
			sessionId,
		);
		db.finishSession(sessionId, 1, 0, 1);

		const updatedCards = db.getAllCards();
		const updated = updatedCards[0]!;
		expect(updated.state).toBe('review');
		expect(updated.reps).toBe(1);
		expect(updated.lapses).toBe(0);
		expect(updated.stability).toBe(2.5);
		expect(updated.difficulty).toBe(4.0);
		expect(updated.due).toBe(nextDue);
	});

	it('computes dashboard stats including streak and retention', () => {
		const { db } = createFreshDb();
		const noteId = 'note-uuid-4';
		db.upsertNote(noteId, 'Notes/Physics.md', Date.now());
		db.syncNoteBlocks(noteId, [
			{
				block_id: 'phys01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Speed of light?',
				back_raw: '3x10^8 m/s',
				tags: ['physics'],
				content_hash: 'hash-phys-1',
				line_start: 1,
				line_end: 1,
			},
		]);

		const card = db.getAllCards()[0]!;
		const sessionId = db.createSession('physics');

		db.recordReview(
			card.id,
			3, // Good
			'review',
			Date.now() + 86400000,
			2.5,
			4.0,
			1,
			0,
			0,
			0,
			sessionId,
		);
		db.finishSession(sessionId, 1, 0, 1);

		const stats = db.getDashboardStats(4);
		expect(stats.totalCards).toBe(1);
		expect(stats.studiedToday).toBe(1);
		expect(stats.studyStreak).toBe(1);
		expect(stats.dailyRetention).toBe(100);
	});

	it('preserves review logs for optimizer and computes delta_t via LAG window function', () => {
		const { db, rawDb } = createFreshDb();
		const noteId = 'note-uuid-5';
		db.upsertNote(noteId, 'Notes/Math.md', Date.now());
		db.syncNoteBlocks(noteId, [
			{
				block_id: 'math01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Derivative of sin(x)?',
				back_raw: 'cos(x)',
				tags: ['math'],
				content_hash: 'hash-math-1',
				line_start: 1,
				line_end: 1,
			},
		]);

		const card = db.getAllCards()[0]!;
		const sessionId = db.createSession('math');

		const t0 = 1700000000000;
		const t1 = t0 + 86400000; // 1 day later
		const t2 = t1 + 3 * 86400000; // 3 days later

		// Simulate review logs insertion
		db.recordReview(card.id, 3, 'learning', t1, 1.0, 5.0, 1, 0, 0, 0, sessionId);
		// Update review_time directly to match t0
		rawDb.run('UPDATE review_logs SET review_time = ? WHERE id = 1', [t0]);

		db.recordReview(card.id, 3, 'review', t2, 2.5, 4.5, 2, 0, 0, 0, sessionId);
		rawDb.run('UPDATE review_logs SET review_time = ? WHERE id = 2', [t1]);

		db.recordReview(card.id, 4, 'review', t2 + 86400000, 6.0, 4.0, 3, 0, 0, 0, sessionId);
		rawDb.run('UPDATE review_logs SET review_time = ? WHERE id = 3', [t2]);

		const optLogs = db.getReviewLogsForOptimization();
		expect(optLogs).toHaveLength(3);
		expect(optLogs[0]?.delta_t).toBe(0); // first review delta_t is 0
		expect(optLogs[1]?.delta_t).toBe(1); // 1 day delta
		expect(optLogs[2]?.delta_t).toBe(3); // 3 days delta
	});

	it('prunes deleted notes and cascade prunes blocks and review items', () => {
		const { db } = createFreshDb();
		db.upsertNote('note-1', 'Notes/Keep.md', Date.now());
		db.upsertNote('note-2', 'Notes/Delete.md', Date.now());

		db.syncNoteBlocks('note-1', [
			{
				block_id: 'b1',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Q1',
				back_raw: 'A1',
				tags: [],
				content_hash: 'h1',
				line_start: 1,
				line_end: 1,
			},
		]);
		db.syncNoteBlocks('note-2', [
			{
				block_id: 'b2',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Q2',
				back_raw: 'A2',
				tags: [],
				content_hash: 'h2',
				line_start: 1,
				line_end: 1,
			},
		]);

		expect(db.getAllCards()).toHaveLength(2);

		// Only 'Notes/Keep.md' still exists in vault
		db.pruneDeletedNotes(new Set(['Notes/Keep.md']));

		const remaining = db.getAllCards();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.notePath).toBe('Notes/Keep.md');
	});

	it('filters due review items case-insensitively with tag prefixes', () => {
		const { db } = createFreshDb();
		const noteId = 'note-tags-1';
		db.upsertNote(noteId, 'Notes/Languages.md', Date.now());

		db.syncNoteBlocks(noteId, [
			{
				block_id: 'tag01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Hallo',
				back_raw: 'Hello',
				tags: ['German', 'Vocab/Level1'],
				content_hash: 'hash-g1',
				line_start: 1,
				line_end: 1,
			},
			{
				block_id: 'tag02',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Bonjour',
				back_raw: 'Hello',
				tags: ['French'],
				content_hash: 'hash-f1',
				line_start: 3,
				line_end: 3,
			},
		]);

		// Lowercase filter matches uppercase tag
		const germanDue = db.getDueReviewItems(['german']);
		expect(germanDue).toHaveLength(1);
		expect(germanDue[0]?.blockId).toBe('tag01');

		// Parent tag filter matches hierarchical subtag
		const vocabDue = db.getDueReviewItems(['#vocab']);
		expect(vocabDue).toHaveLength(1);
		expect(vocabDue[0]?.blockId).toBe('tag01');

		// Non-matching tag
		const spanishDue = db.getDueReviewItems(['spanish']);
		expect(spanishDue).toHaveLength(0);
	});

	it('excludes cards from ignored notes and preserves their data for un-ignoring', () => {
		const { db } = createFreshDb();
		const noteActive = 'note-active';
		const noteIgnored = 'note-ignored';

		db.upsertNote(noteActive, 'Notes/Active.md', Date.now(), 0);
		db.upsertNote(noteIgnored, 'Notes/Ignored.md', Date.now(), 1);

		db.syncNoteBlocks(noteActive, [
			{
				block_id: 'act01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Active Question',
				back_raw: 'Active Answer',
				tags: ['active'],
				content_hash: 'hash-act',
				line_start: 1,
				line_end: 1,
			},
		]);

		db.syncNoteBlocks(noteIgnored, [
			{
				block_id: 'ign01',
				card_type: 'inline_forward',
				direction: 'forward',
				front_raw: 'Ignored Question',
				back_raw: 'Ignored Answer',
				tags: ['ignored-tag'],
				content_hash: 'hash-ign',
				line_start: 1,
				line_end: 1,
			},
		]);

		// Ignored cards should NOT be returned by getAllCards, getDueReviewItems, or getUniqueTags
		expect(db.getAllCards()).toHaveLength(1);
		expect(db.getAllCards()[0]?.blockId).toBe('act01');
		expect(db.getDueReviewItems()).toHaveLength(1);
		expect(db.getUniqueTags()).toEqual(['active']);

		const stats = db.getDashboardStats();
		expect(stats.totalCards).toBe(1);
		expect(stats.newCards).toBe(1);

		// Un-ignoring the note restores cards to queues with zero data loss
		db.setNoteIgnoredByPath('Notes/Ignored.md', false);
		expect(db.getAllCards()).toHaveLength(2);
		expect(db.getDueReviewItems()).toHaveLength(2);
		expect(db.getUniqueTags()).toEqual(['active', 'ignored-tag']);
		expect(db.getDashboardStats().totalCards).toBe(2);
	});
});

describe('Settings Defaults & Validation', () => {
	it('provides default empty settings', () => {
		expect(DEFAULT_SETTINGS).toEqual({});
	});
});

describe('Review Counter & Progress Calculation Metrics', () => {
	it('handles empty queue (0 cards) without division by zero', () => {
		const resActive = calculateProgress(0, 0, false);
		expect(resActive).toEqual({
			currentCardNumber: 0,
			progressPercent: 0,
			progressText: '0 / 0',
		});

		const resFinished = calculateProgress(0, 0, true);
		expect(resFinished).toEqual({
			currentCardNumber: 0,
			progressPercent: 0,
			progressText: '0 / 0',
		});
	});

	it('calculates single-card queue accurately across lifecycle', () => {
		// Active card 1
		const active = calculateProgress(0, 1, false);
		expect(active).toEqual({
			currentCardNumber: 1,
			progressPercent: 0,
			progressText: '1 / 1',
		});

		// Session finished
		const finished = calculateProgress(0, 1, true);
		expect(finished).toEqual({
			currentCardNumber: 1,
			progressPercent: 100,
			progressText: '1 / 1',
		});
	});

	it('calculates multi-card queue progression and locks to 100% on completion', () => {
		const total = 7;

		// Card 1
		expect(calculateProgress(0, total, false)).toEqual({
			currentCardNumber: 1,
			progressPercent: 0,
			progressText: '1 / 7',
		});

		// Card 2
		expect(calculateProgress(1, total, false)).toEqual({
			currentCardNumber: 2,
			progressPercent: 14,
			progressText: '2 / 7',
		});

		// Card 4 (midpoint)
		expect(calculateProgress(3, total, false)).toEqual({
			currentCardNumber: 4,
			progressPercent: 43,
			progressText: '4 / 7',
		});

		// Card 7 (last card active)
		expect(calculateProgress(6, total, false)).toEqual({
			currentCardNumber: 7,
			progressPercent: 86,
			progressText: '7 / 7',
		});

		// Card 7 completed (session finished) - must stay 7 / 7 and lock to 100%
		expect(calculateProgress(6, total, true)).toEqual({
			currentCardNumber: 7,
			progressPercent: 100,
			progressText: '7 / 7',
		});
	});

	it('clamps out-of-bounds indices safely', () => {
		// Negative index
		expect(calculateProgress(-5, 5, false)).toEqual({
			currentCardNumber: 1,
			progressPercent: 0,
			progressText: '1 / 5',
		});

		// Over-bounds index
		expect(calculateProgress(99, 5, false)).toEqual({
			currentCardNumber: 5,
			progressPercent: 80,
			progressText: '5 / 5',
		});
	});

	it('calculates session retention accurately with robust edge handling', () => {
		// 0 studied -> default 100%
		expect(calculateRetention(0, 0)).toBe(100);

		// 1 remembered out of 1 -> 100%
		expect(calculateRetention(1, 1)).toBe(100);

		// 0 remembered out of 1 -> 0%
		expect(calculateRetention(1, 0)).toBe(0);

		// 2 remembered out of 3 -> 67%
		expect(calculateRetention(3, 2)).toBe(67);

		// 9 remembered out of 10 -> 90%
		expect(calculateRetention(10, 9)).toBe(90);

		// Negative or over-range safety
		expect(calculateRetention(-1, 5)).toBe(100);
		expect(calculateRetention(5, 10)).toBe(100);
	});
});
