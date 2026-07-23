import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../../src/sync/engine';
import { SyncCache } from '../../src/sync/cache';
import type { App, TFile } from 'obsidian';
import type { PluginSettings } from '../../src/config';
import { scanFile } from '../../src/parser/index';

vi.mock('obsidian', () => ({}));
vi.mock('../../src/anki/client', () => {
	return {
		AddonClient: class {
			setApiKey = vi.fn();
			syncNotes = vi.fn().mockResolvedValue({});
			markOrphaned = vi.fn().mockResolvedValue({});
			testConnection = vi.fn().mockResolvedValue('ok');
		},
	};
});
vi.mock('../../src/sync/cache');
vi.mock('../../src/parser/index');

describe('SyncEngine', () => {
	let app: App;
	let settings: PluginSettings;
	let cache: SyncCache;
	let engine: SyncEngine;
	let mockClient: any;

	beforeEach(() => {
		vi.clearAllMocks();
		app = {
			vault: {
				read: vi.fn().mockResolvedValue('file content'),
				modify: vi.fn(),
				adapter: { stat: vi.fn().mockResolvedValue({ mtime: 124 }) },
			},
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue({ frontmatter: { 'anki-deck': 'Default' } }),
			},
		} as unknown as App;

		settings = {
			defaultDeckFallback: 'Default',
			apiKey: 'test-key',
		} as unknown as PluginSettings;

		cache = new SyncCache(null as any) as vi.Mocked<SyncCache>;
		cache.getFile = vi.fn().mockReturnValue(undefined);
		cache.setFile = vi.fn();
		cache.getNotesJson = vi.fn().mockReturnValue('{}');
		cache.getNotesJsonForFile = vi.fn().mockReturnValue('{}');
		cache.updateNotes = vi.fn();
		cache.removeNote = vi.fn();
		cache.save = vi.fn().mockResolvedValue(undefined);

		engine = new SyncEngine(app, settings, cache);
		mockClient = (engine as any).client;
	});

	it('syncs dirty notes via syncNotes', async () => {
		vi.mocked(scanFile).mockReturnValue({
			modifiedMarkdown: 'file content',
			ankiPayload: [
				{
					uuid: '100',
					deckName: 'Default',
					modelName: 'Basic',
					fields: { Front: 'Q', Back: 'A' },
					tags: ['obsidian'],
				},
			],
			updatedCache: { '100': 'hash1' },
			currentFileIds: ['100'],
		});

		mockClient.syncNotes.mockResolvedValue({ '100': 'success' });
		const file = { path: 'test.md', stat: { mtime: 123 } } as TFile;

		const result = await engine.syncFile(file);

		expect(result.updated).toBe(1);
		expect(mockClient.syncNotes).toHaveBeenCalledTimes(1);
		expect(mockClient.syncNotes).toHaveBeenCalledWith([expect.objectContaining({ uuid: '100' })]);
	});

	it('marks notes as orphan if removed from file', async () => {
		vi.mocked(scanFile).mockReturnValue({
			modifiedMarkdown: 'file content',
			ankiPayload: [],
			updatedCache: { '100': 'hash1', '200': 'hash2' },
			currentFileIds: ['100'],
		});

		cache.getFile = vi.fn().mockReturnValue({
			mtime: 0,
			cardIds: ['100', '200'],
		});

		const file = { path: 'test.md', stat: { mtime: 123 } } as TFile;
		const result = await engine.syncFile(file);

		expect(result.orphaned).toBe(1);
		expect(mockClient.markOrphaned).toHaveBeenCalledTimes(1);
		expect(mockClient.markOrphaned).toHaveBeenCalledWith(['200']);
	});

	it('saves file if scanFile modified markdown', async () => {
		vi.mocked(scanFile).mockReturnValue({
			modifiedMarkdown: 'file content modified',
			ankiPayload: [],
			updatedCache: {},
			currentFileIds: [],
		});

		const file = { path: 'test.md', stat: { mtime: 123 } } as TFile;
		await engine.syncFile(file);

		expect(app.vault.modify).toHaveBeenCalledWith(file, 'file content modified');
	});
});
