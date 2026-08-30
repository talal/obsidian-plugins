import type { App } from 'obsidian';
import type { Database } from 'sql.js';

import type {
	Block,
	CardPerformanceUpdate,
	CardRecord,
	DashboardStats,
	FileSyncState,
	ParsedBlock,
	ReviewItem,
	ReviewLogEntry,
	ReviewRecord,
	ReviewState,
	SessionRecord,
} from '../types.js';
import { DEFAULT_LEARNING_STEPS, DEFAULT_RELEARNING_STEPS } from '../utils/studySteps.js';
import { WasmBridge } from '../wasm.js';
import { humanizeDue, humanizeRelative, mapState, unmapState } from './formatters.js';
import * as CardRetrieval from './queries/CardRetrievalQueries.js';
import * as CardSync from './queries/CardSyncQueries.js';
import * as SessionOps from './queries/SessionQueries.js';
import SCHEMA_SQL from './schema.sql?raw';
import {
	computeSha256,
	isValidSqliteHeader,
	packSnapshot,
	unpackAndVerifySnapshot,
} from './snapshot.js';

export class DatabaseManager {
	private db: Database | null = null;
	private activeSlot: 'a' | 'b' = 'a';
	private activeGeneration = 0n;
	private slotAPath = '';
	private slotBPath = '';
	private persistQueue: Promise<void> = Promise.resolve();

	private app!: App;

	constructor(app?: App, manifest?: { dir?: string }) {
		if (app) {
			this.app = app;
			const dir = manifest?.dir ?? '.obsidian/plugins/flashcards';
			this.slotAPath = `${dir}/cards.a.db`;
			this.slotBPath = `${dir}/cards.b.db`;
		}
	}

	public static async create(app: App, pluginDir: string): Promise<DatabaseManager> {
		const manager = new DatabaseManager(app, { dir: pluginDir });
		await manager.init();
		return manager;
	}

	public static createInMemory(db: Database): DatabaseManager {
		return this.createForTesting(db);
	}

