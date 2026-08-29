import fs from 'node:fs';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import initWasm from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';
import {
	DatabaseManager,
	getStudyDayCutoff,
	getStudyDayKey,
	getStudyDayStart,
} from '../src/db/DatabaseManager.ts';
import SCHEMA_SQL from '../src/db/schema.sql?raw';
import {
	computeSha256,
	isValidSqliteHeader,
	packSnapshot,
	unpackAndVerifySnapshot,
} from '../src/db/snapshot.ts';
import {
	DEFAULT_SETTINGS,
	type FsrsParams,
	type ParsedBlock,
	type ReviewItem,
	type ReviewRecord,
	type SchedulingCard,
	type SessionRecord,
} from '../src/types.ts';
import { filterDashboardBlock, groupCardsByBlock } from '../src/utils/dashboardCards.ts';
import { filterDashboardCard } from '../src/utils/dashboardFilter.ts';
import { calculateProgress, calculateRetention } from '../src/utils/reviewMetrics.ts';
import { ReviewSessionCache } from '../src/utils/ReviewSessionCache.ts';
import { formatLocalDate, shiftLocalDateKey } from '../src/utils/studyDay.ts';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../src/utils/studySteps.ts';
import { computeTagDeckStats } from '../src/utils/tagStats.ts';
import { toggleCardTodoInMarkdown } from '../src/utils/todoTag.ts';
import { WasmBridge } from '../src/wasm.ts';

describe('Study Day Boundary Calculation (4:00 AM Rollover)', () => {
	it('calculates start and cutoff for evening reviews (e.g. 21:00)', () => {
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

		const artMatches = cards.filter((c) => filterDashboardCard(c, '#art'));
		expect(artMatches).toHaveLength(1);
		expect(artMatches[0]?.noteTitle).toBe('Art History');

		const subtagMatches = cards.filter((c) => filterDashboardCard(c, '#art/renaissance'));
		expect(subtagMatches).toHaveLength(1);
		expect(subtagMatches[0]?.noteTitle).toBe('Art History');
	});
});

describe('Dual-Slot Persistence Protocol (cards.a.db / cards.b.db)', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
		WasmBridge.initForTest(SQL);

		const wasmPath = path.resolve(
			__dirname,
			'../../../crates/flashcards-wasm/pkg/flashcards_wasm_bg.wasm',
		);
		const wasmBuffer = fs.readFileSync(wasmPath);
		await initWasm({ module_or_path: wasmBuffer });
	});

	it('packs and unpacks 48-byte header with SHA-256 checksum verification', async () => {
		const rawDb = new SQL.Database();
		rawDb.run(SCHEMA_SQL);
		const payload = rawDb.export();
		expect(isValidSqliteHeader(payload)).toBe(true);

		const sha256 = await computeSha256(payload);
		const generation = 42n;

		const packed = packSnapshot(payload, generation, sha256);
		expect(packed.length).toBe(48 + payload.length);

		const unpacked = await unpackAndVerifySnapshot(packed);
		expect(unpacked).not.toBeNull();
		expect(unpacked?.generation).toBe(42n);
		expect(unpacked?.payloadLength).toBe(payload.length);
		expect(unpacked?.payload).toEqual(payload);
	});

	it('rejects corrupt snapshots (tampered payload or invalid magic)', async () => {
		const rawDb = new SQL.Database();
		rawDb.run(SCHEMA_SQL);
		const payload = rawDb.export();
		const sha256 = await computeSha256(payload);
		const packed = packSnapshot(payload, 1n, sha256);

		// Case 1: Corrupted byte in payload
		const tamperedPayload = new Uint8Array(packed);
		tamperedPayload[60] = (tamperedPayload[60] ?? 0) ^ 0xff;
		expect(await unpackAndVerifySnapshot(tamperedPayload)).toBeNull();

		// Case 2: Invalid Magic bytes
		const badMagic = new Uint8Array(packed);
		badMagic[0] = 0x00;
		expect(await unpackAndVerifySnapshot(badMagic)).toBeNull();

		// Case 3: Truncated buffer
		const truncated = packed.subarray(0, 30);
		expect(await unpackAndVerifySnapshot(truncated)).toBeNull();
	});

	it('recovers from higher generation slot on startup and handles corrupted sibling slot', async () => {
		const rawDb = new SQL.Database();
		rawDb.run(SCHEMA_SQL);
		const payload = rawDb.export();
		const sha = await computeSha256(payload);

		const slotABytes = packSnapshot(payload, 10n, sha);
		const slotBBytes = packSnapshot(payload, 11n, sha);

		// Mock file system with both slots valid: should choose Slot B (gen 11 > gen 10)
		const mockStorage: Record<string, Uint8Array> = {
			'.obsidian/plugins/flashcards/cards.a.db': slotABytes,
			'.obsidian/plugins/flashcards/cards.b.db': slotBBytes,
		};

		const mockApp = {
			vault: {
				adapter: {
					exists: async (p: string) => p in mockStorage,
					readBinary: async (p: string) => mockStorage[p]?.buffer ?? new ArrayBuffer(0),
					writeBinary: async (p: string, b: ArrayBuffer) => {
						mockStorage[p] = new Uint8Array(b);
					},
					remove: async (p: string) => {
						delete mockStorage[p];
					},
				},
			},
		} as any;

		const dbManager = new DatabaseManager(mockApp, { dir: '.obsidian/plugins/flashcards' } as any);
		await dbManager.init();

		const active = dbManager.getActiveSlot();
		expect(active.slot).toBe('b');
		expect(active.generation).toBe(11n);

		// Now simulate corrupting Slot B on disk: should recover cleanly from intact Slot A
		const corruptedSlotB = new Uint8Array(slotBBytes);
		const byteVal = corruptedSlotB[50] ?? 0;
		corruptedSlotB[50] = byteVal ^ 0xff;
		mockStorage['.obsidian/plugins/flashcards/cards.b.db'] = corruptedSlotB;

		const dbManagerRecovery = new DatabaseManager(mockApp, {
			dir: '.obsidian/plugins/flashcards',
		} as any);
		await dbManagerRecovery.init();

		const recoveredActive = dbManagerRecovery.getActiveSlot();
		expect(recoveredActive.slot).toBe('a');
		expect(recoveredActive.generation).toBe(10n);
	});

	it('alternates slots and increments 64-bit BigInt generation on consecutive persists', async () => {
		const mockStorage: Record<string, Uint8Array> = {};
		const mockApp = {
			vault: {
				adapter: {
					exists: async (p: string) => p in mockStorage,
					readBinary: async (p: string) => mockStorage[p]?.buffer ?? new ArrayBuffer(0),
					writeBinary: async (p: string, b: ArrayBuffer) => {
						mockStorage[p] = new Uint8Array(b);
					},
					remove: async (p: string) => {
						delete mockStorage[p];
					},
				},
			},
		} as any;

		const dbManager = new DatabaseManager(mockApp, { dir: '.obsidian/plugins/flashcards' } as any);
		await dbManager.init();

		// Initial state (empty DB): Slot A, Generation 0
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'a', generation: 0n });

		// 1st persist -> Writes to Slot B, Gen 1
		await dbManager.persist();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'b', generation: 1n });
		expect(mockStorage['.obsidian/plugins/flashcards/cards.b.db']).toBeDefined();

		// 2nd persist -> Writes to Slot A, Gen 2
		await dbManager.persist();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'a', generation: 2n });
		expect(mockStorage['.obsidian/plugins/flashcards/cards.a.db']).toBeDefined();

		// 3rd persist -> Writes to Slot B, Gen 3
		await dbManager.persist();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'b', generation: 3n });

		// 4th persist -> Writes to Slot A, Gen 4
		await dbManager.persist();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'a', generation: 4n });
	});

	it('handles read-back verification failure without advancing slot or generation', async () => {
		const mockStorage: Record<string, Uint8Array> = {};
		let corruptReadBack = false;

		const mockApp = {
			vault: {
				adapter: {
					exists: async (p: string) => p in mockStorage,
					readBinary: async (p: string) => {
						const buf = mockStorage[p];
						if (!buf) return new ArrayBuffer(0);
						if (corruptReadBack) {
							// Return corrupted data on read-back
							const corrupted = new Uint8Array(buf);
							corrupted[10] = (corrupted[10] ?? 0) ^ 0xff;
							return corrupted.buffer;
						}
						return buf.buffer;
					},
					writeBinary: async (p: string, b: ArrayBuffer) => {
						mockStorage[p] = new Uint8Array(b);
					},
					remove: async (p: string) => {
						delete mockStorage[p];
					},
				},
			},
		} as any;

		const dbManager = new DatabaseManager(mockApp, { dir: '.obsidian/plugins/flashcards' } as any);
		await dbManager.init();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'a', generation: 0n });

		// Normal persist -> moves to Slot B, Gen 1
		await dbManager.persist();
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'b', generation: 1n });

		// Trigger read-back corruption
		corruptReadBack = true;
		await expect(dbManager.persist()).rejects.toThrow(/Dual-slot read-back verification failed/);

		// Must NOT have advanced generation or switched slot
		expect(dbManager.getActiveSlot()).toEqual({ slot: 'b', generation: 1n });
	});
});

