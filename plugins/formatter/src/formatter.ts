import initWasm, { format_markdown } from '../../../crates/formatter-wasm/pkg/formatter_wasm.js';

let wasmInited = false;
let initPromise: Promise<void> | null = null;

export async function initFormatterWasm(plugin: any): Promise<void> {
	if (wasmInited) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const wasmPath = `${plugin.manifest.dir}/formatter_wasm_bg.wasm`;
			const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
			await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
			wasmInited = true;
		} catch (e) {
			console.error('Failed to initialize Formatter WASM', e);
			throw e;
		}
	})();

	return initPromise;
}

export async function formatMarkdown(text: string): Promise<string> {
	if (!wasmInited) {
		throw new Error('Formatter WASM not initialized');
	}

	return format_markdown(text);
}
