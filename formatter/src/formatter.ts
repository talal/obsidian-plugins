import initWasm, {
	format_markdown,
	would_change_markdown,
} from '../crates/formatter-wasm/pkg/formatter_wasm.js';

let wasmInited = false;
let initPromise: Promise<void> | null = null;

export function getLocalISOString(date: Date): string {
	const tzo = -date.getTimezoneOffset();
	const dif = tzo >= 0 ? '+' : '-';
	const pad = (num: number) => {
		const norm = Math.floor(Math.abs(num));
		return (norm < 10 ? '0' : '') + norm;
	};
	return (
		date.getFullYear() +
		'-' +
		pad(date.getMonth() + 1) +
		'-' +
		pad(date.getDate()) +
		'T' +
		pad(date.getHours()) +
		':' +
		pad(date.getMinutes()) +
		':' +
		pad(date.getSeconds()) +
		dif +
		pad(tzo / 60) +
		':' +
		pad(tzo % 60)
	);
}

export function injectMetadata(text: string, ctime: number): string {
	const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
	const match = text.match(frontmatterRegex);

	let frontmatterLines: string[] = [];
	let restOfText = text;

	if (match && match[1] !== undefined) {
		frontmatterLines = match[1].split(/\r?\n/);
		restOfText = text.slice(match[0].length);
	} else {
		// No frontmatter exists.
		// If text doesn't start with newline, prepend one so it separates from frontmatter.
		restOfText = text.startsWith('\n') || text === '' ? text : '\n' + text;
	}

	let hasCreated = false;
	let hasTags = false;

	for (const line of frontmatterLines) {
		if (/^created:(\s|$)/.test(line)) hasCreated = true;
		if (/^tags:(\s|$)/.test(line)) hasTags = true;
	}

	if (!hasCreated) {
		frontmatterLines.push(`created: ${getLocalISOString(new Date(ctime))}`);
	}
	if (!hasTags) {
		frontmatterLines.push(`tags:`);
	}

	const newFrontmatter = `---\n${frontmatterLines.join('\n')}\n---`;
	return match ? `${newFrontmatter}${restOfText}` : `${newFrontmatter}\n${restOfText}`;
}

export async function initFormatterWasm(plugin: any): Promise<void> {
	if (wasmInited) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const wasmPath = `${plugin.manifest.dir}/formatter_wasm_bg.wasm`;
			const buffer = await plugin.app.vault.adapter.readBinary(wasmPath);
			await initWasm({ module_or_path: await WebAssembly.compile(buffer) });
			wasmInited = true;
		} catch (e) {
			console.error('Failed to initialize Formatter WASM', e);
			throw e;
		}
	})();

	return initPromise;
}

export async function formatMarkdown(text: string, ctime?: number): Promise<string> {
	let processedText = text;
	if (ctime !== undefined) {
		processedText = injectMetadata(text, ctime);
	}

	if (!wasmInited) {
		throw new Error('Formatter WASM not initialized');
	}

	return format_markdown(processedText);
}

export async function wouldChangeMarkdown(text: string, ctime?: number): Promise<boolean> {
	let processedText = text;
	if (ctime !== undefined) {
		processedText = injectMetadata(text, ctime);
		// If metadata injection changed the text, we will definitely format/change it
		if (processedText !== text) return true;
	}

	if (!wasmInited) {
		throw new Error('Formatter WASM not initialized');
	}

	return would_change_markdown(processedText);
}