describe('DatabaseManager SQLite Pipeline Integration (v2 Schema)', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
	});

	function createFreshDb(): { db: DatabaseManager; rawDb: any } {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		return { db, rawDb };
	}

	it('creates and updates forward, bidirectional, and cloze cards correctly', () => {
		const { db } = createFreshDb();
		const filePath = 'Notes/Biology.md';

		const parsedBlocks: ParsedBlock[] = [
			{
				id: 'blk001',
				block_type: 'inline',
				reversible: false,
				front: 'Mitochondria function?',
				back: 'Powerhouse of the cell',
				tags: ['biology', 'cells'],
				line_start: 1,
				line_end: 1,
			},
			{
				id: 'blk002',
				block_type: 'block',
				reversible: true,
				front: 'DNA',
				back: 'Deoxyribonucleic acid',
				tags: ['biology', 'genetics'],
				line_start: 3,
				line_end: 7,
			},
			{
				id: 'blk003',
				block_type: 'cloze',
				reversible: false,
				front: 'The human body has {{206}} bones.',
				back: '',
				tags: ['anatomy'],
				line_start: 9,
				line_end: 9,
			},
		];

		db.syncNoteBlocks(filePath, parsedBlocks);

		const cards = db.getAllCards();
		expect(cards).toHaveLength(4); // 1 forward + 2 (forward & reverse for DNA) + 1 cloze

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

		const clozeItem = cards.find((c) => c.blockId === 'blk003');
		expect(clozeItem).toBeDefined();
		expect(clozeItem?.direction).toBeNull();
		expect(clozeItem?.blockType).toBe('cloze');
	});

	it('enforces cloze direction trigger constraint at database level', () => {
		const { rawDb } = createFreshDb();

		// Insert cloze block
		rawDb.run(`
			INSERT INTO blocks (id, file_path, block_type, reversible, front, back, tags, updated_at)
			VALUES ('cloze1', 'Note.md', 'cloze', 0, 'Question {{cloze}}', '', 'tags', 1000);
		`);

		// Inserting cloze card with non-null direction MUST abort via trigger
		expect(() => {
			rawDb.run(`
				INSERT INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, learning_step, relearning_step)
				VALUES ('cloze1', 'forward', 0, 1000, 0, 0, 0, 0, 0, 0);
			`);
		}).toThrow(/Cloze cards must have NULL direction/);

		// Inserting cloze card with NULL direction succeeds
		rawDb.run(`
			INSERT INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, learning_step, relearning_step)
			VALUES ('cloze1', NULL, 0, 1000, 0, 0, 0, 0, 0, 0);
		`);
	});

	it('prunes obsolete directional items when card direction changes from bidirectional to forward', () => {
		const { db } = createFreshDb();
		const filePath = 'Notes/Chemistry.md';

		// Initially bidirectional
		db.syncNoteBlocks(filePath, [
			{
				id: 'chem01',
				block_type: 'block',
				reversible: true,
				front: 'NaCl',
				back: 'Sodium Chloride',
				tags: ['chemistry'],
				line_start: 1,
				line_end: 5,
			},
		]);
		expect(db.getAllCards()).toHaveLength(2);

		// User edits card to reversible=false (forward only)
		db.syncNoteBlocks(filePath, [
			{
				id: 'chem01',
				block_type: 'block',
				reversible: false,
				front: 'NaCl',
				back: 'Sodium Chloride',
				tags: ['chemistry'],
				line_start: 1,
				line_end: 5,
			},
		]);

		const remainingCards = db.getAllCards();
		expect(remainingCards).toHaveLength(1);
		expect(remainingCards[0]?.direction).toBe('forward');
	});

	it('commits review session in single batch transaction and updates statistics', async () => {
		const { db } = createFreshDb();
		const filePath = 'Notes/History.md';
		db.syncNoteBlocks(filePath, [
			{
				id: 'hist01',
				block_type: 'inline',
				reversible: false,
				front: 'Year WW2 ended?',
				back: '1945',
				tags: ['history'],
				line_start: 1,
				line_end: 1,
			},
		]);

		const card = db.getAllCards()[0]!;
		expect(card.state).toBe('new');
		expect(card.reps).toBe(0);

		const now = Date.now();
		const nextDue = now + 24 * 60 * 60 * 1000;

		const session: SessionRecord = {
			started_at: now - 60000,
			ended_at: now,
			card_count: 1,
			forgot_count: 0,
			remembered_count: 1,
		};

		const reviews: ReviewRecord[] = [
			{
				card_id: card.cardId,
				rating: 3, // Good
				state: 2, // Review
				due_at: nextDue,
				stability: 2.5,
				difficulty: 4.0,
				reviewed_at: now,
			},
		];

		const cardUpdates = [
			{
				id: card.cardId,
				state: 2,
				due_at: nextDue,
				stability: 2.5,
				difficulty: 4.0,
				reps: 1,
				lapses: 0,
				last_review: now,
				learning_step: 0,
				relearning_step: 0,
			},
		];

		await db.commitSession(session, reviews, cardUpdates);

		const updated = db.getAllCards()[0]!;
		expect(updated.state).toBe('review');
		expect(updated.reps).toBe(1);
		expect(updated.dueAt).toBe(nextDue);

		const stats = db.getDashboardStats(4);
		expect(stats.studiedToday).toBe(1);
		expect(stats.dailyRetention).toBe(100);
		expect(stats.studyStreak).toBe(1);
	});

	it('computes review logs with window delta_t for FSRS weight optimizer', async () => {
		const { db } = createFreshDb();
		const filePath = 'Notes/Math.md';
		db.syncNoteBlocks(filePath, [
			{
				id: 'math01',
				block_type: 'inline',
				reversible: false,
				front: 'Derivative of sin(x)?',
				back: 'cos(x)',
				tags: ['math'],
				line_start: 1,
				line_end: 1,
			},
		]);

		const card = db.getAllCards()[0]!;
		const t0 = 1700000000000;
		const t1 = t0 + 86400000; // 1 day
		const t2 = t1 + 3 * 86400000; // 3 days

		await db.commitSession(
			{ started_at: t0, ended_at: t0, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 1,
					due_at: t1,
					stability: 1.0,
					difficulty: 5.0,
					reviewed_at: t0,
				},
			],
			[
				{
					id: card.cardId,
					state: 1,
					due_at: t1,
					stability: 1.0,
					difficulty: 5.0,
					reps: 1,
					lapses: 0,
					last_review: t0,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		await db.commitSession(
			{ started_at: t1, ended_at: t1, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: t2,
					stability: 2.5,
					difficulty: 4.5,
					reviewed_at: t1,
				},
			],
			[
				{
					id: card.cardId,
					state: 2,
					due_at: t2,
					stability: 2.5,
					difficulty: 4.5,
					reps: 2,
					lapses: 0,
					last_review: t1,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		await db.commitSession(
			{ started_at: t2, ended_at: t2, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: card.cardId,
					rating: 4,
					state: 2,
					due_at: t2 + 86400000 * 5,
					stability: 6.0,
					difficulty: 4.0,
					reviewed_at: t2,
				},
			],
			[
				{
					id: card.cardId,
					state: 2,
					due_at: t2 + 86400000 * 5,
					stability: 6.0,
					difficulty: 4.0,
					reps: 3,
					lapses: 0,
					last_review: t2,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		const optLogs = db.getReviewLogsForOptimization();
		expect(optLogs).toHaveLength(3);
		expect(optLogs[0]?.delta_t).toBe(0);
		expect(optLogs[1]?.delta_t).toBe(1);
		expect(optLogs[2]?.delta_t).toBe(3);
	});
});

describe('NoteScanner Single-Pass Synchronization', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
		WasmBridge.initForTest(SQL);
	});

	function createMockVault(files: Record<string, string>) {
		const storage = new Map<string, string>(Object.entries(files));
		const mockVault = {
			cachedRead: async (file: any) => storage.get(file.path) ?? '',
			modify: async (file: any, data: string) => {
				storage.set(file.path, data);
			},
			getMarkdownFiles: () =>
				Array.from(storage.keys()).map((path) => ({ path, stat: { mtime: Date.now() } })),
			adapter: {
				exists: async () => false,
				readBinary: async () => new Uint8Array(),
				writeBinary: async () => {},
				remove: async () => {},
			},
		};
		const mockMetadataCache = {
			getFileCache: (file: any) => {
				const content = storage.get(file.path) ?? '';
				const tags: { tag: string }[] = [];
				for (const match of content.matchAll(/#([a-zA-Z0-9_\-/]+)/g)) {
					const t = match[0];
					if (t) tags.push({ tag: t });
				}
				return { tags, frontmatter: null, sections: [] };
			},
		};
		const mockApp = {
			vault: mockVault,
			metadataCache: mockMetadataCache,
		} as any;

		return { mockApp, storage };
	}

	it('generates missing IDs in single pass and writes back updated markdown', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const initialMarkdown =
			'# Biology\n\nWhat is the mitochondria? :: Powerhouse of the cell\n\nDNA ::: Deoxyribonucleic acid\n';
		const { mockApp, storage } = createMockVault({ 'Notes/Bio.md': initialMarkdown });

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		const blocks = await scanner.syncFile({ path: 'Notes/Bio.md' } as any);
		expect(blocks).toHaveLength(2);

		const updatedContent = storage.get('Notes/Bio.md')!;
		expect(updatedContent).toContain('^');
		expect(blocks[0]?.id).toMatch(/^[0-9a-z]{6}$/);
		expect(blocks[1]?.id).toMatch(/^[0-9a-z]{6}$/);

		const cards = db.getAllCards();
		expect(cards).toHaveLength(3); // 1 forward + 2 bidirectional (forward & reverse)
	});

	it('handles note rename without resetting card metrics', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const initialMarkdown = 'Question :: Answer ^abc123\n';
		const { mockApp } = createMockVault({ 'Notes/Old.md': initialMarkdown });

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		await scanner.syncFile({ path: 'Notes/Old.md' } as any);
		expect(db.getAllCards()).toHaveLength(1);

		// Perform review
		const card = db.getAllCards()[0]!;
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: 2000,
					stability: 2.0,
					difficulty: 5.0,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: card.cardId,
					state: 2,
					due_at: 2000,
					stability: 2.0,
					difficulty: 5.0,
					reps: 1,
					lapses: 0,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		// Rename note
		await scanner.renameFile('Notes/Old.md', 'Notes/New.md');

		const cardsAfterRename = db.getAllCards();
		expect(cardsAfterRename).toHaveLength(1);
		expect(cardsAfterRename[0]?.notePath).toBe('Notes/New.md');
		expect(cardsAfterRename[0]?.reps).toBe(1);
		expect(cardsAfterRename[0]?.stability).toBe(2.0);
	});
});

