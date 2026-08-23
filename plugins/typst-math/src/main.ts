import { Plugin, loadMathJax, renderMath } from 'obsidian';
import { TypstCompiler } from './compiler';
import { DEFAULT_SETTINGS, normalizeFontSize, TypstMathSettingTab } from './settings';
import type { TypstMathSettings } from './settings';

declare global {
	interface Window {
		MathJax: any;
		typstMathPlugin: TypstMathPlugin;
	}
}

class TypstMathElement extends HTMLElement {
	connectedCallback() {
		// Use setTimeout to avoid blocking the DOM insertion
		setTimeout(() => this.render(), 0);
	}

	async render() {
		const source = this.getAttribute('source') || '';
		const display = this.hasAttribute('display');

		const plugin = window.typstMathPlugin;
		if (!plugin) return;

		try {
			const mathml = await plugin.compiler.compile(source, display, plugin);
			this.innerHTML = mathml;
			this.className = '';
			this.removeAttribute('title');
		} catch (e: any) {
			this.textContent = source;
			this.title = e.message;
			this.className = 'typst-math-error';
		}
	}
}

if (typeof customElements !== 'undefined' && !customElements.get('typst-math')) {
	customElements.define('typst-math', TypstMathElement);
}

export default class TypstMathPlugin extends Plugin {
	private originalTex2chtml: any;
	private previousCssVariables: { inline: string; block: string } | null = null;
	public compiler: TypstCompiler = new TypstCompiler();
	public settings!: TypstMathSettings;

	async onload() {
		window.typstMathPlugin = this;
		await this.loadSettings();
		this.applySettings();
		this.addSettingTab(new TypstMathSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			// Ensure MathJax is loaded
			await loadMathJax();
			if (!window.MathJax) return;

			// Trigger side-effects (loads CSS)
			renderMath('', false);

			this.originalTex2chtml = window.MathJax.tex2chtml;

			window.MathJax.tex2chtml = (source: string, opts: { display?: boolean }) => {
				const container = document.createElement('mjx-container');
				container.className = 'Mathjax';
				container.setAttribute('jax', 'CHTML');

				const el = document.createElement('typst-math');
				el.setAttribute('source', source);
				if (opts.display) {
					el.setAttribute('display', '');
				}

				if (!this.compiler.isReady()) {
					el.textContent = source;
					el.className = 'typst-math-loading';
				}

				container.appendChild(el);
				return container;
			};
		});
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
		this.restoreCssVariables();
		if (window.MathJax && this.originalTex2chtml) {
			window.MathJax.tex2chtml = this.originalTex2chtml;
		}
		// Clean up global to avoid memory leaks
		// @ts-ignore
		delete window.typstMathPlugin;
	}
}
