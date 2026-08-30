import type { App, PluginManifest } from 'obsidian';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import initWasm, {
	calculate_schedule,
	CollisionRegistry,
	generate_block_id_with_registry,
	init,
	optimize_fsrs_weights,
	parse_blocks,
	sync_document_with_registry,
} from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';
import type {
	DocumentSyncResult,
	FsrsParams,
	ObsidianSectionHint,
	ParsedBlock,
	ReviewLogEntry,
	SchedulingCard,
	SchedulingInfo,
} from './types.js';

export { CollisionRegistry };

export class WasmBridge {
	private static isWasmInitialized = false;
	private static sqlJs: SqlJsStatic | null = null;
	private static initPromise: Promise<void> | null = null;

	public static initForTest(sqlJs: SqlJsStatic): void {
		this.sqlJs = sqlJs;
	}

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

				if (!this.sqlJs) {
					const sqlWasmPath = `${dir}/sql-wasm.wasm`;
					const sqlWasmBuffer = await app.vault.adapter.readBinary(sqlWasmPath);

					this.sqlJs = await initSqlJs({
						wasmBinary: sqlWasmBuffer,
					});
				}
			})().catch((err) => {
				this.initPromise = null;
				throw err;
			});
		}
		return this.initPromise;
	}

	public static createDatabase(binaryData?: Uint8Array): Database {
		if (!this.sqlJs) {
			throw new Error('SQLite WASM engine has not been initialized yet.');
		}
		return binaryData ? new this.sqlJs.Database(binaryData) : new this.sqlJs.Database();
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

	public static syncDocument(
		markdown: string,
		existingIds: Set<string> | CollisionRegistry,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): DocumentSyncResult {
		if (existingIds instanceof CollisionRegistry) {
			return this.syncDocumentWithRegistry(markdown, existingIds, inheritedTags, sectionHints);
		}
		const registry = this.createCollisionRegistry(existingIds);
		try {
			return this.syncDocumentWithRegistry(markdown, registry, inheritedTags, sectionHints);
		} finally {
			registry.free();
		}
	}

	public static parseMarkdownBlocks(
		markdown: string,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): ParsedBlock[] {
		const json = parse_blocks(
			markdown,
			JSON.stringify(inheritedTags),
			JSON.stringify(sectionHints),
		);
		return JSON.parse(json) as ParsedBlock[];
	}

	public static generateBlockId(existingIds: Set<string> | CollisionRegistry = new Set()): string {
		if (existingIds instanceof CollisionRegistry) {
			return generate_block_id_with_registry(existingIds);
		}
		const registry = this.createCollisionRegistry(existingIds);
		try {
			return generate_block_id_with_registry(registry);
		} finally {
			registry.free();
		}
	}

	public static generateBlockIdWithRegistry(registry: CollisionRegistry): string {
		return generate_block_id_with_registry(registry);
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
