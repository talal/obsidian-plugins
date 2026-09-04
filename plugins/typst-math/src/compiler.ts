import { Plugin } from 'obsidian';

import init, { Compiler } from '../../../crates/typst-math-wasm/pkg/typst_math_wasm.js';

export class TypstCompiler {
	private compiler: Compiler | null = null;
	private initPromise: Promise<void> | null = null;
	private cache = new Map<string, string>();
	private equationCss: string | null = null;

	public async init(plugin: Plugin): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.doInit(plugin);
			// Allow a retry after a failed load instead of caching the rejection.
			this.initPromise.catch(() => {
				this.initPromise = null;
			});
		}
		return this.initPromise;
	}

	private async doInit(plugin: Plugin): Promise<void> {
		const wasmPath = `${plugin.manifest.dir}/typst_math_wasm_bg.wasm`;
		const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
		await init({ module_or_path: await WebAssembly.compile(buffer) });
		this.compiler = new Compiler();
		this.equationCss = this.compiler.equation_stylesheet() ?? null;
	}

	public isReady(): boolean {
		return this.compiler !== null;
	}

	/** Typst's own MathML stylesheet, extracted once on initialization. */
	get stylesheet(): string | null {
		return this.equationCss;
	}

	/** Synchronously compiles a math expression. Caller must ensure isReady() is true. */
	public compileSync(source: string, display: boolean): string {
		const cacheKey = `${display ? 'd' : 'i'}:${source}`;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) return cached;

		try {
			const mathml = this.compiler!.compile_math(source, display);
			this.cache.set(cacheKey, mathml);
			return mathml;
		} catch (e: any) {
			throw new Error(typeof e === 'string' ? e : String(e));
		}
	}

	/** Asynchronously compiles a math expression, initializing the compiler if needed. */
	public async compile(source: string, display: boolean, plugin: Plugin): Promise<string> {
		if (!this.compiler) {
			await this.init(plugin);
		}
		return this.compileSync(source, display);
	}
}
