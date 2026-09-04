import type { App, CachedMetadata, TFile } from 'obsidian';

/**
 * Headless In-Memory Virtual Vault for Obsidian Plugin E2E testing.
 * Simulates filesystem I/O, binary snapshots, metadata cache, and vault events
 * completely in-memory with zero physical disk reliance and zero Electron overhead.
 */
export class VirtualVault {
	private textFiles = new Map<string, string>();
	private binaryFiles = new Map<string, Uint8Array>();
	private mtimes = new Map<string, number>();

	constructor(initialFiles: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initialFiles)) {
			this.setText(path, content);
		}
	}

	public setText(path: string, content: string, mtime = Date.now()): void {
		this.textFiles.set(path, content);
		this.mtimes.set(path, mtime);
	}

	public getText(path: string): string | undefined {
		return this.textFiles.get(path);
	}

	public setBinary(path: string, bytes: Uint8Array, mtime = Date.now()): void {
		this.binaryFiles.set(path, bytes);
		this.mtimes.set(path, mtime);
	}

	public getBinary(path: string): Uint8Array | undefined {
		return this.binaryFiles.get(path);
	}

	public delete(path: string): void {
		this.textFiles.delete(path);
		this.binaryFiles.delete(path);
		this.mtimes.delete(path);
	}

	public listDirectory(dir: string): { files: string[]; folders: string[] } {
		const prefix = dir.endsWith('/') ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.textFiles.keys()) {
			if (path.startsWith(prefix)) files.push(path);
		}
		for (const path of this.binaryFiles.keys()) {
			if (path.startsWith(prefix)) files.push(path);
		}
		return { files, folders: [] };
	}

	public createApp(): App {
		const createTFile = (path: string): TFile => {
			const text = this.textFiles.get(path);
			const binary = this.binaryFiles.get(path);
			const size = text ? text.length : binary ? binary.byteLength : 0;
			const mtime = this.mtimes.get(path) ?? Date.now();
			return {
				path,
				name: path.split('/').pop() ?? path,
				basename: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
				extension: path.endsWith('.md') ? 'md' : 'bin',
				stat: { mtime, size, ctime: mtime },
			} as unknown as TFile;
		};

		const vault = {
			read: async (file: TFile) => {
				const text = this.textFiles.get(file.path);
				if (text !== undefined) return text;
				throw new Error(`File not found: ${file.path}`);
			},
			cachedRead: async (file: TFile) => {
				const text = this.textFiles.get(file.path);
				if (text !== undefined) return text;
				throw new Error(`File not found: ${file.path}`);
			},
			modify: async (file: TFile, data: string) => {
				this.setText(file.path, data);
				(file.stat as any).size = data.length;
				(file.stat as any).mtime = Date.now();
			},
			create: async (path: string, data: string) => {
				this.setText(path, data);
				return createTFile(path);
			},
			delete: async (file: TFile) => {
				this.delete(file.path);
			},
			getFileByPath: (path: string) => {
				if (this.textFiles.has(path) || this.binaryFiles.has(path)) {
					return createTFile(path);
				}
				return null;
			},
			getMarkdownFiles: () => {
				const mdFiles: TFile[] = [];
				for (const path of this.textFiles.keys()) {
					if (path.endsWith('.md')) {
						mdFiles.push(createTFile(path));
					}
				}
				return mdFiles;
			},
			adapter: {
				exists: async (path: string) => {
					if (this.textFiles.has(path) || this.binaryFiles.has(path)) return true;
					const prefix = path.endsWith('/') ? path : `${path}/`;
					for (const p of this.textFiles.keys()) {
						if (p.startsWith(prefix)) return true;
					}
					for (const p of this.binaryFiles.keys()) {
						if (p.startsWith(prefix)) return true;
					}
					return false;
				},
				stat: async (path: string) => {
					const mtime = this.mtimes.get(path) ?? Date.now();
					const text = this.textFiles.get(path);
					if (text !== undefined) {
						return { mtime, size: text.length };
					}
					const bin = this.binaryFiles.get(path);
					if (bin !== undefined) {
						return { mtime, size: bin.byteLength };
					}
					return null;
				},
				readBinary: async (path: string) => {
					const bin = this.binaryFiles.get(path);
					if (bin) {
						return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
					}
					throw new Error(`Binary file not found: ${path}`);
				},
				writeBinary: async (path: string, data: ArrayBuffer) => {
					this.setBinary(path, new Uint8Array(data));
				},
				list: async (dir: string) => this.listDirectory(dir),
				remove: async (path: string) => {
					this.delete(path);
				},
				mkdir: async (_dir: string) => {},
			},
		};

		const metadataCache = {
			getFileCache: (file: TFile): CachedMetadata | null => {
				const content = this.textFiles.get(file.path);
				if (!content) return null;

				let frontmatter: Record<string, any> | null = null;
				if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
					const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
					if (match && match[1]) {
						const yamlBlock = match[1];
						const fm: Record<string, any> = {};
						for (const line of yamlBlock.split(/\r?\n/)) {
							const colonIdx = line.indexOf(':');
							if (colonIdx !== -1) {
								const key = line.slice(0, colonIdx).trim();
								let val: any = line.slice(colonIdx + 1).trim();
								if (val === 'true') val = true;
								else if (val === 'false') val = false;
								else if (val.startsWith('[') && val.endsWith(']')) {
									val = val
										.slice(1, -1)
										.split(',')
										.map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
										.filter(Boolean);
								}
								fm[key] = val;
							}
						}
						frontmatter = fm;
					}
				}

				const tags: { tag: string; position: any }[] = [];
				const tagMatches = content.matchAll(/#([a-zA-Z0-9_\-/]+)/g);
				for (const m of tagMatches) {
					tags.push({ tag: m[0], position: {} });
				}

				return {
					frontmatter: frontmatter ?? undefined,
					tags: tags.length > 0 ? tags : undefined,
				} as CachedMetadata;
			},
		};

		return {
			vault,
			metadataCache,
		} as unknown as App;
	}
}