describe('Settings Defaults & Review Metrics', () => {
	it('provides default empty settings', () => {
		expect(DEFAULT_SETTINGS).toEqual({});
	});

	it('calculates progress and retention accurately', () => {
		expect(calculateProgress(0, 5, false)).toEqual({
			currentCardNumber: 1,
			progressPercent: 20,
			progressText: '1 / 5',
		});
		expect(calculateProgress(4, 5, false)).toEqual({
			currentCardNumber: 5,
			progressPercent: 100,
			progressText: '5 / 5',
		});
		expect(calculateProgress(4, 5, true)).toEqual({
			currentCardNumber: 5,
			progressPercent: 100,
			progressText: '5 / 5',
		});
		expect(calculateRetention(10, 9)).toBe(90);
	});
});

describe('Markdown #todo/card Tag Toggling', () => {
	it('appends #todo/card to the question line of block cards before the divider', () => {
		const original = `%% card-start id=k9x2mp %%\nWhat is mitochondria?\n...\nPowerhouse of the cell\n%% card-end %%`;
		const updated = toggleCardTodoInMarkdown(original, 'k9x2mp', 'block');
		expect(updated).toBe(
			`%% card-start id=k9x2mp %%\nWhat is mitochondria? #todo/card\n...\nPowerhouse of the cell\n%% card-end %%`,
		);
	});

	it('removes #todo/card from block card without modifying the header or answer', () => {
		const tagged = `%% card-start id=k9x2mp %%\nWhat is mitochondria? #todo/card\n...\nPowerhouse of the cell\n%% card-end %%`;
		const untagged = toggleCardTodoInMarkdown(tagged, 'k9x2mp', 'block');
		expect(untagged).toBe(
			`%% card-start id=k9x2mp %%\nWhat is mitochondria?\n...\nPowerhouse of the cell\n%% card-end %%`,
		);
	});

	it('toggles #todo/card before ^id for inline cards', () => {
		const original = `Capital of France :: Paris ^k9x2mp`;
		const tagged = toggleCardTodoInMarkdown(original, 'k9x2mp', 'inline');
		expect(tagged).toBe(`Capital of France :: Paris #todo/card ^k9x2mp`);

		const untagged = toggleCardTodoInMarkdown(tagged, 'k9x2mp', 'inline');
		expect(untagged).toBe(`Capital of France :: Paris ^k9x2mp`);
	});

	it('toggles #todo/card before ^id for cloze cards', () => {
		const original = `The {{c1::mitochondria}} is powerhouse. ^k9x2mp`;
		const tagged = toggleCardTodoInMarkdown(original, 'k9x2mp', 'cloze');
		expect(tagged).toBe(`The {{c1::mitochondria}} is powerhouse. #todo/card ^k9x2mp`);

		const untagged = toggleCardTodoInMarkdown(tagged, 'k9x2mp', 'cloze');
		expect(untagged).toBe(`The {{c1::mitochondria}} is powerhouse. ^k9x2mp`);
	});
});

describe('Date Utilities & Calendar Math', () => {
	it('formats local dates consistently with zero padding', () => {
		const testDate = new Date(2026, 0, 5); // Jan 5, 2026
		expect(formatLocalDate(testDate)).toBe('2026-01-05');
	});

	it('shifts local date keys across month and year boundaries correctly', () => {
		// Month boundary (March 1 -> Feb 28 in non-leap year)
		expect(shiftLocalDateKey('2026-03-01', -1)).toBe('2026-02-28');

		// Year boundary (Jan 1 -> Dec 31 previous year)
		expect(shiftLocalDateKey('2026-01-01', -1)).toBe('2025-12-31');

		// Leap year shift (Feb 28 + 1 day = Feb 29 in 2024)
		expect(shiftLocalDateKey('2024-02-28', 1)).toBe('2024-02-29');
		expect(shiftLocalDateKey('2024-02-29', 1)).toBe('2024-03-01');
	});

	it('parses study step decimals and mixed valid tokens', () => {
		expect(parseStudySteps('0.5h 1.5d', DEFAULT_LEARNING_STEPS)).toEqual([
			30 * 60 * 1000,
			36 * 60 * 60 * 1000,
		]);
		expect(parseStudySteps('10m invalid_step 2d', DEFAULT_LEARNING_STEPS)).toEqual([
			10 * 60 * 1000,
			2 * 24 * 60 * 60 * 1000,
		]);
	});
});

