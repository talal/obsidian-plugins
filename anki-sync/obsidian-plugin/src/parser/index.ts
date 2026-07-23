import { scanFileWasm, WasmScanResult } from '../wasm';

/**
 * Scan file content and return all notes found (inline + block),
 * while simultaneously rewriting the Markdown with new NanoIDs and generating
 * the Anki addon payload.
 *
 * Relies on the Rust WASM core.
 */
export function scanFile(
	content: string,
	sourceFile: string,
	deck: string,
	cacheJson: string,
	forceSync = false,
): WasmScanResult {
	return scanFileWasm(content, sourceFile, deck, cacheJson, forceSync);
}
