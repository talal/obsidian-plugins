import type { Plugin } from 'obsidian';

import initWasm, { format_markdown } from '../../../crates/formatter-wasm/pkg/formatter_wasm.js';

export class WasmFormatter {
	private initPromise: Promise<void> | null = null;
	readonly plugin: Plugin;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async warmup(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		try {
			await this.ensureInitialized();
		} catch (error) {
			console.warn('Formatter: background warmup failed', error);
		}
	}

	private ensureInitialized(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = (async () => {
				const wasmPath = `${this.plugin.manifest.dir}/formatter_wasm_bg.wasm`;
				const buffer = await this.plugin.app.vault.adapter.readBinary(wasmPath);
				await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
			})();

			this.initPromise.catch(() => {
				this.initPromise = null;
			});
		}
		return this.initPromise;
	}

	async format(text: string): Promise<string> {
		await this.ensureInitialized();
		try {
			return format_markdown(text);
		} catch (error) {
			// If a panic/trap occurred in WASM, discard the instance so the next
			// attempt instantiates a fresh, unpoisoned instance.
			this.initPromise = null;
			throw error;
		}
	}

	unload(): void {
		this.initPromise = null;
	}
}

// Global convenience instance for standalone calls or tests
let defaultFormatter: WasmFormatter | null = null;

export async function formatMarkdown(text: string, plugin: Plugin): Promise<string> {
	if (!defaultFormatter || defaultFormatter.plugin !== plugin) {
		defaultFormatter = new WasmFormatter(plugin);
	}
	return defaultFormatter.format(text);
}