describe('DatabaseManager Extended Behaviors', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
	});

	function createFreshDb(): DatabaseManager {
		const rawDb = new SQL.Database();
		return DatabaseManager.createInMemory(rawDb);
	}

	it('retrieves due cards filtered by cutoff and tags', () => {
		const db = createFreshDb();

		db.syncNoteBlocks('Notes/Lang.md', [
			{
				id: 'blk_due_de',
				block_type: 'inline',
				reversible: false,
				front: 'Hund',
				back: 'Dog',
				tags: ['german', 'vocab'],
				line_start: 1,
				line_end: 1,
			},
			{
				id: 'blk_due_fr',
				block_type: 'inline',
				reversible: false,
				front: 'Chien',
				back: 'Dog',
				tags: ['french', 'vocab'],
				line_start: 2,
				line_end: 2,
			},
		]);

		const allDue = db.getDueCards(undefined, 4);
		expect(allDue).toHaveLength(2);

		const germanDue = db.getDueCards(['german'], 4);
		expect(germanDue).toHaveLength(1);
		expect(germanDue[0]?.blockId).toBe('blk_due_de');

		const uniqueTags = db.getUniqueTags();
		expect(uniqueTags).toEqual(['french', 'german', 'vocab']);
	});

	it('calculates study streak correctly across multiple days', async () => {
		const db = createFreshDb();
		db.syncNoteBlocks('Notes/Streak.md', [
			{
				id: 'streak01',
				block_type: 'inline',
				reversible: false,
				front: 'Q',
				back: 'A',
				tags: ['test'],
				line_start: 1,
				line_end: 1,
			},
		]);

		const card = db.getAllCards()[0]!;
		const now = Date.now();
		const oneDayMs = 24 * 60 * 60 * 1000;

		// Today review
		await db.commitSession(
			{ started_at: now, ended_at: now, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: now + oneDayMs,
					stability: 2.0,
					difficulty: 5.0,
					reviewed_at: now,
				},
			],
			[],
		);

		// Yesterday review
		const yesterdayMs = now - oneDayMs;
		await db.commitSession(
			{
				started_at: yesterdayMs,
				ended_at: yesterdayMs,
				card_count: 1,
				forgot_count: 0,
				remembered_count: 1,
			},
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: now,
					stability: 2.0,
					difficulty: 5.0,
					reviewed_at: yesterdayMs,
				},
			],
			[],
		);

		// Day before yesterday review
		const twoDaysAgoMs = now - 2 * oneDayMs;
		await db.commitSession(
			{
				started_at: twoDaysAgoMs,
				ended_at: twoDaysAgoMs,
				card_count: 1,
				forgot_count: 0,
				remembered_count: 1,
			},
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: yesterdayMs,
					stability: 2.0,
					difficulty: 5.0,
					reviewed_at: twoDaysAgoMs,
				},
			],
			[],
		);

		const stats = db.getDashboardStats(4);
		expect(stats.studyStreak).toBe(3);
		expect(stats.studiedToday).toBe(1);
		expect(stats.dailyRetention).toBe(100);
	});

	it('runs database optimization and prunes stale deleted note records', async () => {
		const db = createFreshDb();
		db.syncNoteBlocks('Notes/Active.md', [
			{
				id: 'act01',
				block_type: 'inline',
				reversible: false,
				front: 'Active Front',
				back: 'Active Back',
				tags: ['active'],
				line_start: 1,
				line_end: 1,
			},
		]);
		db.syncNoteBlocks('Notes/Stale.md', [
			{
				id: 'stl01',
				block_type: 'inline',
				reversible: false,
				front: 'Stale Front',
				back: 'Stale Back',
				tags: ['stale'],
				line_start: 1,
				line_end: 1,
			},
		]);

		expect(db.getAllCards()).toHaveLength(2);

		const res = await db.optimizeDatabase(new Set(['Notes/Active.md']));
		expect(res.integrityOk).toBe(true);
		expect(res.prunedBlocks).toBe(1);

		const remaining = db.getAllCards();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.blockId).toBe('act01');
	});

	it('maps review states and formats humanized timestamps accurately', () => {
		const db = createFreshDb();

		expect(db.mapState(0)).toBe('new');
		expect(db.mapState(1)).toBe('learning');
		expect(db.mapState(2)).toBe('review');
		expect(db.mapState(3)).toBe('relearning');

		expect(db.unmapState('new')).toBe(0);
		expect(db.unmapState('learning')).toBe(1);
		expect(db.unmapState('review')).toBe(2);
		expect(db.unmapState('relearning')).toBe(3);

		const now = 1700000000000;
		expect(db.humanizeDue(now - 1000, now)).toBe('Due now');
		expect(db.humanizeDue(now + 1000 * 60 * 60 * 24, now)).toBe('Tomorrow');
		expect(db.humanizeDue(now + 1000 * 60 * 60 * 24 * 5, now)).toBe('In 5 days');

		expect(db.humanizeRelative(now - 1000 * 60 * 5, now)).toBe('5m ago');
		expect(db.humanizeRelative(now - 1000 * 60 * 60 * 2, now)).toBe('2h ago');
		expect(db.humanizeRelative(now - 1000 * 60 * 60 * 24 * 3, now)).toBe('3d ago');
	});
});

describe('NoteScanner Frontmatter & Ignore Handling', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
		WasmBridge.initForTest(SQL);
	});

	it('skips notes marked with cards-ignore: true in frontmatter', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);

		const initialMarkdown =
			'---\ncards-ignore: true\n---\n\nIgnored Question :: Ignored Answer ^ign001\n';
		const storage = new Map<string, string>([['Notes/Ignored.md', initialMarkdown]]);

		const mockVault = {
			cachedRead: async (f: any) => storage.get(f.path) ?? '',
			modify: async (f: any, data: string) => {
				storage.set(f.path, data);
			},
			getMarkdownFiles: () => [{ path: 'Notes/Ignored.md' }],
			adapter: {
				exists: async () => false,
				readBinary: async () => new Uint8Array(),
				writeBinary: async () => {},
				remove: async () => {},
			},
		};

		const mockMetadataCache = {
			getFileCache: () => ({
				tags: [],
				frontmatter: { 'cards-ignore': true },
				sections: [],
			}),
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: mockMetadataCache,
		} as any;

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		const synced = await scanner.syncFile({ path: 'Notes/Ignored.md' } as any);
		expect(synced).toHaveLength(0);
		expect(db.getAllCards()).toHaveLength(0);
	});

	it('inherits tags defined in frontmatter array and comma-delimited strings', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);

		const content = 'Question :: Answer ^tag001\n';
		const storage = new Map<string, string>([['Notes/Tags.md', content]]);

		const mockVault = {
			cachedRead: async (f: any) => storage.get(f.path) ?? '',
			modify: async (f: any, data: string) => {
				storage.set(f.path, data);
			},
			getMarkdownFiles: () => [{ path: 'Notes/Tags.md' }],
			adapter: {
				exists: async () => false,
				readBinary: async () => new Uint8Array(),
				writeBinary: async () => {},
				remove: async () => {},
			},
		};

		const mockMetadataCache = {
			getFileCache: () => ({
				tags: [],
				frontmatter: { tags: ['science', 'biology'] },
				sections: [],
			}),
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: mockMetadataCache,
		} as any;

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		const synced = await scanner.syncFile({ path: 'Notes/Tags.md' } as any);
		expect(synced).toHaveLength(1);
		expect(synced[0]?.tags).toContain('science');
		expect(synced[0]?.tags).toContain('biology');
	});
});

describe('WASM FSRS-6 Scheduling & Optimizer Integration', () => {
	it('schedules new and review cards through WASM bridge with FSRS-6 math', () => {
		const now = 1700000000000;
		const newCard: SchedulingCard = {
			stability: 0,
			difficulty: 0,
			reps: 0,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'new',
			last_review: null,
			due: now,
		};

		const params: FsrsParams = {
			request_retention: 0.9,
			maximum_interval: 36500,
			enable_fuzz: false,
		};

		const scheduleInfo = WasmBridge.calculateSchedule(newCard, params, now);
		expect(scheduleInfo.next_states).toHaveLength(4);

		// Rating 1 (Again): stays in learning
		const againState = scheduleInfo.next_states.find((c) => c.rating === 'again');
		expect(againState).toBeDefined();
		expect(againState?.card.state).toBe('learning');

		// Rating 3 (Good): advances
		const goodState = scheduleInfo.next_states.find((c) => c.rating === 'good');
		expect(goodState).toBeDefined();
		expect(goodState?.card.stability).toBeGreaterThan(0);
	});

	it('progresses learning steps on review cards and handles lapses', () => {
		const now = 1700000000000;
		const learningCard: SchedulingCard = {
			stability: 0.5,
			difficulty: 5.0,
			reps: 1,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'learning',
			last_review: now - 600000,
			due: now,
		};

		const params: FsrsParams = {
			request_retention: 0.9,
			maximum_interval: 36500,
			learning_steps: [10 * 60 * 1000, 24 * 60 * 60 * 1000],
		};

		const info = WasmBridge.calculateSchedule(learningCard, params, now);
		const goodState = info.next_states.find((c) => c.rating === 'good')!;
		expect(goodState.card.learning_step).toBe(1);

		// Review card lapsing on 'again'
		const reviewCard: SchedulingCard = {
			stability: 10.0,
			difficulty: 4.0,
			reps: 5,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'review',
			last_review: now - 86400000 * 10,
			due: now,
		};

		const lapseInfo = WasmBridge.calculateSchedule(reviewCard, params, now);
		const lapsedState = lapseInfo.next_states.find((c) => c.rating === 'again')!;
		expect(lapsedState.card.state).toBe('relearning');
		expect(lapsedState.card.lapses).toBe(1);
	});

	it('optimizes FSRS weights from review logs', () => {
		const logs = Array.from({ length: 12 }, (_, i) => ({
			card_id: `card_${i % 3}`,
			rating: (i % 2 === 0 ? 3 : 1) as number,
			delta_t: (i + 1) * 1.5,
		}));

		const weights = WasmBridge.optimizeFsrsWeights({}, logs);
		expect(weights).toHaveLength(21);
		for (const w of weights) {
			expect(typeof w).toBe('number');
			expect(isNaN(w)).toBe(false);
		}
	});
});

