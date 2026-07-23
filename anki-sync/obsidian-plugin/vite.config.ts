import { defineConfig } from 'vite-plus';
import fs from 'node:fs';
import { builtinModules } from 'node:module';

export default defineConfig({
	build: {
		assetsInlineLimit: 0,
		lib: {
			entry: 'src/main.ts',
			formats: ['cjs'],
			fileName: () => 'main.js',
		},
		rollupOptions: {
			external: [
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
			],
		},
		outDir: 'dist',
		emptyOutDir: false,
	},
	plugins: [
		{
			name: 'copy-assets',
			closeBundle() {
				if (!fs.existsSync('./dist')) fs.mkdirSync('./dist');
				fs.copyFileSync('manifest.json', 'dist/manifest.json');
				if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');
				if (fs.existsSync('../../typst-math/crates/typst-math-wasm/pkg/typst_math_wasm_bg.wasm')) {
					fs.copyFileSync(
						'../../typst-math/crates/typst-math-wasm/pkg/typst_math_wasm_bg.wasm',
						'dist/typst_math_wasm_bg.wasm',
					);
				}
				if (fs.existsSync('../crates/anki-sync-wasm/pkg/anki_sync_wasm_bg.wasm')) {
					fs.copyFileSync(
						'../crates/anki-sync-wasm/pkg/anki_sync_wasm_bg.wasm',
						'dist/anki_sync_wasm_bg.wasm',
					);
				}
			},
		},
	],
	test: {
		include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
	},
	lint: {
		ignorePatterns: ['dist/**', 'tests/fixtures/**'],
	},
	fmt: {
		ignorePatterns: ['dist/**', 'tests/fixtures/**'],
		semi: true,
		singleQuote: true,
		useTabs: true,
	},
});
