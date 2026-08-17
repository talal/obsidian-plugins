import { Plugin, loadMathJax, renderMath } from 'obsidian';
import { TypstCompiler } from './compiler';

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
	public compiler: TypstCompiler = new TypstCompiler();

	async onload() {
		window.typstMathPlugin = this;

		// Start initializing compiler in background
		this.compiler.init(this).catch(console.error);

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

	onunload() {
		if (window.MathJax && this.originalTex2chtml) {
			window.MathJax.tex2chtml = this.originalTex2chtml;
		}
		// Clean up global to avoid memory leaks
		// @ts-ignore
		delete window.typstMathPlugin;
	}
}
