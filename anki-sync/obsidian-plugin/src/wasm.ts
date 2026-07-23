import initWasm, {
	scan_file,
	markdown_to_html,
} from '../../crates/anki-sync-wasm/pkg/anki_sync_wasm.js';

let wasmInited = false;
let initPromise: Promise<void> | null = null;

export async function initAnkiSyncWasm(plugin?: any): Promise<void> {
	if (wasmInited) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			if (plugin) {
				const wasmPath = `${plugin.manifest.dir}/anki_sync_wasm_bg.wasm`;
				const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
				await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
			} else {
				// Fallback for Vitest tests
				const fs = await import('fs');
				const path = await import('path');
				const wasmPath = path.resolve(
					__dirname,
					'../../crates/anki-sync-wasm/pkg/anki_sync_wasm_bg.wasm',
				);
				const buffer = fs.readFileSync(wasmPath);
				await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
			}
			wasmInited = true;
		} catch (e) {
			console.error('Failed to initialize Anki Sync WASM', e);
			throw e;
		}
	})();

	return initPromise;
}

export interface WasmScanResult {
	modifiedMarkdown: string;
	ankiPayload: any[];
	updatedCache: Record<string, string>;
	currentFileIds: string[];
}

export function scanFileWasm(
	content: string,
	sourceFile: string,
	defaultDeck: string,
	cacheJson: string,
	forceSync: boolean,
): WasmScanResult {
	if (!wasmInited) throw new Error('WASM not initialized');
	return scan_file(content, sourceFile, defaultDeck, cacheJson, forceSync) as WasmScanResult;
}

export function markdownToHtmlWasm(content: string) {
	if (!wasmInited) throw new Error('WASM not initialized');
	return markdown_to_html(content);
}
