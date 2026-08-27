import { defineConfig } from 'vite-plus';

export default defineConfig({
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		ignorePatterns: [
			'*.md',
			'*.toml',
			'.agents/**',
			'dist/**',
			'skills-lock.json',
			'tests/fixtures/**',
		],
		singleQuote: true,
		sortImports: true,
		useTabs: true,
	},
});
