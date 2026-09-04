import { Plugin, loadMathJax, renderMath } from 'obsidian';

import { TypstCompiler } from './compiler';
import { FontManager } from './fonts';
import { DEFAULT_SETTINGS, normalizeFontSize, TypstMathSettingTab } from './settings';
import type { TypstMathSettings } from './settings';

declare global {
	interface Window {
		MathJax: any;
		typstMathPlugin?: TypstMathPlugin;
	}
}

class TypstMathElement extends HTMLElement {
	connectedCallback() {
		window.typstMathPlugin?.renderElement(this);
	}
}

if (typeof customElements !== 'undefined') {
	const existing = customElements.get('typst-math');
	if (existing) {
		existing.prototype.connectedCallback = function (this: HTMLElement) {
			window.typstMathPlugin?.renderElement(this);
		};
		(existing.prototype as any).render = function (this: HTMLElement) {
			window.typstMathPlugin?.renderElement(this);
		};
	} else {
		customElements.define('typst-math', TypstMathElement);
	}
}

export default class TypstMathPlugin extends Plugin {
	private originalTex2chtmlMap = new Map<Window, any>();
	private unloaded = false;
	private previousCssVariables: { inline: string; block: string } | null = null;
	public compiler: TypstCompiler = new TypstCompiler();
	public fontManager: FontManager = new FontManager();
	public settings!: TypstMathSettings;

	/** No-op shim for stale in-flight element callbacks during hot-reload. */
	applyEquationStylesheet(_css?: string | null): void {}

	public renderElement(el: HTMLElement): void {
		// If content is already rendered, do not re-render.
		if (el.querySelector('math')) {
			return;
		}

		if (this.compiler.isReady()) {
			this.renderSync(el);
		} else {
			void this.renderAsync(el);
		}
	}

	private renderSync(el: HTMLElement): void {
		const source = el.getAttribute('source') || '';
		const display = el.hasAttribute('display');

		try {
			el.innerHTML = this.compiler.compileSync(source, display);
			el.className = '';
			el.removeAttribute('title');
		} catch (e: any) {
			el.textContent = source;
			el.title = e?.message ?? String(e);
			el.className = 'typst-math-error';
		}
	}

	private async renderAsync(el: HTMLElement): Promise<void> {
		const source = el.getAttribute('source') || '';
		const display = el.hasAttribute('display');

		el.textContent = source;
		el.className = 'typst-math-loading';

		try {
			el.innerHTML = await this.compiler.compile(source, display, this);
			el.className = '';
			el.removeAttribute('title');
		} catch (e: any) {
			el.textContent = source;
			el.title = e?.message ?? String(e);
			el.className = 'typst-math-error';
		}
	}

	async onload() {
		window.typstMathPlugin = this;
		await this.loadSettings();
		this.applySettings();
		this.addSettingTab(new TypstMathSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await loadMathJax();
			if (this.unloaded) return;

			renderMath('', false);
			this.patchWindow(window);
			void this.fontManager.load(this);

			// Warm up WASM compiler in the background
			await this.compiler.init(this);
			this.rerenderMathElements(window.document);
		});

		this.registerEvent(
			this.app.workspace.on('window-open', (_workspaceWindow, win) => {
				this.patchWindow(win);
				this.rerenderMathElements(win.document);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('window-close', (_workspaceWindow, win) => {
				this.originalTex2chtmlMap.delete(win);
			}),
		);
	}

	public createMathContainer(
		source: string,
		display: boolean,
		doc: Document = document,
	): HTMLElement {
		const container = doc.createElement('mjx-container');
		container.className = 'Mathjax';
		container.setAttribute('jax', 'CHTML');

		const el = doc.createElement('typst-math');
		el.setAttribute('source', source);
		if (display) {
			el.setAttribute('display', '');
		}

		if (this.compiler.isReady()) {
			try {
				el.innerHTML = this.compiler.compileSync(source, display);
			} catch (e: any) {
				el.textContent = source;
				el.title = e?.message ?? String(e);
				el.className = 'typst-math-error';
			}
		} else {
			el.textContent = source;
			el.className = 'typst-math-loading';
		}

		container.appendChild(el);
		return container;
	}

	private patchWindow(win: Window): void {
		if (this.unloaded || this.originalTex2chtmlMap.has(win)) return;

		if (win.MathJax && typeof win.MathJax.tex2chtml === 'function') {
			this.originalTex2chtmlMap.set(win, win.MathJax.tex2chtml);
			win.MathJax.tex2chtml = (source: string, opts: { display?: boolean }) => {
				return this.createMathContainer(source, Boolean(opts?.display), win.document);
			};
		} else {
			win.setTimeout(() => this.patchWindow(win), 100);
		}
	}

	private rerenderMathElements(doc: Document = document): void {
		for (const el of doc.querySelectorAll<HTMLElement>('typst-math')) {
			if (!el.querySelector('math')) {
				this.renderElement(el);
			}
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<TypstMathSettings> | null;
		this.settings = {
			inlineFontSize: normalizeFontSize(data?.inlineFontSize, DEFAULT_SETTINGS.inlineFontSize),
			blockFontSize: normalizeFontSize(data?.blockFontSize, DEFAULT_SETTINGS.blockFontSize),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applySettings(): void {
		const body = document.body;
		if (!body) return;

		if (!this.previousCssVariables) {
			this.previousCssVariables = {
				inline: body.style.getPropertyValue('--typst-math-inline-font-size'),
				block: body.style.getPropertyValue('--typst-math-block-font-size'),
			};
		}

		body.style.setProperty('--typst-math-inline-font-size', `${this.settings.inlineFontSize}px`);
		body.style.setProperty('--typst-math-block-font-size', `${this.settings.blockFontSize}px`);
	}

	private restoreCssVariables(): void {
		const body = document.body;
		if (!body || !this.previousCssVariables) return;

		if (this.previousCssVariables.inline) {
			body.style.setProperty('--typst-math-inline-font-size', this.previousCssVariables.inline);
		} else {
			body.style.removeProperty('--typst-math-inline-font-size');
		}

		if (this.previousCssVariables.block) {
			body.style.setProperty('--typst-math-block-font-size', this.previousCssVariables.block);
		} else {
			body.style.removeProperty('--typst-math-block-font-size');
		}
	}

	onunload() {
		this.unloaded = true;
		this.restoreCssVariables();
		this.fontManager.unload();

		for (const [win, original] of this.originalTex2chtmlMap) {
			if (win.MathJax) {
				win.MathJax.tex2chtml = original;
			}
		}
		this.originalTex2chtmlMap.clear();

		delete window.typstMathPlugin;
	}
}
