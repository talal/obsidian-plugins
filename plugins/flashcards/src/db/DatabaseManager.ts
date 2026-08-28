import type { App, PluginManifest } from 'obsidian';
import type { Database } from 'sql.js';

import type {
	Block,
	CardBlockType,
	CardPerformanceUpdate,
	DashboardStats,
	ParsedBlock,
	ReviewItem,
	ReviewLogEntry,
	ReviewRecord,
	ReviewState,
	SessionRecord,
} from '../types.js';
import { matchCardTags } from '../utils/dashboardFilter.js';
import {
	getStudyDayCutoff,
	getStudyDayKey,
	getStudyDayStart,
	shiftLocalDateKey,
} from '../utils/studyDay.js';
import { WasmBridge } from '../wasm.js';
import SCHEMA_SQL from './schema.sql?raw';
import {
	computeSha256,
	isValidSqliteHeader,
	packSnapshot,
	unpackAndVerifySnapshot,
} from './snapshot.js';

export { getStudyDayCutoff, getStudyDayKey, getStudyDayStart } from '../utils/studyDay.js';

export class DatabaseManager {
	private db: Database | null = null;
	private slotAPath: string;
	private slotBPath: string;
	private activeSlot: 'a' | 'b' = 'a';
	private activeGeneration = 0n;
	private persistQueue: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private manifest: PluginManifest,
	) {
		const dir = this.manifest.dir ?? '.obsidian/plugins/flashcards';
		this.slotAPath = `${dir}/cards.a.db`;
		this.slotBPath = `${dir}/cards.b.db`;
	}

	public static createInMemory(db: Database): DatabaseManager {
		const storage = new Map<string, ArrayBuffer>();
		const mockApp = {
			vault: {
				adapter: {
					exists: async (p: string) => storage.has(p),
					readBinary: async (p: string) => storage.get(p) ?? new ArrayBuffer(0),
					writeBinary: async (p: string, data: ArrayBuffer) => {
						storage.set(p, data.slice(0));
					},
					remove: async (p: string) => {
						storage.delete(p);
					},
				},
			},
		} as unknown as App;
		const mockManifest = { dir: '.obsidian/plugins/flashcards' } as PluginManifest;
		const manager = new DatabaseManager(mockApp, mockManifest);
		manager.db = db;
		manager.db.run('PRAGMA foreign_keys = ON;');
		manager.db.run(SCHEMA_SQL);
		return manager;
	}

	public async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const aExists = await adapter.exists(this.slotAPath);
		const bExists = await adapter.exists(this.slotBPath);

		let slotAData = null;
		let slotBData = null;

		if (aExists) {
			try {
				const bytesA = new Uint8Array(await adapter.readBinary(this.slotAPath));
				slotAData = await unpackAndVerifySnapshot(bytesA);
			} catch {
				slotAData = null;
			}
		}

		if (bExists) {
			try {
				const bytesB = new Uint8Array(await adapter.readBinary(this.slotBPath));
				slotBData = await unpackAndVerifySnapshot(bytesB);
			} catch {
				slotBData = null;
			}
		}

		let payloadToLoad: Uint8Array | undefined;
		if (slotAData && slotBData) {
			if (slotBData.generation > slotAData.generation) {
				payloadToLoad = slotBData.payload;
				this.activeSlot = 'b';
				this.activeGeneration = slotBData.generation;
			} else {
				payloadToLoad = slotAData.payload;
				this.activeSlot = 'a';
				this.activeGeneration = slotAData.generation;
			}
		} else if (slotAData) {
			payloadToLoad = slotAData.payload;
			this.activeSlot = 'a';
			this.activeGeneration = slotAData.generation;
		} else if (slotBData) {
			payloadToLoad = slotBData.payload;
			this.activeSlot = 'b';
			this.activeGeneration = slotBData.generation;
		} else {
			this.activeSlot = 'a';
			this.activeGeneration = 0n;
		}

		this.db = WasmBridge.createDatabase(payloadToLoad);
		this.db.run('PRAGMA foreign_keys = ON;');
		this.db.run(SCHEMA_SQL);
		this.db.run('DELETE FROM cards WHERE block_id NOT IN (SELECT id FROM blocks);');
	}

	public async persist(): Promise<void> {
		const next = this.persistQueue.catch(() => undefined).then(() => this.persistNow());
		this.persistQueue = next.catch((error) => {
			console.error('Failed to persist flashcards database snapshot:', error);
		});
		await next;
	}

	private async persistNow(): Promise<void> {
		if (!this.db) return;
		const payload = this.db.export();
		if (!isValidSqliteHeader(payload)) {
			throw new Error('Exported database buffer is not a valid SQLite database.');
		}

		const sha256 = await computeSha256(payload);
		const targetSlot: 'a' | 'b' = this.activeSlot === 'a' ? 'b' : 'a';
		const targetGen = this.activeGeneration + 1n;
		const targetPath = targetSlot === 'a' ? this.slotAPath : this.slotBPath;

		const packed = packSnapshot(payload, targetGen, sha256);
		const adapter = this.app.vault.adapter;

		await adapter.writeBinary(
			targetPath,
			packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer,
		);

		// Read-back verification
		const readBack = new Uint8Array(await adapter.readBinary(targetPath));
		const verified = await unpackAndVerifySnapshot(readBack);
		if (!verified || verified.generation !== targetGen) {
			throw new Error(`Dual-slot read-back verification failed for slot ${targetSlot}`);
		}

		this.activeSlot = targetSlot;
		this.activeGeneration = targetGen;
	}

	public getActiveSlot(): { slot: 'a' | 'b'; generation: bigint } {
		return { slot: this.activeSlot, generation: this.activeGeneration };
	}

	public upsertBlock(block: Block): void {
		if (!this.db) return;
		this.db.run(
			`INSERT INTO blocks (id, file_path, block_type, reversible, front, back, tags, content_hash, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   file_path = excluded.file_path,
			   block_type = excluded.block_type,
			   reversible = excluded.reversible,
			   front = excluded.front,
			   back = excluded.back,
			   tags = excluded.tags,
			   content_hash = excluded.content_hash,
			   updated_at = excluded.updated_at`,
			[
				block.id,
				block.file_path,
				block.block_type,
				block.reversible,
				block.front,
				block.back,
				block.tags,
				block.content_hash,
				block.updated_at,
			],
		);
	}

	public reconcileCards(block: Block): void {
		if (!this.db) return;
		const now = Date.now();

		if (block.block_type === 'cloze') {
			this.db.run('DELETE FROM cards WHERE block_id = ? AND direction IS NOT NULL', [block.id]);
			this.db.run(
				`INSERT OR IGNORE INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
				 VALUES (?, NULL, 0, ?, 0.0, 0.0, 0, 0, NULL, 0, 0)`,
				[block.id, now],
			);
		} else {
			const neededDirs: ('forward' | 'reverse')[] =
				block.reversible === 1 ? ['forward', 'reverse'] : ['forward'];

			const placeholders = neededDirs.map(() => '?').join(',');
			this.db.run(
				`DELETE FROM cards WHERE block_id = ? AND (direction IS NULL OR direction NOT IN (${placeholders}))`,
				[block.id, ...neededDirs],
			);

			for (const dir of neededDirs) {
				this.db.run(
					`INSERT OR IGNORE INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
					 VALUES (?, ?, 0, ?, 0.0, 0.0, 0, 0, NULL, 0, 0)`,
					[block.id, dir, now],
				);
			}
		}
	}

	public syncNoteBlocks(filePath: string, parsedBlocks: ParsedBlock[]): void {
		if (!this.db) return;
		const now = Date.now();
		const incomingIds = new Set(parsedBlocks.map((b) => b.id));

		this.db.run('BEGIN TRANSACTION');
		try {
			const stmt = this.db.prepare('SELECT id FROM blocks WHERE file_path = ?');
			stmt.bind([filePath]);
			const toDelete: string[] = [];
			while (stmt.step()) {
				const id = stmt.getAsObject().id as string;
				if (!incomingIds.has(id)) {
					toDelete.push(id);
				}
			}
			stmt.free();

			for (const oldId of toDelete) {
				this.db.run('DELETE FROM blocks WHERE id = ?', [oldId]);
			}

			for (const b of parsedBlocks) {
				const blockRecord: Block = {
					id: b.id,
					file_path: filePath,
					block_type: b.block_type,
					reversible: b.reversible ? 1 : 0,
					front: b.front,
					back: b.back,
					tags: b.tags.join(' '),
					content_hash: b.content_hash,
					updated_at: now,
				};
				this.upsertBlock(blockRecord);
				this.reconcileCards(blockRecord);
			}

			this.db.run('COMMIT');
		} catch (error) {
			this.db.run('ROLLBACK');
			throw error;
		}
	}

	public pruneDeletedNotes(validFilePaths: Set<string>): void {
		if (!this.db) return;
		const stmt = this.db.prepare('SELECT DISTINCT file_path FROM blocks');
		const toDelete: string[] = [];
		while (stmt.step()) {
			const path = stmt.getAsObject().file_path as string;
			if (!validFilePaths.has(path)) {
				toDelete.push(path);
			}
		}
		stmt.free();

		for (const path of toDelete) {
			this.db.run('DELETE FROM blocks WHERE file_path = ?', [path]);
		}
	}

	public renameNote(oldPath: string, newPath: string): void {
		if (!this.db) return;
		this.db.run('UPDATE blocks SET file_path = ? WHERE file_path = ?', [newPath, oldPath]);
	}

	public getAllBlockIds(): Set<string> {
		if (!this.db) return new Set();
		const ids = new Set<string>();
		const stmt = this.db.prepare('SELECT id FROM blocks');
		while (stmt.step()) {
			ids.add(stmt.getAsObject().id as string);
		}
		stmt.free();
		return ids;
	}

	public getDueCards(filterTags?: string[], rolloverHour = 4): ReviewItem[] {
		if (!this.db) return [];
		const cutoff = getStudyDayCutoff(rolloverHour);
		const items: ReviewItem[] = [];

		const query = `
			SELECT c.id as card_id, c.block_id, c.direction, c.state, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.last_review, c.learning_step, c.relearning_step,
			       b.file_path, b.block_type, b.reversible, b.front, b.back, b.tags, b.content_hash, b.updated_at
			FROM cards c
			JOIN blocks b ON c.block_id = b.id
			WHERE c.due_at <= ?
			ORDER BY c.due_at ASC
		`;

		const stmt = this.db.prepare(query);
		stmt.bind([cutoff]);

		while (stmt.step()) {
			const row = stmt.getAsObject();
			const tags = ((row.tags as string) || '').split(' ').filter(Boolean);

			if (filterTags && filterTags.length > 0) {
				if (!matchCardTags(tags, filterTags)) continue;
			}

			const filePath = row.file_path as string;
			const noteTitle = filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;
			const direction = (row.direction as 'forward' | 'reverse' | null) ?? null;
			const blockType = row.block_type as CardBlockType;
			const reversible = (row.reversible as number) === 1;

			let front = row.front as string;
			let back = row.back as string;
			if (direction === 'reverse') {
				front = row.back as string;
				back = row.front as string;
			}

			items.push({
				cardId: row.card_id as number,
				blockId: row.block_id as string,
				noteTitle,
				notePath: filePath,
				direction,
				blockType,
				reversible,
				front,
				back,
				tags,
				state: this.mapState(row.state as number),
				stateNum: row.state as number,
				dueAt: row.due_at as number,
				dueHuman: this.humanizeDue(row.due_at as number),
				stability: row.stability as number,
				difficulty: row.difficulty as number,
				reps: row.reps as number,
				lapses: row.lapses as number,
				learningStep: row.learning_step as number,
				relearningStep: row.relearning_step as number,
				lastReview: (row.last_review as number) || null,
				lastPracticedHuman: row.last_review
					? this.humanizeRelative(row.last_review as number)
					: 'Never',
			});
		}
		stmt.free();
		return items;
	}

	public getAllCards(): ReviewItem[] {
		if (!this.db) return [];
		const items: ReviewItem[] = [];

		const query = `
			SELECT c.id as card_id, c.block_id, c.direction, c.state, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.last_review, c.learning_step, c.relearning_step,
			       b.file_path, b.block_type, b.reversible, b.front, b.back, b.tags, b.content_hash, b.updated_at
			FROM cards c
			JOIN blocks b ON c.block_id = b.id
			ORDER BY c.due_at ASC
		`;

		const stmt = this.db.prepare(query);
		while (stmt.step()) {
			const row = stmt.getAsObject();
			const tags = ((row.tags as string) || '').split(' ').filter(Boolean);
			const filePath = row.file_path as string;
			const noteTitle = filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;
			const direction = (row.direction as 'forward' | 'reverse' | null) ?? null;
			const blockType = row.block_type as CardBlockType;
			const reversible = (row.reversible as number) === 1;

			let front = row.front as string;
			let back = row.back as string;
			if (direction === 'reverse') {
				front = row.back as string;
				back = row.front as string;
			}

			items.push({
				cardId: row.card_id as number,
				blockId: row.block_id as string,
				noteTitle,
				notePath: filePath,
				direction,
				blockType,
				reversible,
				front,
				back,
				tags,
				state: this.mapState(row.state as number),
				stateNum: row.state as number,
				dueAt: row.due_at as number,
				dueHuman: this.humanizeDue(row.due_at as number),
				stability: row.stability as number,
				difficulty: row.difficulty as number,
				reps: row.reps as number,
				lapses: row.lapses as number,
				learningStep: row.learning_step as number,
				relearningStep: row.relearning_step as number,
				lastReview: (row.last_review as number) || null,
				lastPracticedHuman: row.last_review
					? this.humanizeRelative(row.last_review as number)
					: 'Never',
			});
		}
		stmt.free();
		return items;
	}

	public getUniqueTags(): string[] {
		if (!this.db) return [];
		const tagsSet = new Set<string>();
		const stmt = this.db.prepare('SELECT tags FROM blocks');
		while (stmt.step()) {
			const row = stmt.getAsObject();
			const tags = ((row.tags as string) || '').split(' ').filter(Boolean);
			for (const t of tags) tagsSet.add(t);
		}
		stmt.free();
		return Array.from(tagsSet).sort();
	}

	public getDashboardStats(rolloverHour = 4): DashboardStats {
		if (!this.db) {
			return {
				studiedToday: 0,
				dailyRetention: 100,
				studyStreak: 0,
				totalCards: 0,
				dueToday: 0,
				newCards: 0,
			};
		}

		const startOfDayMs = getStudyDayStart(rolloverHour);
		const endOfDayMs = getStudyDayCutoff(rolloverHour);

		const logStmt = this.db.prepare(`
			SELECT COUNT(*) as count,
			       SUM(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) as remembered
			FROM reviews
			WHERE reviewed_at >= ? AND reviewed_at < ?
		`);
		logStmt.bind([startOfDayMs, endOfDayMs]);
		let studiedToday = 0;
		let rememberedToday = 0;
		if (logStmt.step()) {
			const row = logStmt.getAsObject();
			studiedToday = (row.count as number) || 0;
			rememberedToday = (row.remembered as number) || 0;
		}
		logStmt.free();

		const dailyRetention =
			studiedToday > 0 ? Math.round((rememberedToday / studiedToday) * 100) : 100;

		const streakStmt = this.db.prepare('SELECT reviewed_at FROM reviews ORDER BY reviewed_at DESC');
		const days = new Set<string>();
		const currentDay = getStudyDayKey(Date.now(), rolloverHour);
		const yesterday = shiftLocalDateKey(currentDay, -1);
		let expectedDay: string | null = null;
		let studyStreak = 0;

		while (streakStmt.step()) {
			const dayKey = getStudyDayKey(streakStmt.getAsObject().reviewed_at as number, rolloverHour);
			days.add(dayKey);

			if (expectedDay === null) {
				if (days.has(currentDay)) {
					expectedDay = currentDay;
				} else if (days.has(yesterday)) {
					expectedDay = yesterday;
				} else if (dayKey < yesterday) {
					break;
				}
			}

			if (expectedDay !== null) {
				while (days.has(expectedDay)) {
					studyStreak++;
					expectedDay = shiftLocalDateKey(expectedDay, -1);
				}
				if (dayKey < expectedDay) {
					break;
				}
			}
		}
		streakStmt.free();

		let totalCards = 0;
		let dueToday = 0;
		let newCards = 0;

		const cardStmt = this.db.prepare(
			'SELECT c.state, c.due_at FROM cards c JOIN blocks b ON c.block_id = b.id',
		);
		while (cardStmt.step()) {
			const row = cardStmt.getAsObject();
			totalCards++;
			const state = row.state as number;
			const due = row.due_at as number;
			if (state === 0) newCards++;
			if (due <= endOfDayMs) dueToday++;
		}
		cardStmt.free();

		return {
			studiedToday,
			dailyRetention,
			studyStreak,
			totalCards,
			dueToday,
			newCards,
		};
	}

	public async commitSession(
		session: SessionRecord,
		reviews: ReviewRecord[],
		cardUpdates: CardPerformanceUpdate[],
	): Promise<number> {
		if (!this.db) return 0;
		this.db.run('BEGIN TRANSACTION');
		let sessionId = 0;
		try {
			this.db.run(
				`INSERT INTO sessions (started_at, ended_at, card_count, forgot_count, remembered_count)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					session.started_at,
					session.ended_at,
					session.card_count,
					session.forgot_count,
					session.remembered_count,
				],
			);

			const idStmt = this.db.prepare('SELECT last_insert_rowid() as id');
			idStmt.step();
			sessionId = idStmt.getAsObject().id as number;
			idStmt.free();

			for (const r of reviews) {
				this.db.run(
					`INSERT INTO reviews (session_id, card_id, rating, state, due_at, stability, difficulty, reviewed_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						sessionId,
						r.card_id,
						r.rating,
						r.state,
						r.due_at,
						r.stability,
						r.difficulty,
						r.reviewed_at,
					],
				);
			}

			for (const c of cardUpdates) {
				this.db.run(
					`UPDATE cards
					 SET state = ?, due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?,
					     last_review = ?, learning_step = ?, relearning_step = ?
					 WHERE id = ?`,
					[
						c.state,
						c.due_at,
						c.stability,
						c.difficulty,
						c.reps,
						c.lapses,
						c.last_review,
						c.learning_step,
						c.relearning_step,
						c.id,
					],
				);
			}

			this.db.run('COMMIT');
		} catch (error) {
			this.db.run('ROLLBACK');
			throw error;
		}

		await this.persist();
		return sessionId;
	}

	public getReviewLogsForOptimization(): ReviewLogEntry[] {
		if (!this.db) return [];
		const stmt = this.db.prepare(`
			SELECT card_id, rating, reviewed_at,
			       COALESCE(
			           LAG(reviewed_at) OVER (PARTITION BY card_id ORDER BY reviewed_at ASC, id ASC),
			           reviewed_at
			       ) as prev_time
			FROM reviews
			ORDER BY reviewed_at ASC, id ASC
		`);
		const logs: ReviewLogEntry[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			const rating = row.rating as number;
			const reviewTime = row.reviewed_at as number;
			const prevTime = row.prev_time as number;
			const deltaMs = Math.max(0, reviewTime - prevTime);
			const deltaT = deltaMs / (1000 * 60 * 60 * 24);
			logs.push({
				card_id: String(row.card_id),
				rating,
				delta_t: deltaT,
			});
		}
		stmt.free();
		return logs;
	}

	public async optimizeDatabase(validFilePaths?: Set<string>): Promise<{
		prunedBlocks: number;
		integrityOk: boolean;
	}> {
		if (!this.db) return { prunedBlocks: 0, integrityOk: false };
		this.db.run('PRAGMA foreign_keys = ON;');

		let prunedBlocks = 0;
		if (validFilePaths) {
			const stmt = this.db.prepare('SELECT id, file_path FROM blocks');
			const toDelete: string[] = [];
			while (stmt.step()) {
				const row = stmt.getAsObject();
				if (!validFilePaths.has(row.file_path as string)) {
					toDelete.push(row.id as string);
				}
			}
			stmt.free();

			for (const id of toDelete) {
				this.db.run('DELETE FROM blocks WHERE id = ?', [id]);
				prunedBlocks++;
			}
		}

		this.db.run('DELETE FROM cards WHERE block_id NOT IN (SELECT id FROM blocks);');
		this.db.run('DELETE FROM reviews WHERE card_id NOT IN (SELECT id FROM cards);');

		let integrityOk = true;
		const checkStmt = this.db.prepare('PRAGMA integrity_check;');
		if (checkStmt.step()) {
			const res = checkStmt.getAsObject();
			const val = Object.values(res)[0];
			if (val !== 'ok') {
				integrityOk = false;
			}
		}
		checkStmt.free();

		this.db.run('VACUUM;');
		this.db.run('PRAGMA optimize;');
		await this.persist();

		return {
			prunedBlocks,
			integrityOk,
		};
	}

	public mapState(stateNum: number): ReviewState {
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

	public unmapState(state: ReviewState): number {
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

	public humanizeDue(dueMs: number, now = Date.now()): string {
		const diff = dueMs - now;
		if (diff <= 0) return 'Due now';
		const days = Math.round(diff / (1000 * 60 * 60 * 24));
		if (days === 0) return 'Today';
		if (days === 1) return 'Tomorrow';
		return `In ${days} days`;
	}

	public humanizeRelative(ms: number, now = Date.now()): string {
		const diff = now - ms;
		if (diff < 0) return 'Just now';
		const mins = Math.floor(diff / (1000 * 60));
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
}
