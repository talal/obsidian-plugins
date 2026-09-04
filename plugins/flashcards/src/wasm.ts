import type { App, PluginManifest } from 'obsidian';

import initWasm, {
	calculate_schedule,
	CollisionRegistry,
	FlashcardsEngine,
	generate_block_id,
	init,
	optimize_fsrs_weights,
	parse_prompts,
	sync_document_with_registry,
} from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';
import type {
	DashboardStats,
	DocumentSyncResult,
	FsrsParams,
	ObsidianSectionHint,
	ParsedPrompt,
	ReviewItem,
	ReviewLogEntry,
	SchedulingCard,
	SchedulingInfo,
	SyncNoteResult,
	TagDeckStats,
} from './types.js';

export { CollisionRegistry, FlashcardsEngine };

import { FLASHCARDS_BIN_PATH, FLASHCARDS_DATA_DIR, SnapshotStore } from './storage.js';

export { FLASHCARDS_BIN_PATH, FLASHCARDS_DATA_DIR, SnapshotStore };

export class WasmBridge {
	private static isWasmInitialized = false;
	private static initPromise: Promise<void> | null = null;

	public static async initialize(app: App, manifest: PluginManifest): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = (async () => {
				const dir = manifest.dir ?? '.obsidian/plugins/flashcards';

				if (!this.isWasmInitialized) {
					const flashcardsWasmPath = `${dir}/flashcards_wasm_bg.wasm`;
					const flashcardsWasmBuffer = await app.vault.adapter.readBinary(flashcardsWasmPath);
					await initWasm({ module_or_path: flashcardsWasmBuffer });
					init();
					this.isWasmInitialized = true;
				}
			})().catch((err) => {
				this.initPromise = null;
				throw err;
			});
		}
		return this.initPromise;
	}

	public static syncNote(
		engine: FlashcardsEngine,
		filePath: string,
		content: string,
		mtime: number,
		size: number,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): SyncNoteResult {
		const json = engine.sync_note(
			filePath,
			content,
			mtime,
			size,
			JSON.stringify(inheritedTags),
			JSON.stringify(sectionHints),
		);
		return JSON.parse(json) as SyncNoteResult;
	}

	public static getDueCards(
		engine: FlashcardsEngine,
		nowMs: number,
		dueCutoffMs: number,
		tagFilter?: string[],
	): ReviewItem[] {
		const json = engine.get_due_cards(
			tagFilter && tagFilter.length > 0 ? JSON.stringify(tagFilter) : '',
			nowMs,
			dueCutoffMs,
		);
		return JSON.parse(json) as ReviewItem[];
	}

	public static getAllCards(engine: FlashcardsEngine, nowMs: number): ReviewItem[] {
		const json = engine.get_all_cards(nowMs);
		return JSON.parse(json) as ReviewItem[];
	}

	public static getDashboardStats(
		engine: FlashcardsEngine,
		nowMs: number,
		dueCutoffMs: number,
	): DashboardStats {
		const json = engine.get_dashboard_stats(nowMs, dueCutoffMs);
		return JSON.parse(json) as DashboardStats;
	}

	public static getTagDeckStats(
		engine: FlashcardsEngine,
		nowMs: number,
		dueCutoffMs: number,
	): TagDeckStats[] {
		const json = engine.get_tag_deck_stats(nowMs, dueCutoffMs);
		return JSON.parse(json) as TagDeckStats[];
	}

	public static recordReview(
		engine: FlashcardsEngine,
		cardId: number,
		rating: 1 | 2 | 3 | 4,
		nowMs: number,
		params: FsrsParams,
	): ReviewItem | null {
		const json = engine.record_review(cardId, rating, nowMs, JSON.stringify(params));
		return JSON.parse(json) as ReviewItem | null;
	}

	public static undoReview(engine: FlashcardsEngine, nowMs: number): ReviewItem | null {
		const json = engine.undo_last_review(nowMs);
		return json ? (JSON.parse(json) as ReviewItem) : null;
	}

	public static getUpcomingDueCounts(
		engine: FlashcardsEngine,
		days: number,
		nowMs: number,
		dueCutoffMs: number,
	): number[] {
		return Array.from(engine.get_upcoming_due_counts(days, nowMs, dueCutoffMs));
	}

	public static getSiblingCard(
		engine: FlashcardsEngine,
		cardId: number,
		promptId: string,
	): SchedulingCard | null {
		const json = engine.get_sibling_card(cardId, promptId);
		return JSON.parse(json) as SchedulingCard | null;
	}

	public static togglePromptTag(
		engine: FlashcardsEngine,
		content: string,
		promptId: string,
		tag: string,
	): string | undefined {
		return engine.toggle_prompt_tag(content, promptId, tag);
	}

	public static addPromptTag(
		engine: FlashcardsEngine,
		content: string,
		promptId: string,
		tag: string,
	): string | undefined {
		return engine.add_prompt_tag(content, promptId, tag);
	}

	public static createCollisionRegistry(
		existingIds?: Set<string> | string[] | Iterable<string>,
	): CollisionRegistry {
		if (!existingIds) {
			return new CollisionRegistry();
		}
		const arr = Array.from(existingIds);
		if (arr.length === 0) {
			return new CollisionRegistry();
		}
		return CollisionRegistry.from_json(JSON.stringify(arr));
	}

	public static syncDocumentWithRegistry(
		markdown: string,
		registry: CollisionRegistry,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): DocumentSyncResult {
		const json = sync_document_with_registry(
			markdown,
			registry,
			JSON.stringify(inheritedTags),
			JSON.stringify(sectionHints),
		);
		return JSON.parse(json) as DocumentSyncResult;
	}

	public static parsePrompts(
		markdown: string,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): ParsedPrompt[] {
		const json = parse_prompts(
			markdown,
			JSON.stringify(inheritedTags),
			JSON.stringify(sectionHints),
		);
		return JSON.parse(json) as ParsedPrompt[];
	}

	public static generateBlockId(existingIds: Set<string> | string[] = new Set()): string {
		const arr = Array.from(existingIds);
		return generate_block_id(JSON.stringify(arr));
	}

	public static calculateSchedule(
		card: SchedulingCard,
		params: FsrsParams,
		nowMs: number,
	): SchedulingInfo {
		const json = calculate_schedule(JSON.stringify(card), JSON.stringify(params), nowMs);
		return JSON.parse(json) as SchedulingInfo;
	}

	public static optimizeFsrsWeights(params: FsrsParams, logs: ReviewLogEntry[]): number[] {
		const json = optimize_fsrs_weights(JSON.stringify(params), JSON.stringify(logs));
		return JSON.parse(json) as number[];
	}
}
