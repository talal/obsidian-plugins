import { Plugin } from 'obsidian';
import init, { Compiler } from '../../../typst-math/crates/typst-math-wasm/pkg/typst_math_wasm.js';

export class TypstCompiler {
	private compiler: Compiler | null = null;
	private initPromise: Promise<void> | null = null;
	private cache = new Map<string, string>();

	public async init(plugin: Plugin): Promise<void> {
		if (this.compiler) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				const wasmPath = `${plugin.manifest.dir}/typst_math_wasm_bg.wasm`;
				const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
				await init({ module_or_path: await WebAssembly.compile(buffer) });
				this.compiler = new Compiler();
			} catch (e) {
				console.error('Failed to initialize Typst WASM', e);
				throw e;
			}
		})();

		return this.initPromise;
	}

	public isReady(): boolean {
		return this.compiler !== null;
	}

	public async compile(source: string, display: boolean, plugin: Plugin): Promise<string> {
		if (!this.compiler) {
			await this.init(plugin);
		}

		const cacheKey = `${display ? 'd' : 'i'}:${source}`;
		const cached = this.cache.get(cacheKey);
		if (cached) return cached;

		try {
			const mathml = this.compiler!.compile_math(source, display);
			this.cache.set(cacheKey, mathml);
			return mathml;
		} catch (e: any) {
			throw new Error(typeof e === 'string' ? e : String(e));
		}
	}
}