describe('Advanced Metrics & Edge Case Boundaries', () => {
	it('handles zero total cards, negative indices, and out-of-bound clamps in progress calculation', () => {
		expect(calculateProgress(0, 0, false)).toEqual({
			currentCardNumber: 0,
			progressPercent: 0,
			progressText: '0 / 0',
		});
		expect(calculateProgress(-5, 10, false)).toEqual({
			currentCardNumber: 1,
			progressPercent: 10,
			progressText: '1 / 10',
		});
		expect(calculateProgress(99, 10, false)).toEqual({
			currentCardNumber: 10,
			progressPercent: 100,
			progressText: '10 / 10',
		});
		expect(calculateRetention(0, 0)).toBe(100);
		expect(calculateRetention(10, 0)).toBe(0);
	});

	it('handles complex tag toggling with preexisting tags and multiline questions', () => {
		const original = `%% card-start id=x89z12 %%\nFirst question line\nSecond question line #biology #cells\n...\nAnswer content\n%% card-end %%`;
		const tagged = toggleCardTodoInMarkdown(original, 'x89z12', 'block');
		expect(tagged).toBe(
			`%% card-start id=x89z12 %%\nFirst question line\nSecond question line #biology #cells #todo/card\n...\nAnswer content\n%% card-end %%`,
		);

		const untagged = toggleCardTodoInMarkdown(tagged, 'x89z12', 'block');
		expect(untagged).toBe(
			`%% card-start id=x89z12 %%\nFirst question line\nSecond question line #biology #cells\n...\nAnswer content\n%% card-end %%`,
		);
	});

	it('accurately calculates study streak when gaps exist or user only reviewed yesterday', async () => {
		const SQL = await initSqlJs();
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		db.syncNoteBlocks('Note.md', [
			{
				id: 'blk_s',
				block_type: 'inline',
				reversible: false,
				front: 'Q',
				back: 'A',
				tags: [],
				line_start: 1,
				line_end: 1,
			},
		]);
		const card = db.getAllCards()[0]!;
		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;

		// Only reviewed 2 days ago (missed yesterday and today) -> streak 0
		await db.commitSession(
			{
				started_at: now - 2 * oneDay,
				ended_at: now - 2 * oneDay,
				card_count: 1,
				forgot_count: 0,
				remembered_count: 1,
			},
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: now,
					stability: 2,
					difficulty: 5,
					reviewed_at: now - 2 * oneDay,
				},
			],
			[],
		);
		expect(db.getDashboardStats(4).studyStreak).toBe(0);

		// Now add a review yesterday -> streak becomes 1 (pending review today)
		await db.commitSession(
			{
				started_at: now - oneDay,
				ended_at: now - oneDay,
				card_count: 1,
				forgot_count: 0,
				remembered_count: 1,
			},
			[
				{
					card_id: card.cardId,
					rating: 3,
					state: 2,
					due_at: now,
					stability: 2,
					difficulty: 5,
					reviewed_at: now - oneDay,
				},
			],
			[],
		);
		expect(db.getDashboardStats(4).studyStreak).toBe(2);
	});

	it('fullScan synchronizes all vault files and prunes deleted notes in one sweep', async () => {
		const SQL = await initSqlJs();
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);

		const storage = new Map<string, string>([
			['Notes/A.md', 'Question A :: Answer A ^aaa001\n'],
			['Notes/B.md', 'Question B :: Answer B ^bbb002\n'],
		]);

		const mockVault = {
			cachedRead: async (f: any) => storage.get(f.path) ?? '',
			modify: async (f: any, d: string) => storage.set(f.path, d),
			getMarkdownFiles: () =>
				Array.from(storage.keys()).map((path) => ({ path, stat: { mtime: 1 } })),
			adapter: {
				exists: async () => false,
				readBinary: async () => new Uint8Array(),
				writeBinary: async () => {},
				remove: async () => {},
			},
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: { getFileCache: () => ({ tags: [], frontmatter: null, sections: [] }) },
		} as any;

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		const fullScanRes = await scanner.fullScan();
		expect(fullScanRes.filesScanned).toBe(2);
		expect(fullScanRes.totalBlocks).toBe(2);
		expect(db.getAllCards()).toHaveLength(2);

		// Now delete Note B from storage and run deleteFile
		storage.delete('Notes/B.md');
		await scanner.deleteFile('Notes/B.md');
		expect(db.getAllCards()).toHaveLength(1);
		expect(db.getAllCards()[0]?.blockId).toBe('aaa001');
	});

	it('ensures getDashboardStats excludes orphaned cards not linked to valid blocks', async () => {
		const SQL = await initSqlJs();
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);

		// Insert 1 valid block + card
		db.syncNoteBlocks('Valid.md', [
			{
				id: 'val001',
				block_type: 'inline',
				reversible: false,
				front: 'Valid Q',
				back: 'Valid A',
				tags: [],
				line_start: 1,
				line_end: 1,
			},
		]);

		// Simulate legacy orphaned card inserted directly without matching block
		rawDb.run('PRAGMA foreign_keys = OFF;');
		rawDb.run(
			`INSERT INTO cards (id, block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
			 VALUES (999, 'orphan_block', 'forward', 0, 0, 0, 0, 0, 0, NULL, 0, 0)`,
		);
		rawDb.run('PRAGMA foreign_keys = ON;');

		// getAllCards returns only 1 card (JOIN blocks)
		expect(db.getAllCards()).toHaveLength(1);

		// getDashboardStats must also return exactly 1 due card and 1 total card (not 2)
		const stats = db.getDashboardStats(4);
		expect(stats.totalCards).toBe(1);
		expect(stats.dueToday).toBe(1);
		expect(stats.newCards).toBe(1);
	});
});

