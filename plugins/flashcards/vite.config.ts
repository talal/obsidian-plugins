import fs from 'node:fs';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite-plus';

import { obsidianExternal } from '../../vite.shared.ts';

export default defineConfig({
	build: {
		assetsInlineLimit: 0,
		lib: {
			entry: 'src/main.ts',
			formats: ['cjs'],
			fileName: () => 'main.js',
		},
		rollupOptions: {
			external: obsidianExternal,
		},
		outDir: 'dist',
		emptyOutDir: false,
	},
	plugins: [
		svelte({
			emitCss: false,
			compilerOptions: {
				runes: true,
			},
		}),
		{
			name: 'copy-assets',
			closeBundle() {
				if (!fs.existsSync('./dist')) fs.mkdirSync('./dist');
				fs.copyFileSync('manifest.json', 'dist/manifest.json');
				if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');

				const flashcardsWasm = '../../crates/flashcards-wasm/pkg/flashcards_wasm_bg.wasm';
				if (!fs.existsSync(flashcardsWasm)) {
					throw new Error(
						`Missing ${flashcardsWasm}. Build Rust crate first with "npm run build:wasm -w flashcards"`,
					);
				}
				fs.copyFileSync(flashcardsWasm, 'dist/flashcards_wasm_bg.wasm');
			},
		},
	],
	lint: {
		ignorePatterns: ['dist/**', 'tests/fixtures/**'],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		ignorePatterns: ['dist/**', 'tests/fixtures/**', '*.md', '*.toml'],
		singleQuote: true,
		sortImports: true,
		useTabs: true,
	},
});
