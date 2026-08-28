import type { App, PluginManifest } from 'obsidian';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import initWasm, {
	calculate_schedule,
	generate_block_id,
	init,
	optimize_fsrs_weights,
	parse_blocks,
	sync_document_wasm,
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

export class WasmBridge {
	private static isWasmInitialized = false;
	private static sqlJs: SqlJsStatic | null = null;

	public static initForTest(sqlJs: SqlJsStatic): void {
		this.sqlJs = sqlJs;
	}

	public static async initialize(app: App, manifest: PluginManifest): Promise<void> {
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
	}

	public static createDatabase(binaryData?: Uint8Array): Database {
		if (!this.sqlJs) {
			throw new Error('SQLite WASM engine has not been initialized yet.');
		}
		return binaryData ? new this.sqlJs.Database(binaryData) : new this.sqlJs.Database();
	}

	public static syncDocument(
		markdown: string,
		existingIds: Set<string>,
		inheritedTags: string[],
		sectionHints: ObsidianSectionHint[] = [],
	): DocumentSyncResult {
		const json = sync_document_wasm(
			markdown,
			JSON.stringify(Array.from(existingIds)),
			JSON.stringify(inheritedTags),
			JSON.stringify(sectionHints),
		);
		return JSON.parse(json) as DocumentSyncResult;
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

	public static generateBlockId(existingIds: Set<string> = new Set()): string {
		return generate_block_id(JSON.stringify(Array.from(existingIds)));
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