describe('In-Memory Review Session Cache (Hashcards Model)', () => {
	const sampleItem1: ReviewItem = {
		cardId: 101,
		blockId: 'blk101',
		noteTitle: 'History',
		notePath: 'Notes/History.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'WW2 End Year',
		back: '1945',
		tags: ['history'],
		state: 'new',
		stateNum: 0,
		dueAt: 1000,
		dueHuman: 'Due now',
		stability: 0,
		difficulty: 0,
		reps: 0,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: null,
		lastPracticedHuman: 'Never',
	};

	const sampleItem2: ReviewItem = {
		cardId: 102,
		blockId: 'blk102',
		noteTitle: 'Biology',
		notePath: 'Notes/Bio.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'Powerhouse of cell',
		back: 'Mitochondria',
		tags: ['biology'],
		state: 'new',
		stateNum: 0,
		dueAt: 1000,
		dueHuman: 'Due now',
		stability: 0,
		difficulty: 0,
		reps: 0,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: null,
		lastPracticedHuman: 'Never',
	};

	it('records reviews purely in memory with zero initial database writes', () => {
		const cache = new ReviewSessionCache(1000);
		expect(cache.getReviewsCount()).toBe(0);

		const prevState1: SchedulingCard = {
			stability: 0,
			difficulty: 0,
			reps: 0,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'new',
			last_review: null,
			due: 1000,
		};

		const nextState1: SchedulingCard = {
			stability: 2.5,
			difficulty: 4.5,
			reps: 1,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'review',
			last_review: 2000,
			due: 3000,
		};

		cache.recordReview(sampleItem1, prevState1, 'remembered', nextState1, 2, 2000);

		expect(cache.getReviewsCount()).toBe(1);
		const stats = cache.getStats();
		expect(stats.studied).toBe(1);
		expect(stats.remembered).toBe(1);
		expect(stats.forgot).toBe(0);

		const pending = cache.getPendingData();
		expect(pending.reviews).toHaveLength(1);
		expect(pending.cardUpdates).toHaveLength(1);
		expect(pending.cardUpdates[0]?.id).toBe(101);
		expect(pending.cardUpdates[0]?.stability).toBe(2.5);
	});

	it('handles undo by reverting card state and card updates cleanly in memory', () => {
		const cache = new ReviewSessionCache(1000);

		const prevState1: SchedulingCard = {
			stability: 0,
			difficulty: 0,
			reps: 0,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'new',
			last_review: null,
			due: 1000,
		};
		const nextState1: SchedulingCard = {
			stability: 2.5,
			difficulty: 4.5,
			reps: 1,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'review',
			last_review: 2000,
			due: 3000,
		};

		const prevState2: SchedulingCard = {
			stability: 0,
			difficulty: 0,
			reps: 0,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			state: 'new',
			last_review: null,
			due: 1000,
		};
		const nextState2: SchedulingCard = {
			stability: 0,
			difficulty: 5.0,
			reps: 1,
			lapses: 1,
			learning_step: 0,
			relearning_step: 0,
			state: 'learning',
			last_review: 2100,
			due: 2700,
		};

		cache.recordReview(sampleItem1, prevState1, 'remembered', nextState1, 2, 2000);
		cache.recordReview(sampleItem2, prevState2, 'forgot', nextState2, 1, 2100);

		expect(cache.getReviewsCount()).toBe(2);
		expect(cache.getStats().forgot).toBe(1);
		expect(cache.getStats().remembered).toBe(1);

		// Undo card 2
		const undoRes = cache.undo();
		expect(undoRes).not.toBeNull();
		expect(undoRes?.item.cardId).toBe(102);
		expect(undoRes?.previousState.state).toBe('new');

		expect(cache.getReviewsCount()).toBe(1);
		expect(cache.getStats().forgot).toBe(0);
		expect(cache.getStats().remembered).toBe(1);

		const pendingAfterUndo = cache.getPendingData();
		expect(pendingAfterUndo.reviews).toHaveLength(1);
		expect(pendingAfterUndo.reviews[0]?.card_id).toBe(101);
		expect(pendingAfterUndo.cardUpdates).toHaveLength(1);
		expect(pendingAfterUndo.cardUpdates[0]?.id).toBe(101);
	});

	it('commits batch session atomically to SQLite only at end of session', async () => {
		const SQL = await initSqlJs();
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);

		db.syncNoteBlocks('Note.md', [
			{
				id: 'blk01',
				block_type: 'inline',
				reversible: false,
				front: 'Q1',
				back: 'A1',
				tags: [],
				line_start: 1,
				line_end: 1,
			},
			{
				id: 'blk02',
				block_type: 'inline',
				reversible: false,
				front: 'Q2',
				back: 'A2',
				tags: [],
				line_start: 2,
				line_end: 2,
			},
		]);

		const cards = db.getAllCards();
		expect(cards).toHaveLength(2);
		const c1 = cards[0]!;
		const c2 = cards[1]!;

		const cache = new ReviewSessionCache(1000);

		// Review c1, review c2, undo c2
		cache.recordReview(
			c1,
			{
				stability: 0,
				difficulty: 0,
				reps: 0,
				lapses: 0,
				learning_step: 0,
				relearning_step: 0,
				state: 'new',
				last_review: null,
				due: 1000,
			},
			'remembered',
			{
				stability: 3.0,
				difficulty: 4.0,
				reps: 1,
				lapses: 0,
				learning_step: 0,
				relearning_step: 0,
				state: 'review',
				last_review: 2000,
				due: 5000,
			},
			2,
			2000,
		);

		cache.recordReview(
			c2,
			{
				stability: 0,
				difficulty: 0,
				reps: 0,
				lapses: 0,
				learning_step: 0,
				relearning_step: 0,
				state: 'new',
				last_review: null,
				due: 1000,
			},
			'forgot',
			{
				stability: 0,
				difficulty: 5.0,
				reps: 1,
				lapses: 1,
				learning_step: 0,
				relearning_step: 0,
				state: 'learning',
				last_review: 2100,
				due: 2600,
			},
			1,
			2100,
		);

		cache.undo();

		// Commit session
		const { session, reviews, cardUpdates } = cache.getPendingData();
		await db.commitSession(session, reviews, cardUpdates);

		// Verify c1 was updated in DB and c2 remained untouched ('new')
		const cardsAfterCommit = db.getAllCards();
		const c1After = cardsAfterCommit.find((c) => c.cardId === c1.cardId)!;
		const c2After = cardsAfterCommit.find((c) => c.cardId === c2.cardId)!;

		expect(c1After.state).toBe('review');
		expect(c1After.reps).toBe(1);
		expect(c1After.dueAt).toBe(5000);

		expect(c2After.state).toBe('new');
		expect(c2After.reps).toBe(0);
	});
});

describe('Dashboard Block Grouping & Reverse Metrics', () => {
	const forwardCard: ReviewItem = {
		cardId: 1,
		blockId: 'blk_bidi_1',
		noteTitle: 'Vocabulary',
		notePath: 'Notes/Vocab.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: true,
		front: 'Bonjour',
		back: 'Hello',
		tags: ['french'],
		state: 'review',
		stateNum: 2,
		dueAt: 1000,
		dueHuman: 'Due now',
		stability: 3.0,
		difficulty: 4.0,
		reps: 3,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: 500,
		lastPracticedHuman: '1d ago',
	};

	const reverseCard: ReviewItem = {
		cardId: 2,
		blockId: 'blk_bidi_1',
		noteTitle: 'Vocabulary',
		notePath: 'Notes/Vocab.md',
		direction: 'reverse',
		blockType: 'inline',
		reversible: true,
		front: 'Hello',
		back: 'Bonjour',
		tags: ['french'],
		state: 'learning',
		stateNum: 1,
		dueAt: 9000,
		dueHuman: 'In 5d',
		stability: 1.0,
		difficulty: 5.0,
		reps: 1,
		lapses: 1,
		learningStep: 0,
		relearningStep: 0,
		lastReview: 200,
		lastPracticedHuman: '3d ago',
	};

	const monoCard: ReviewItem = {
		cardId: 3,
		blockId: 'blk_mono_2',
		noteTitle: 'Geography',
		notePath: 'Notes/Geo.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'Capital of France',
		back: 'Paris',
		tags: ['geo'],
		state: 'new',
		stateNum: 0,
		dueAt: 2000,
		dueHuman: 'Tomorrow',
		stability: 0,
		difficulty: 0,
		reps: 0,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: null,
		lastPracticedHuman: 'Never',
	};

	it('consolidates bidirectional forward and reverse cards into a single block item', () => {
		const rawCards = [forwardCard, reverseCard, monoCard];
		const blocks = groupCardsByBlock(rawCards);

		// 3 cards must produce exactly 2 block rows
		expect(blocks).toHaveLength(2);

		const bidiBlock = blocks.find((b) => b.blockId === 'blk_bidi_1');
		expect(bidiBlock).toBeDefined();
		expect(bidiBlock?.reversible).toBe(true);
		expect(bidiBlock?.front).toBe('Bonjour');
		expect(bidiBlock?.back).toBe('Hello');
		expect(bidiBlock?.forward.cardId).toBe(1);
		expect(bidiBlock?.reverse?.cardId).toBe(2);

		const monoBlock = blocks.find((b) => b.blockId === 'blk_mono_2');
		expect(monoBlock).toBeDefined();
		expect(monoBlock?.reversible).toBe(false);
		expect(monoBlock?.reverse).toBeUndefined();
	});

	it('filters block items if either forward or reverse card matches due status', () => {
		const blocks = groupCardsByBlock([forwardCard, reverseCard, monoCard]);
		const bidiBlock = blocks.find((b) => b.blockId === 'blk_bidi_1')!;
		const monoBlock = blocks.find((b) => b.blockId === 'blk_mono_2')!;

		// Due cutoff at 1500: bidi forward is due (1000 <= 1500), mono is not (2000 > 1500)
		expect(filterDashboardBlock(bidiBlock, 'due', 1500, '')).toBe(true);
		expect(filterDashboardBlock(monoBlock, 'due', 1500, '')).toBe(false);

		// Status 'learning': bidi reverse is learning, mono is new
		expect(filterDashboardBlock(bidiBlock, 'learning', 1500, '')).toBe(true);
		expect(filterDashboardBlock(monoBlock, 'learning', 1500, '')).toBe(false);

		// Search filter: query 'Paris' matches only monoBlock
		expect(filterDashboardBlock(bidiBlock, 'all', 1500, 'Paris')).toBe(false);
		expect(filterDashboardBlock(monoBlock, 'all', 1500, 'Paris')).toBe(true);
	});
});

