import { Plugin } from 'obsidian';
import init, { Compiler } from '../../../crates/typst-math-wasm/pkg/typst_math_wasm.js';

/** A successful compilation: MathML plus Typst's own equation stylesheet. */
export interface CompileResult {
	mathml: string;
	css: string | null;
}

export class TypstCompiler {
	private compiler: Compiler | null = null;
	private initPromise: Promise<void> | null = null;
	private cache = new Map<string, CompileResult>();
	private latestCss: string | null = null;

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
	}

	public isReady(): boolean {
		return this.compiler !== null;
	}

	/** Typst's own MathML stylesheet from the most recent successful compile. */
	get equationCss(): string | null {
		return this.latestCss;
	}

	public async compile(source: string, display: boolean, plugin: Plugin): Promise<CompileResult> {
		// Initialization is intentionally deferred until a math element needs it.
		if (!this.compiler) {
			await this.init(plugin);
		}

		const cacheKey = `${display ? 'd' : 'i'}:${source}`;
		const cached = this.cache.get(cacheKey);
		if (cached) return cached;

		try {
			const raw = this.compiler!.compile_math(source, display);
			const result: CompileResult = { mathml: raw.mathml, css: raw.css ?? null };
			if (result.css) {
				this.latestCss = result.css;
			}
			this.cache.set(cacheKey, result);
			return result;
		} catch (e: any) {
			throw new Error(typeof e === 'string' ? e : String(e));
		}
	}
}
