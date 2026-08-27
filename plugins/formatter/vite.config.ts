import fs from 'node:fs';

import { defineConfig } from 'vite-plus';

import { obsidianExternal } from '../../vite.shared.ts';

export default defineConfig({
	build: {
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
		{
			name: 'copy-assets',
			closeBundle() {
				if (!fs.existsSync('./dist')) fs.mkdirSync('./dist');
				fs.copyFileSync('manifest.json', 'dist/manifest.json');
				if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', 'dist/styles.css');
				if (fs.existsSync('../../crates/formatter-wasm/pkg/formatter_wasm_bg.wasm')) {
					fs.copyFileSync(
						'../../crates/formatter-wasm/pkg/formatter_wasm_bg.wasm',
						'dist/formatter_wasm_bg.wasm',
					);
				}
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
