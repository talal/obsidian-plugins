import type { App, PluginManifest } from 'obsidian';
import type { Database } from 'sql.js';
import type {
	DashboardStats,
	ParsedBlock,
	ReviewItem,
	ReviewLogEntry,
	ReviewState,
	SchedulingCard,
} from '../types.js';
import { matchCardTags } from '../utils/dashboardFilter.js';
import { WasmBridge } from '../wasm.js';
import { SCHEMA_SQL } from './schema.js';

export function getStudyDayStart(rolloverHour = 4, now = new Date()): number {
	const start = new Date(now.getTime());
	if (now.getHours() < rolloverHour) {
		start.setDate(start.getDate() - 1);
	}
	start.setHours(rolloverHour, 0, 0, 0);
	return start.getTime();
}

export function getStudyDayCutoff(rolloverHour = 4, now = new Date()): number {
	const cutoff = new Date(now.getTime());
	if (now.getHours() < rolloverHour) {
		cutoff.setHours(rolloverHour, 0, 0, 0);
	} else {
		cutoff.setDate(cutoff.getDate() + 1);
		cutoff.setHours(rolloverHour, 0, 0, 0);
	}
	return cutoff.getTime();
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function getStudyDayKey(timestampMs: number, rolloverHour = 4): string {
	const date = new Date(timestampMs);
	if (date.getHours() < rolloverHour) {
		date.setDate(date.getDate() - 1);
	}
	return formatLocalDate(date);
}

function shiftLocalDateKey(key: string, days: number): string {
	const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
	const date = new Date(year, month - 1, day);
	date.setDate(date.getDate() + days);
	return formatLocalDate(date);
}

export class DatabaseManager {
	private db: Database | null = null;
	private dbPath: string;
	private tempDbPath: string;
	private persistQueue: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private manifest: PluginManifest,
	) {
		const dir = this.manifest.dir ?? '.obsidian/plugins/flashcards';
		this.dbPath = `${dir}/cards.db`;
		this.tempDbPath = `${dir}/cards.db.writing`;
	}

	public static createInMemory(db: Database): DatabaseManager {
		const mockApp = {
			vault: {
				adapter: {
					exists: async () => false,
					readBinary: async () => new Uint8Array(),
					writeBinary: async () => {},
					remove: async () => {},
				},
			},
		} as unknown as App;
		const mockManifest = { dir: '.obsidian/plugins/flashcards' } as PluginManifest;
		const manager = new DatabaseManager(mockApp, mockManifest);
		manager.db = db;
		manager.db.run('PRAGMA foreign_keys = ON;');
		manager.db.run(SCHEMA_SQL);
		manager.ensureColumn('review_items', 'learning_step', 'INTEGER NOT NULL DEFAULT 0');
		manager.ensureColumn('review_items', 'relearning_step', 'INTEGER NOT NULL DEFAULT 0');
		return manager;
	}

	public async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const dbExists = await adapter.exists(this.dbPath);
		const tempExists = await adapter.exists(this.tempDbPath);
		const dbBytes = dbExists ? await this.readValidDatabase(this.dbPath) : null;
		const tempBytes = tempExists ? await this.readValidDatabase(this.tempDbPath) : null;

		if (tempBytes) {
			// The temporary file is the newest complete export. Promote it even when
			// cards.db is also valid; this covers a crash between the two writes.
			try {
				await this.promoteTemporaryDatabase(adapter, tempBytes);
			} catch (e) {
				console.warn('Failed to promote cards.db.writing:', e);
			}
		} else if (!dbBytes && (dbExists || tempExists)) {
			throw new Error('Flashcards database is corrupted and no valid recovery copy exists.');
		}

		this.db = WasmBridge.createDatabase(tempBytes ?? dbBytes ?? undefined);
		this.db.run('PRAGMA foreign_keys = ON;');

		// Deduplicate any legacy duplicate note paths before applying unique index
		try {
			this.db.run(`
				DELETE FROM notes WHERE rowid NOT IN (
					SELECT rowid FROM (
						SELECT rowid, ROW_NUMBER() OVER (
							PARTITION BY path
							ORDER BY mtime DESC, rowid DESC
						) AS rn
						FROM notes
					) WHERE rn = 1
				);
			`);
		} catch {
			// Ignore if fresh database where notes table does not exist yet
		}

		this.db.run(SCHEMA_SQL);
		this.ensureColumn('notes', 'ignored', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureColumn('review_items', 'learning_step', 'INTEGER NOT NULL DEFAULT 0');
		this.ensureColumn('review_items', 'relearning_step', 'INTEGER NOT NULL DEFAULT 0');
	}

	public async persist(): Promise<void> {
		const next = this.persistQueue.catch(() => undefined).then(() => this.persistNow());
		this.persistQueue = next.catch((error) => {
			console.error('Failed to persist flashcards database:', error);
		});
		await next;
	}

	private isValidSqliteHeader(bytes: Uint8Array): boolean {
		if (bytes.length < 16) return false;
		const header = 'SQLite format 3\0';
		for (let i = 0; i < 16; i++) {
			if (bytes[i] !== header.charCodeAt(i)) return false;
		}
		return true;
	}

	private async persistNow(): Promise<void> {
		if (!this.db) return;
		const exported = this.db.export();
		if (!this.isValidSqliteHeader(exported)) {
			throw new Error('Exported database buffer is not a valid SQLite database.');
		}
		const adapter = this.app.vault.adapter;
		const bytes = exported.buffer.slice(
			exported.byteOffset,
			exported.byteOffset + exported.byteLength,
		) as ArrayBuffer;

		await adapter.writeBinary(this.tempDbPath, bytes);
		await this.promoteTemporaryDatabase(adapter, exported);
	}

	private async readValidDatabase(path: string): Promise<Uint8Array | null> {
		let testDb: Database | null = null;
		try {
			const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
			testDb = WasmBridge.createDatabase(bytes);
			const check = testDb.prepare('PRAGMA integrity_check;');
			let valid = false;
			if (check.step()) {
				valid = Object.values(check.getAsObject())[0] === 'ok';
			}
			check.free();
			return valid ? bytes : null;
		} catch {
			return null;
		} finally {
			testDb?.close();
		}
	}

	private async promoteTemporaryDatabase(
		adapter: App['vault']['adapter'],
		bytes: Uint8Array,
	): Promise<void> {
		try {
			await adapter.rename(this.tempDbPath, this.dbPath);
		} catch {
			// Some adapters do not replace an existing destination on rename. Keep
			// the validated temporary copy until the replacement write succeeds.
			await adapter.writeBinary(this.dbPath, bytes.slice().buffer as ArrayBuffer);
			if (await adapter.exists(this.tempDbPath)) {
				await adapter.remove(this.tempDbPath);
			}
		}
	}

	private ensureColumn(table: string, column: string, definition: string): void {
		if (!this.db) return;
		const columns = this.db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? [];
		if (!columns.some((row) => row[1] === column)) {
			this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
	}

	public getNotePathById(noteId: string): string | null {
		if (!this.db) return null;
		const stmt = this.db.prepare('SELECT path FROM notes WHERE note_id = ?');
		stmt.bind([noteId]);
		let path: string | null = null;
		if (stmt.step()) {
			path = stmt.getAsObject().path as string;
		}
		stmt.free();
		return path;
	}

	public upsertNote(noteId: string, path: string, mtime: number, ignored = 0): void {
		if (!this.db) return;
		// Clean up any old orphaned note entry that previously had this path under a different ID
		this.db.run('DELETE FROM notes WHERE path = ? AND note_id != ?', [path, noteId]);
		this.db.run(
			`INSERT INTO notes (note_id, path, mtime, ignored) VALUES (?, ?, ?, ?)
			 ON CONFLICT(note_id) DO UPDATE SET path = excluded.path, mtime = excluded.mtime, ignored = excluded.ignored`,
			[noteId, path, mtime, ignored],
		);
	}

	public setNoteIgnoredByPath(path: string, ignored: boolean, mtime?: number): void {
		if (!this.db) return;
		const ignoredVal = ignored ? 1 : 0;
		if (mtime !== undefined) {
			this.db.run('UPDATE notes SET ignored = ?, mtime = ? WHERE path = ?', [
				ignoredVal,
				mtime,
				path,
			]);
		} else {
			this.db.run('UPDATE notes SET ignored = ? WHERE path = ?', [ignoredVal, path]);
		}
	}

	public deleteNoteByPath(path: string): void {
		if (!this.db) return;
		this.db.run('DELETE FROM notes WHERE path = ?', [path]);
	}

	public pruneDeletedNotes(validPaths: Set<string>): void {
		if (!this.db) return;
		const stmt = this.db.prepare('SELECT note_id, path FROM notes');
		const toDelete: string[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			if (!validPaths.has(row.path as string)) {
				toDelete.push(row.note_id as string);
			}
		}
		stmt.free();
		for (const noteId of toDelete) {
			this.db.run('DELETE FROM notes WHERE note_id = ?', [noteId]);
		}
	}

	public async optimizeDatabase(validVaultPaths?: Set<string>): Promise<{
		prunedNotes: number;
		cleanedBlocks: number;
		cleanedItems: number;
		integrityOk: boolean;
	}> {
		if (!this.db) {
			return { prunedNotes: 0, cleanedBlocks: 0, cleanedItems: 0, integrityOk: false };
		}

		// 1. Enforce foreign keys
		this.db.run('PRAGMA foreign_keys = ON;');

		// 2. Prune deleted notes if validPaths provided
		let prunedNotes = 0;
		if (validVaultPaths) {
			const stmt = this.db.prepare('SELECT note_id, path FROM notes');
			const toDelete: string[] = [];
			while (stmt.step()) {
				const row = stmt.getAsObject();
				if (!validVaultPaths.has(row.path as string)) {
					toDelete.push(row.note_id as string);
				}
			}
			stmt.free();
			for (const noteId of toDelete) {
				this.db.run('DELETE FROM notes WHERE note_id = ?', [noteId]);
				prunedNotes++;
			}
		}

		// 3. Clean up any orphaned blocks or review items
		const preBlocks =
			(this.db.exec('SELECT COUNT(*) as count FROM blocks')[0]?.values[0]?.[0] as number) ?? 0;
		this.db.run('DELETE FROM blocks WHERE note_id NOT IN (SELECT note_id FROM notes)');
		const postBlocks =
			(this.db.exec('SELECT COUNT(*) as count FROM blocks')[0]?.values[0]?.[0] as number) ?? 0;
		const cleanedBlocks = preBlocks - postBlocks;

		const preItems =
			(this.db.exec('SELECT COUNT(*) as count FROM review_items')[0]?.values[0]?.[0] as number) ??
			0;
		this.db.run(
			'DELETE FROM review_items WHERE note_id NOT IN (SELECT note_id FROM notes) OR (note_id, block_id) NOT IN (SELECT note_id, block_id FROM blocks)',
		);
		const postItems =
			(this.db.exec('SELECT COUNT(*) as count FROM review_items')[0]?.values[0]?.[0] as number) ??
			0;
		const cleanedItems = preItems - postItems;

		// 4. Integrity check
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

		// 5. VACUUM and optimize query planner
		this.db.run('VACUUM;');
		this.db.run('PRAGMA optimize;');

		await this.persist();

		return {
			prunedNotes,
			cleanedBlocks,
			cleanedItems,
			integrityOk,
		};
	}

	public syncNoteBlocks(noteId: string, parsedBlocks: ParsedBlock[]): void {
		if (!this.db) return;

		const existingBlockIds: string[] = [];
		const stmt = this.db.prepare('SELECT block_id FROM blocks WHERE note_id = ?');
		stmt.bind([noteId]);
		while (stmt.step()) {
			const row = stmt.getAsObject();
			existingBlockIds.push(row.block_id as string);
		}
		stmt.free();

		const incomingBlockIds = new Set(parsedBlocks.map((b) => b.block_id));
		const now = Date.now();

		// Delete deleted blocks
		this.db.run('BEGIN TRANSACTION');
		try {
			for (const oldId of existingBlockIds) {
				if (!incomingBlockIds.has(oldId)) {
					this.db.run('DELETE FROM blocks WHERE note_id = ? AND block_id = ?', [noteId, oldId]);
				}
			}

			// Upsert incoming blocks and generate review items
			for (const b of parsedBlocks) {
				const tagsStr = b.tags.join(' ');
				this.db.run(
					`INSERT INTO blocks (note_id, block_id, block_type, direction, front_raw, back_raw, tags, content_hash, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(note_id, block_id) DO UPDATE SET
					   block_type = excluded.block_type,
					   direction = excluded.direction,
					   front_raw = excluded.front_raw,
					   back_raw = excluded.back_raw,
					   tags = excluded.tags,
					   content_hash = excluded.content_hash,
					   updated_at = excluded.updated_at`,
					[
						noteId,
						b.block_id,
						b.card_type,
						b.direction,
						b.front_raw,
						b.back_raw,
						tagsStr,
						b.content_hash,
						now,
						now,
					],
				);

				// Directional Review Items
				const directions: ('forward' | 'reverse')[] =
					b.direction === 'both'
						? ['forward', 'reverse']
						: [b.direction === 'reverse' ? 'reverse' : 'forward'];

				// Prune any obsolete review items for this block (e.g. converted from both to forward)
				const placeholders = directions.map(() => '?').join(',');
				this.db.run(
					`DELETE FROM review_items WHERE note_id = ? AND block_id = ? AND direction NOT IN (${placeholders})`,
					[noteId, b.block_id, ...directions],
				);

				for (const dir of directions) {
					const itemId = `${noteId}:${b.block_id}:${dir}`;
					this.db.run(
						`INSERT OR IGNORE INTO review_items (id, note_id, block_id, direction, state, due, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
						 VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, 0, NULL, 0, 0)`,
						[itemId, noteId, b.block_id, dir, now],
					);
				}
			}
			this.db.run('COMMIT');
		} catch (error) {
			this.db.run('ROLLBACK');
			throw error;
		}
	}

	public getDueReviewItems(filterTags?: string[], rolloverHour = 4): ReviewItem[] {
		if (!this.db) return [];
		const cutoff = getStudyDayCutoff(rolloverHour);
		const items: ReviewItem[] = [];

		const query = `
			SELECT r.id, r.note_id, r.block_id, r.direction, r.state, r.due, r.stability, r.difficulty, r.reps, r.lapses, r.last_review, r.learning_step, r.relearning_step,
			       b.block_type, b.front_raw, b.back_raw, b.tags, n.path
			FROM review_items r
			JOIN blocks b ON r.note_id = b.note_id AND r.block_id = b.block_id
			JOIN notes n ON r.note_id = n.note_id
			WHERE n.ignored = 0 AND r.due <= ?
			ORDER BY r.due ASC
		`;

		const stmt = this.db.prepare(query);
		stmt.bind([cutoff]);

		while (stmt.step()) {
			const row = stmt.getAsObject();
			const tags = ((row.tags as string) || '').split(' ').filter(Boolean);

			if (filterTags && filterTags.length > 0) {
				if (!matchCardTags(tags, filterTags)) continue;
			}

			const notePath = row.path as string;
			const noteTitle = notePath.split('/').pop()?.replace(/\.md$/, '') || notePath;
			const direction = row.direction as 'forward' | 'reverse';

			let front = row.front_raw as string;
			let back = row.back_raw as string;
			if (direction === 'reverse') {
				front = row.back_raw as string;
				back = row.front_raw as string;
			}

			items.push({
				id: row.id as string,
				noteId: row.note_id as string,
				blockId: row.block_id as string,
				noteTitle,
				notePath,
				direction,
				cardType: row.block_type as any,
				front,
				back,
				tags,
				state: this.mapState(row.state as number),
				due: row.due as number,
				dueHuman: this.humanizeDue(row.due as number),
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
			SELECT r.id, r.note_id, r.block_id, r.direction, r.state, r.due, r.stability, r.difficulty, r.reps, r.lapses, r.last_review, r.learning_step, r.relearning_step,
			       b.block_type, b.front_raw, b.back_raw, b.tags, n.path
			FROM review_items r
			JOIN blocks b ON r.note_id = b.note_id AND r.block_id = b.block_id
			JOIN notes n ON r.note_id = n.note_id
			WHERE n.ignored = 0
			ORDER BY r.due ASC
		`;

		const stmt = this.db.prepare(query);
		while (stmt.step()) {
			const row = stmt.getAsObject();
			const tags = ((row.tags as string) || '').split(' ').filter(Boolean);
			const notePath = row.path as string;
			const noteTitle = notePath.split('/').pop()?.replace(/\.md$/, '') || notePath;
			const direction = row.direction as 'forward' | 'reverse';

			let front = row.front_raw as string;
			let back = row.back_raw as string;
			if (direction === 'reverse') {
				front = row.back_raw as string;
				back = row.front_raw as string;
			}

			items.push({
				id: row.id as string,
				noteId: row.note_id as string,
				blockId: row.block_id as string,
				noteTitle,
				notePath,
				direction,
				cardType: row.block_type as any,
				front,
				back,
				tags,
				state: this.mapState(row.state as number),
				due: row.due as number,
				dueHuman: this.humanizeDue(row.due as number),
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
		const stmt = this.db.prepare(
			'SELECT b.tags FROM blocks b JOIN notes n ON b.note_id = n.note_id WHERE n.ignored = 0',
		);
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

		// Studied today from review logs
		const logStmt = this.db.prepare(`
			SELECT COUNT(*) as count,
			       SUM(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) as remembered
			FROM review_logs
			WHERE review_time >= ? AND review_time < ?
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

		// Calculate consecutive active study days using the user's local timezone.
		const streakStmt = this.db.prepare(
			'SELECT review_time FROM review_logs ORDER BY review_time DESC',
		);
		const days = new Set<string>();
		const currentDay = getStudyDayKey(Date.now(), rolloverHour);
		const yesterday = shiftLocalDateKey(currentDay, -1);
		let expectedDay: string | null = null;
		let studyStreak = 0;

		while (streakStmt.step()) {
			const dayKey = getStudyDayKey(streakStmt.getAsObject().review_time as number, rolloverHour);
			days.add(dayKey);

			if (expectedDay === null) {
				if (days.has(currentDay)) {
					expectedDay = currentDay;
				} else if (days.has(yesterday)) {
					expectedDay = yesterday;
				} else if (dayKey < yesterday) {
					// No reviews today or yesterday -> streak is 0, exit early
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
			'SELECT r.state, r.due FROM review_items r JOIN notes n ON r.note_id = n.note_id WHERE n.ignored = 0',
		);
		while (cardStmt.step()) {
			const row = cardStmt.getAsObject();
			totalCards++;
			const state = row.state as number;
			const due = row.due as number;
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

	public recordReview(
		reviewItemId: string,
		rating: number,
		newState: ReviewState,
		newDue: number,
		newStability: number,
		newDifficulty: number,
		newReps: number,
		newLapses: number,
		newLearningStep: number,
		newRelearningStep: number,
		sessionId: number,
	): void {
		if (!this.db) return;
		const now = Date.now();
		const stateNum = this.unmapState(newState);

		this.db.run(
			`UPDATE review_items
			 SET state = ?, due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?,
			     last_review = ?, learning_step = ?, relearning_step = ?
			 WHERE id = ?`,
			[
				stateNum,
				newDue,
				newStability,
				newDifficulty,
				newReps,
				newLapses,
				now,
				newLearningStep,
				newRelearningStep,
				reviewItemId,
			],
		);

		this.db.run(
			`INSERT INTO review_logs (session_id, review_item_id, rating, state, due, stability, difficulty, review_time)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[sessionId, reviewItemId, rating, stateNum, newDue, newStability, newDifficulty, now],
		);

		this.db.run(
			`UPDATE sessions
			 SET cards_studied = cards_studied + 1,
			     forgot_count = forgot_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
			     remembered_count = remembered_count + CASE WHEN ? >= 2 THEN 1 ELSE 0 END
			 WHERE session_id = ?`,
			[rating, rating, sessionId],
		);
	}

	public rollbackReview(
		reviewItemId: string,
		previousCard: SchedulingCard,
		sessionId: number,
	): void {
		if (!this.db) return;
		let logId: number | null = null;
		let rating: number | null = null;
		const logStmt = this.db.prepare(
			'SELECT id, rating FROM review_logs WHERE session_id = ? AND review_item_id = ? ORDER BY id DESC LIMIT 1',
		);
		logStmt.bind([sessionId, reviewItemId]);
		if (logStmt.step()) {
			const row = logStmt.getAsObject();
			logId = row.id as number;
			rating = row.rating as number;
		}
		logStmt.free();

		const stateNum = this.unmapState(previousCard.state);
		this.db.run(
			`UPDATE review_items
				 SET state = ?, due = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, last_review = ?, learning_step = ?, relearning_step = ?
			 WHERE id = ?`,
			[
				stateNum,
				previousCard.due,
				previousCard.stability,
				previousCard.difficulty,
				previousCard.reps,
				previousCard.lapses,
				previousCard.last_review ?? null,
				previousCard.learning_step,
				previousCard.relearning_step,
				reviewItemId,
			],
		);

		if (logId !== null && rating !== null) {
			this.db.run('DELETE FROM review_logs WHERE id = ?', [logId]);
			this.db.run(
				`UPDATE sessions
				 SET cards_studied = MAX(cards_studied - 1, 0),
				     forgot_count = MAX(forgot_count - CASE WHEN ? = 1 THEN 1 ELSE 0 END, 0),
				     remembered_count = MAX(remembered_count - CASE WHEN ? >= 2 THEN 1 ELSE 0 END, 0),
				     ended_at = NULL
				 WHERE session_id = ?`,
				[rating, rating, sessionId],
			);
		}
	}

	public getReviewLogsForOptimization(): ReviewLogEntry[] {
		if (!this.db) return [];
		const stmt = this.db.prepare(`
			SELECT review_item_id, rating, review_time,
			       COALESCE(
			           LAG(review_time) OVER (PARTITION BY review_item_id ORDER BY review_time ASC, id ASC),
			           review_time
			       ) as prev_time
			FROM review_logs
			ORDER BY review_time ASC, id ASC
		`);
		const logs: ReviewLogEntry[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			const rating = row.rating as number;
			const reviewTime = row.review_time as number;
			const prevTime = row.prev_time as number;
			const deltaMs = Math.max(0, reviewTime - prevTime);
			const deltaT = deltaMs / (1000 * 60 * 60 * 24);
			logs.push({
				card_id: row.review_item_id as string,
				rating,
				delta_t: deltaT,
			});
		}
		stmt.free();
		return logs;
	}

	public createSession(deckFilter: string): number {
		if (!this.db) return 0;
		const now = Date.now();
		this.db.run(
			'INSERT INTO sessions (started_at, deck_filter, cards_studied, forgot_count, remembered_count) VALUES (?, ?, 0, 0, 0)',
			[now, deckFilter],
		);
		const stmt = this.db.prepare('SELECT last_insert_rowid() as id');
		stmt.step();
		const res = stmt.getAsObject();
		stmt.free();
		return res.id as number;
	}

	public finishSession(
		sessionId: number,
		cardsStudied?: number,
		forgotCount?: number,
		rememberedCount?: number,
	): void {
		if (!this.db) return;
		const now = Date.now();
		if (cardsStudied !== undefined && forgotCount !== undefined && rememberedCount !== undefined) {
			this.db.run(
				'UPDATE sessions SET ended_at = ?, cards_studied = ?, forgot_count = ?, remembered_count = ? WHERE session_id = ?',
				[now, cardsStudied, forgotCount, rememberedCount, sessionId],
			);
		} else {
			this.db.run('UPDATE sessions SET ended_at = ? WHERE session_id = ?', [now, sessionId]);
		}
	}

	private mapState(stateNum: number): ReviewState {
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

	private unmapState(state: ReviewState): number {
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

	public humanizeDue(dueMs: number): string {
		const diff = dueMs - Date.now();
		if (diff <= 0) return 'Due now';
		const days = Math.round(diff / (1000 * 60 * 60 * 24));
		if (days === 0) return 'Today';
		if (days === 1) return 'Tomorrow';
		return `In ${days} days`;
	}

	public humanizeRelative(ms: number): string {
		const diff = Date.now() - ms;
		const mins = Math.floor(diff / (1000 * 60));
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}
}