describe('Tag Deck Stats Aggregation (Hashcards Model)', () => {
	const card1: ReviewItem = {
		cardId: 1,
		blockId: 'b1',
		noteTitle: 'Vocab',
		notePath: 'Vocab.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'Q1',
		back: 'A1',
		tags: ['french', 'languages'],
		state: 'review',
		stateNum: 2,
		dueAt: 1000,
		dueHuman: 'Due now',
		stability: 2,
		difficulty: 5,
		reps: 2,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: 500,
		lastPracticedHuman: '1d ago',
	};

	const card2: ReviewItem = {
		cardId: 2,
		blockId: 'b2',
		noteTitle: 'Vocab',
		notePath: 'Vocab.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'Q2',
		back: 'A2',
		tags: ['french'],
		state: 'new',
		stateNum: 0,
		dueAt: 5000,
		dueHuman: 'Tomorrow',
		stability: 0,
		difficulty: 0,
		reps: 0,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: null,
		lastPracticedHuman: 'Never',
	};

	const card3: ReviewItem = {
		cardId: 3,
		blockId: 'b3',
		noteTitle: 'Geo',
		notePath: 'Geo.md',
		direction: 'forward',
		blockType: 'inline',
		reversible: false,
		front: 'Q3',
		back: 'A3',
		tags: ['geography'],
		state: 'review',
		stateNum: 2,
		dueAt: 9000,
		dueHuman: 'In 5d',
		stability: 5,
		difficulty: 3,
		reps: 4,
		lapses: 0,
		learningStep: 0,
		relearningStep: 0,
		lastReview: 400,
		lastPracticedHuman: '2d ago',
	};

	it('computes total, due, and new cards per tag deck and sorts by due count', () => {
		const stats = computeTagDeckStats([card1, card2, card3], 2000);

		expect(stats).toHaveLength(3);

		// 'french': 2 total, 1 due (card1 at 1000 <= 2000), 1 new (card2)
		const french = stats.find((s) => s.tag === 'french');
		expect(french).toEqual({ tag: 'french', total: 2, due: 1, newCards: 1 });

		// 'languages': 1 total, 1 due, 0 new
		const languages = stats.find((s) => s.tag === 'languages');
		expect(languages).toEqual({ tag: 'languages', total: 1, due: 1, newCards: 0 });

		// 'geography': 1 total, 0 due (9000 > 2000), 0 new
		const geo = stats.find((s) => s.tag === 'geography');
		expect(geo).toEqual({ tag: 'geography', total: 1, due: 0, newCards: 0 });

		// French and Languages (due: 1) appear before Geography (due: 0)
		expect(stats[0]!.due).toBe(1);
		expect(stats[1]!.due).toBe(1);
		expect(stats[2]!.due).toBe(0);
	});
});

describe('Identity Reconciliation & Note Synchronization Invariants', () => {
	let SQL: SqlJsStatic;

	beforeAll(async () => {
		SQL = await initSqlJs();
		WasmBridge.initForTest(SQL);
	});

	function createMockVault(files: Record<string, string>) {
		const storage = new Map<string, string>(Object.entries(files));
		let modifyCalls = 0;
		const mockVault = {
			cachedRead: async (file: any) => storage.get(file.path) ?? '',
			modify: async (file: any, data: string) => {
				modifyCalls++;
				storage.set(file.path, data);
			},
			getMarkdownFiles: () =>
				Array.from(storage.keys()).map((path) => ({ path, stat: { mtime: Date.now() } })),
			adapter: {
				exists: async () => false,
				readBinary: async () => new Uint8Array(),
				writeBinary: async () => {},
				remove: async () => {},
			},
		};
		const mockMetadataCache = {
			getFileCache: (file: any) => {
				const content = storage.get(file.path) ?? '';
				const tags: { tag: string }[] = [];
				for (const match of content.matchAll(/#([a-zA-Z0-9_\-/]+)/g)) {
					const t = match[0];
					if (t) tags.push({ tag: t });
				}
				return { tags, frontmatter: null, sections: [] };
			},
		};
		const mockApp = {
			vault: mockVault,
			metadataCache: mockMetadataCache,
		} as any;

		return { mockApp, storage, getModifyCalls: () => modifyCalls };
	}

	it('existing ID in same note remains stable across fullScan without file modifications or scheduling resets', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const initialMarkdown = 'What is the capital of Japan? :: Tokyo ^abc123\n';
		const { mockApp, storage, getModifyCalls } = createMockVault({
			'Notes/Japan.md': initialMarkdown,
		});

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		// Initial scan
		await scanner.fullScan();
		const cards = db.getAllCards();
		expect(cards).toHaveLength(1);
		const cardId = cards[0]!.cardId;

		// Set reviewed FSRS state
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: cardId,
					rating: 3,
					state: 2,
					due_at: 10000,
					stability: 15.4,
					difficulty: 4.1,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: cardId,
					state: 2,
					due_at: 10000,
					stability: 15.4,
					difficulty: 4.1,
					reps: 6,
					lapses: 0,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		const beforeRescanCalls = getModifyCalls();

		// Run fullScan again across vault
		await scanner.fullScan();

		// Assert: File was NOT modified, ID remains abc123
		expect(getModifyCalls()).toBe(beforeRescanCalls);
		expect(storage.get('Notes/Japan.md')).toBe(initialMarkdown);

		// Assert: Card scheduling in DB is completely preserved
		const cardsAfterScan = db.getAllCards();
		expect(cardsAfterScan).toHaveLength(1);
		expect(cardsAfterScan[0]!.cardId).toBe(cardId);
		expect(cardsAfterScan[0]!.blockId).toBe('abc123');
		expect(cardsAfterScan[0]!.reps).toBe(6);
		expect(cardsAfterScan[0]!.stability).toBe(15.4);
		expect(cardsAfterScan[0]!.difficulty).toBe(4.1);
		expect(cardsAfterScan[0]!.state).toBe('review');
	});

	it('cross-file duplicate ID causes the second file to mint a new ID while preserving the first file', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const fileAContent = 'Question A :: Answer A ^shared\n';
		const fileBContent = 'Question B :: Answer B ^shared\n';
		const { mockApp, storage } = createMockVault({
			'Notes/FileA.md': fileAContent,
			'Notes/FileB.md': fileBContent,
		});

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		// Scan File A first
		await scanner.syncFile({ path: 'Notes/FileA.md' } as any);
		const cardA = db.getAllCards()[0]!;
		expect(cardA.blockId).toBe('shared');

		// Set review metrics on File A
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: cardA.cardId,
					rating: 3,
					state: 2,
					due_at: 8000,
					stability: 9.0,
					difficulty: 3.5,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: cardA.cardId,
					state: 2,
					due_at: 8000,
					stability: 9.0,
					difficulty: 3.5,
					reps: 3,
					lapses: 0,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		// Scan File B (which copied ^shared)
		await scanner.syncFile({ path: 'Notes/FileB.md' } as any);

		// Assert: File A keeps ^shared and its scheduling
		const allCards = db.getAllCards();
		expect(allCards).toHaveLength(2);

		const updatedCardA = allCards.find((c) => c.notePath === 'Notes/FileA.md')!;
		expect(updatedCardA.blockId).toBe('shared');
		expect(updatedCardA.reps).toBe(3);
		expect(updatedCardA.stability).toBe(9.0);

		// Assert: File B got a brand new ID
		const cardB = allCards.find((c) => c.notePath === 'Notes/FileB.md')!;
		expect(cardB.blockId).not.toBe('shared');
		expect(cardB.blockId).toMatch(/^[0-9a-z]{6}$/);
		expect(storage.get('Notes/FileB.md')).toContain(cardB.blockId);
	});

	it('duplicate ID within the same file mints a new ID for the second block while preserving the first', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const initialMarkdown = 'Question 1 :: Answer 1 ^dup001\nQuestion 2 :: Answer 2 ^dup001\n';
		const { mockApp, storage } = createMockVault({ 'Notes/Dupes.md': initialMarkdown });

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		const blocks = await scanner.syncFile({ path: 'Notes/Dupes.md' } as any);
		expect(blocks).toHaveLength(2);

		// First block kept dup001
		expect(blocks[0]!.id).toBe('dup001');
		// Second block got a newly generated ID
		expect(blocks[1]!.id).not.toBe('dup001');
		expect(blocks[1]!.id).toMatch(/^[0-9a-z]{6}$/);

		const updatedContent = storage.get('Notes/Dupes.md')!;
		expect(updatedContent).toContain('^dup001');
		expect(updatedContent).toContain(`^${blocks[1]!.id}`);
	});

	it('editing question or answer text preserves existing block ID and FSRS card scheduling', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const { mockApp, storage } = createMockVault({
			'Notes/Edit.md': 'Original question :: Original answer ^edit01\n',
		});

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		await scanner.syncFile({ path: 'Notes/Edit.md' } as any);
		const initialCard = db.getAllCards()[0]!;

		// Review card
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: initialCard.cardId,
					rating: 3,
					state: 2,
					due_at: 9999,
					stability: 11.2,
					difficulty: 4.8,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: initialCard.cardId,
					state: 2,
					due_at: 9999,
					stability: 11.2,
					difficulty: 4.8,
					reps: 5,
					lapses: 1,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		// User edits text in note
		storage.set(
			'Notes/Edit.md',
			'Completely rewritten question? :: Brand new polished answer ^edit01\n',
		);

		await scanner.syncFile({ path: 'Notes/Edit.md' } as any);

		// Assert: Block text updated, card scheduling preserved
		const cardsAfterEdit = db.getAllCards();
		expect(cardsAfterEdit).toHaveLength(1);
		expect(cardsAfterEdit[0]!.front).toBe('Completely rewritten question?');
		expect(cardsAfterEdit[0]!.back).toBe('Brand new polished answer');
		expect(cardsAfterEdit[0]!.reps).toBe(5);
		expect(cardsAfterEdit[0]!.lapses).toBe(1);
		expect(cardsAfterEdit[0]!.stability).toBe(11.2);
		expect(cardsAfterEdit[0]!.difficulty).toBe(4.8);
	});

	it('changing card from reversible (:::) to forward (::) prunes reverse card while preserving forward card scheduling', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const { mockApp, storage } = createMockVault({
			'Notes/Reversible.md': 'Front ::: Back ^rev001\n',
		});

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		await scanner.syncFile({ path: 'Notes/Reversible.md' } as any);
		const cards = db.getAllCards();
		expect(cards).toHaveLength(2);

		const forwardCard = cards.find((c) => c.direction === 'forward')!;
		// Review forward card
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: forwardCard.cardId,
					rating: 3,
					state: 2,
					due_at: 12000,
					stability: 7.5,
					difficulty: 4.0,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: forwardCard.cardId,
					state: 2,
					due_at: 12000,
					stability: 7.5,
					difficulty: 4.0,
					reps: 2,
					lapses: 0,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		// Switch to non-reversible
		storage.set('Notes/Reversible.md', 'Front :: Back ^rev001\n');
		await scanner.syncFile({ path: 'Notes/Reversible.md' } as any);

		// Assert: 1 card remains, forward scheduling preserved
		const cardsAfterPrune = db.getAllCards();
		expect(cardsAfterPrune).toHaveLength(1);
		expect(cardsAfterPrune[0]!.direction).toBe('forward');
		expect(cardsAfterPrune[0]!.reps).toBe(2);
		expect(cardsAfterPrune[0]!.stability).toBe(7.5);
	});

	it('changing card from forward (::) to reversible (:::) preserves forward scheduling and creates new reverse card', async () => {
		const rawDb = new SQL.Database();
		const db = DatabaseManager.createInMemory(rawDb);
		const { mockApp, storage } = createMockVault({
			'Notes/Forward.md': 'Front :: Back ^fwd001\n',
		});

		const { NoteScanner } = await import('../src/scanner/NoteScanner.ts');
		const scanner = new NoteScanner(mockApp, db);

		await scanner.syncFile({ path: 'Notes/Forward.md' } as any);
		const forwardCard = db.getAllCards()[0]!;

		// Review forward card
		await db.commitSession(
			{ started_at: 1000, ended_at: 1000, card_count: 1, forgot_count: 0, remembered_count: 1 },
			[
				{
					card_id: forwardCard.cardId,
					rating: 3,
					state: 2,
					due_at: 15000,
					stability: 10.0,
					difficulty: 3.0,
					reviewed_at: 1000,
				},
			],
			[
				{
					id: forwardCard.cardId,
					state: 2,
					due_at: 15000,
					stability: 10.0,
					difficulty: 3.0,
					reps: 4,
					lapses: 0,
					last_review: 1000,
					learning_step: 0,
					relearning_step: 0,
				},
			],
		);

		// Switch to reversible
		storage.set('Notes/Forward.md', 'Front ::: Back ^fwd001\n');
		await scanner.syncFile({ path: 'Notes/Forward.md' } as any);

		// Assert: 2 cards exist, forward retained reps, reverse is new
		const cardsAfterExpansion = db.getAllCards();
		expect(cardsAfterExpansion).toHaveLength(2);

		const forward = cardsAfterExpansion.find((c) => c.direction === 'forward')!;
		expect(forward.reps).toBe(4);
		expect(forward.stability).toBe(10.0);

		const reverse = cardsAfterExpansion.find((c) => c.direction === 'reverse')!;
		expect(reverse.reps).toBe(0);
		expect(reverse.state).toBe('new');
	});
});

