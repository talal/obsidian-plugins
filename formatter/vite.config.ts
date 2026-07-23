import { defineConfig } from 'vite-plus';
import fs from 'node:fs';
import { builtinModules } from 'node:module';

export default defineConfig({
	build: {
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
				if (fs.existsSync('crates/formatter-wasm/pkg/formatter_wasm_bg.wasm')) {
					fs.copyFileSync(
						'crates/formatter-wasm/pkg/formatter_wasm_bg.wasm',
						'dist/formatter_wasm_bg.wasm',
					);
				}
			},
		},
	],
	lint: {
		ignorePatterns: ['dist/**'],
	},
	fmt: {
		semi: true,
		singleQuote: true,
		useTabs: true,
	},
});
