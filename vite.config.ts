import { defineConfig } from 'vite-plus';

export default defineConfig({
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		ignorePatterns: ['.agents/**', 'dist/**', 'tests/fixtures/**', '*.md', '*.toml'],
		semi: true,
		singleQuote: true,
		useTabs: true,
	},
});
