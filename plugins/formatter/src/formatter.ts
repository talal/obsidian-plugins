import type { Plugin } from 'obsidian';

import initWasm, { format_markdown } from '../../../crates/formatter-wasm/pkg/formatter_wasm.js';

let initPromise: Promise<void> | null = null;

export async function formatMarkdown(text: string, plugin: Plugin): Promise<string> {
	if (!initPromise) {
		initPromise = (async () => {
			const wasmPath = `${plugin.manifest.dir}/formatter_wasm_bg.wasm`;
			const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
			await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
		})();
		// Allow a retry after a failed load instead of caching the rejection.
		initPromise.catch(() => {
			initPromise = null;
		});
	}

	await initPromise;
	return format_markdown(text);
}