describe('Dual-Slot Snapshot Binary Fuzzing & Corruption Resilience', () => {
	it('fuzzes unpackAndVerifySnapshot with truncated and arbitrary random byte sequences', async () => {
		// 1. Truncated inputs (< 48 bytes header)
		for (let len = 0; len < 48; len++) {
			const truncated = new Uint8Array(len);
			for (let i = 0; i < len; i++) truncated[i] = (i * 37) & 0xff;
			const result = await unpackAndVerifySnapshot(truncated);
			expect(result).toBeNull();
		}

		// 2. Random fuzz byte sequences of varying lengths (48 to 1024 bytes)
		for (let trial = 0; trial < 100; trial++) {
			const len = 48 + ((trial * 13) % 500);
			const randomBytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) {
				randomBytes[i] = ((trial + 1) * 31 + i * 17) & 0xff;
			}
			const result = await unpackAndVerifySnapshot(randomBytes);
			// Unless accidentally matching HSHC magic, version 1, exact length, and exact sha256, it must return null
			expect(result).toBeNull();
		}
	});

	it('fuzzes packSnapshot + unpackAndVerifySnapshot round-trip with bit flips and corruption', async () => {
		const headerPrefix = new TextEncoder().encode('SQLite format 3\0');

		for (let trial = 0; trial < 50; trial++) {
			const payloadLen = 16 + ((trial * 41) % 256);
			const payload = new Uint8Array(payloadLen);
			payload.set(headerPrefix, 0);
			for (let i = 16; i < payloadLen; i++) payload[i] = (i ^ trial) & 0xff;

			const sha256 = await computeSha256(payload);
			const generation = BigInt(trial * 1000 + 1);
			const packed = packSnapshot(payload, generation, sha256);

			// Valid round-trip
			const unpacked = await unpackAndVerifySnapshot(packed);
			expect(unpacked).not.toBeNull();
			expect(unpacked!.generation).toBe(generation);
			expect(unpacked!.payload).toEqual(payload);

			// Corrupt random byte in payload
			const corruptedPayload = new Uint8Array(packed);
			const corruptIdx = 48 + (trial % payloadLen);
			corruptedPayload[corruptIdx] = (corruptedPayload[corruptIdx] ?? 0) ^ 0xff;
			const corruptResult = await unpackAndVerifySnapshot(corruptedPayload);
			expect(corruptResult).toBeNull();

			// Corrupt magic byte in header
			const corruptedHeader = new Uint8Array(packed);
			const headerIdx = trial % 4;
			corruptedHeader[headerIdx] = (corruptedHeader[headerIdx] ?? 0) ^ 0x01;
			const headerResult = await unpackAndVerifySnapshot(corruptedHeader);
			expect(headerResult).toBeNull();
		}
	});
});

describe('Todo Tag (#todo/card) Property Fuzzing & Unicode Invariants', () => {
	it('fuzzes toggling on arbitrary markdown and maintains idempotency and block ID placement', () => {
		const sampleBlockIds = ['abc123', '9x2k0p', 'zzz999', '000000'];
		const sampleTexts = [
			'Simple question :: Simple answer',
			'What is the capital of Japan? ::: Tokyo',
			'The speed of light is {{299,792,458 m/s}} in vacuum.',
			'پانی ::: Water #ذخیرہ',
			'Multiple clozes {{one}} and {{two}} in sentence.',
			'Question with `code::here` :: Answer with $x::y$',
			'Question with existing tags #vocab #important :: Answer',
		];

		for (const text of sampleTexts) {
			for (const blockId of sampleBlockIds) {
				const inlineDoc = `${text} ^${blockId}\n`;

				// Toggle ON
				const tagged = toggleCardTodoInMarkdown(inlineDoc, blockId, 'inline');
				expect(tagged).toContain('#todo/card');
				expect(tagged.trimEnd().endsWith(`^${blockId}`)).toBe(true);

				// Toggle OFF
				const untagged = toggleCardTodoInMarkdown(tagged, blockId, 'inline');
				expect(untagged).not.toContain('#todo/card');
				expect(untagged.trimEnd().endsWith(`^${blockId}`)).toBe(true);

				// Block card toggle ON and OFF
				const blockDoc = `%% card-start id=${blockId} %%\n${text}\n...\nAnswer content\n%% card-end %%\n`;
				const taggedBlock = toggleCardTodoInMarkdown(blockDoc, blockId, 'block');
				expect(taggedBlock).toContain('#todo/card');
				expect(taggedBlock).toContain(`%% card-start id=${blockId}`);
				expect(taggedBlock).toContain('%% card-end %%');

				const untaggedBlock = toggleCardTodoInMarkdown(taggedBlock, blockId, 'block');
				expect(untaggedBlock).not.toContain('#todo/card');
				expect(untaggedBlock).toContain(`%% card-start id=${blockId}`);
				expect(untaggedBlock).toContain('%% card-end %%');
			}
		}
	});
});