	public static createForTesting(
		db: Database,
		app?: App,
		slotAPath = 'cards.a.db',
		slotBPath = 'cards.b.db',
	): DatabaseManager {
		const manager = new DatabaseManager();
		manager.db = db;
		if (app) manager.app = app;
		manager.slotAPath = slotAPath;
		manager.slotBPath = slotBPath;
		db.run('PRAGMA foreign_keys = ON;');
		try {
			const tableInfo = db.exec('PRAGMA table_info(blocks);');
			const columns = tableInfo[0]?.values?.map((row) => row[1]) ?? [];
			if (columns.includes('content_hash')) {
				db.run('ALTER TABLE blocks DROP COLUMN content_hash;');
			}
		} catch {
			// Ignore if table does not exist yet
		}
		db.run(SCHEMA_SQL);
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
				if (!slotAData) {
					console.warn(
						`[Flashcards] Snapshot at "${this.slotAPath}" failed checksum or header verification.`,
					);
				}
			} catch (error) {
				console.error(`[Flashcards] I/O error reading snapshot at "${this.slotAPath}":`, error);
				slotAData = null;
			}
		}

		if (bExists) {
			try {
				const bytesB = new Uint8Array(await adapter.readBinary(this.slotBPath));
				slotBData = await unpackAndVerifySnapshot(bytesB);
				if (!slotBData) {
					console.warn(
						`[Flashcards] Snapshot at "${this.slotBPath}" failed checksum or header verification.`,
					);
				}
			} catch (error) {
				console.error(`[Flashcards] I/O error reading snapshot at "${this.slotBPath}":`, error);
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
		try {
			const tableInfo = this.db.exec('PRAGMA table_info(blocks);');
			const columns = tableInfo[0]?.values?.map((row) => row[1]) ?? [];
			if (columns.includes('content_hash')) {
				this.db.run('ALTER TABLE blocks DROP COLUMN content_hash;');
			}
		} catch {
			// Ignore if table does not exist yet
		}
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
		if (!this.db || !this.app) return;
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

	// Card & Block Synchronization
	public upsertBlock(block: Block): void {
		if (this.db) CardSync.upsertBlock(this.db, block);
	}

	public reconcileCards(block: Block): void {
		if (this.db) CardSync.reconcileCards(this.db, block);
	}

	public syncNoteBlocks(filePath: string, parsedBlocks: ParsedBlock[]): void {
		if (this.db) CardSync.syncNoteBlocks(this.db, filePath, parsedBlocks);
	}

	public pruneDeletedNotes(validFilePaths: Set<string>): number {
		return this.db ? CardSync.pruneDeletedNotes(this.db, validFilePaths) : 0;
	}

	public renameNote(oldPath: string, newPath: string): void {
		if (this.db) CardSync.renameNote(this.db, oldPath, newPath);
	}

	public getFileSyncState(filePath: string): FileSyncState | null {
		return this.db ? CardSync.getFileSyncState(this.db, filePath) : null;
	}

	public getAllFileSyncStates(): Map<string, FileSyncState> {
		return this.db ? CardSync.getAllFileSyncStates(this.db) : new Map();
	}

	public upsertFileSyncState(state: FileSyncState): void {
		if (this.db) CardSync.upsertFileSyncState(this.db, state);
	}

	public deleteFileSyncState(filePath: string): void {
		if (this.db) CardSync.deleteFileSyncState(this.db, filePath);
	}

	public getFileToBlockIdsMap(): Map<string, string[]> {
		return this.db ? CardSync.getFileToBlockIdsMap(this.db) : new Map();
	}

	public getFileToBlocksMap(): Map<string, ParsedBlock[]> {
		return this.db ? CardSync.getFileToBlocksMap(this.db) : new Map();
	}

	public getBlocksForFile(filePath: string): ParsedBlock[] {
		return this.db ? CardSync.getBlocksForFile(this.db, filePath) : [];
	}

	public getAllBlockIds(): Set<string> {
		return this.db ? CardSync.getAllBlockIds(this.db) : new Set();
	}

	public getBlockFileOwnershipMap(): Map<string, string> {
		return this.db ? CardSync.getBlockFileOwnershipMap(this.db) : new Map();
	}

	public getBlockIdsExcludingFile(filePath: string): Set<string> {
		return this.db ? CardSync.getBlockIdsExcludingFile(this.db, filePath) : new Set();
	}

	public async optimizeDatabase(validFilePaths?: Set<string>): Promise<{
		prunedBlocks: number;
		integrityOk: boolean;
	}> {
		if (!this.db) return { prunedBlocks: 0, integrityOk: false };
		const res = CardSync.optimizeDatabase(this.db, validFilePaths);
		await this.persist();
		return res;
	}

	// Card Retrieval
	public getDueCards(
		filterTags?: string[],
		rolloverHour = 4,
		learningSteps: number[] = DEFAULT_LEARNING_STEPS,
		relearningSteps: number[] = DEFAULT_RELEARNING_STEPS,
		burySiblings = true,
	): ReviewItem[] {
		return this.db
			? CardRetrieval.getDueCards(
					this.db,
					filterTags,
					rolloverHour,
					learningSteps,
					relearningSteps,
					burySiblings,
				)
			: [];
	}

	public getUpcomingDueCounts(days = 90, nowMs = Date.now(), rolloverHour = 4): number[] {
		return this.db
			? CardRetrieval.getUpcomingDueCounts(this.db, days, nowMs, rolloverHour)
			: Array.from({ length: days }, () => 0);
	}

	public getSiblingCard(cardId: number, blockId: string): CardRecord | null {
		return this.db ? CardRetrieval.getSiblingCard(this.db, cardId, blockId) : null;
	}

	public getAllCards(): ReviewItem[] {
		return this.db ? CardRetrieval.getAllCards(this.db) : [];
	}

	public getUniqueTags(): string[] {
		return this.db ? CardRetrieval.getUniqueTags(this.db) : [];
	}

	// Session Operations
	public async commitSession(
		session: SessionRecord,
		reviews: ReviewRecord[],
		cardUpdates: CardPerformanceUpdate[],
		existingSessionId?: number,
	): Promise<number> {
		if (!this.db) return 0;
		const sessionId = SessionOps.commitSession(
			this.db,
			session,
			reviews,
			cardUpdates,
			existingSessionId,
		);
		await this.persist();
		return sessionId;
	}

	public getReviewLogsForOptimization(): ReviewLogEntry[] {
		return this.db ? SessionOps.getReviewLogsForOptimization(this.db) : [];
	}

	public getDashboardStats(rolloverHour = 4): DashboardStats {
		return this.db
			? SessionOps.getDashboardStats(this.db, rolloverHour)
			: {
					studiedToday: 0,
					dailyRetention: 100,
					studyStreak: 0,
					totalCards: 0,
					dueToday: 0,
					newCards: 0,
				};
	}

	// State & Timestamp Formatters
	public mapState(stateNum: number): ReviewState {
		return mapState(stateNum);
	}

	public unmapState(state: ReviewState): number {
		return unmapState(state);
	}

	public humanizeDue(dueMs: number, now = Date.now()): string {
		return humanizeDue(dueMs, now);
	}

	public humanizeRelative(ms: number, now = Date.now()): string {
		return humanizeRelative(ms, now);
	}
}

export { getStudyDayCutoff, getStudyDayKey, getStudyDayStart } from '../utils/studyDay.js';
