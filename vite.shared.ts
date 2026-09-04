import { builtinModules } from 'node:module';

import type { Plugin } from 'vite-plus';

export const obsidianExternal = [
	'obsidian',
	'electron',
	'@codemirror/autocomplete',
	'@codemirror/collab',
	'@codemirror/commands',
	'@codemirror/language',
	'@codemirror/lint',
	'@codemirror/search',
	'@codemirror/state',
	'@codemirror/view',
	'@lezer/common',
	'@lezer/highlight',
	'@lezer/lr',
	...builtinModules,
];

/**
 * Replaces wasm-pack's `new URL('..._bg.wasm', import.meta.url)` with a plain string
 * to prevent Vite/Rolldown from bundling or inlining the external WASM binary into main.js.
 */
export function wasmAssetStub(crateName: string): Plugin {
	return {
		name: 'wasm-asset-stub',
		transform(code, id) {
			if (id.includes(`${crateName}.js`)) {
				return code.replace(/new URL\([^)]+\)/g, `'${crateName}_bg.wasm'`);
			}
			return null;
		},
	};
}
