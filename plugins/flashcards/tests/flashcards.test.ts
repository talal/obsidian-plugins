import fs from 'node:fs';
import path from 'node:path';

import type { App, CachedMetadata, TFile } from 'obsidian';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import initWasm, { FlashcardsEngine } from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';
import type FlashcardsPlugin from '../src/main.ts';
import { NoteScanner } from '../src/scanner/NoteScanner.ts';
import { SnapshotStore } from '../src/storage.ts';
import { DEFAULT_MAXIMUM_INTERVAL, DEFAULT_SETTINGS, type ReviewItem } from '../src/types.ts';
import { ReviewSession } from '../src/ui/ReviewSession.ts';
import { formatClozeText } from '../src/utils/clozeFormat.ts';
import {
	type DashboardPromptItem,
	filterDashboardPrompt,
	groupCardsByPrompt,
} from '../src/utils/dashboardCards.ts';
import { filterDashboardCard } from '../src/utils/dashboardFilter.ts';
import { buildFsrsParams, parseWeights } from '../src/utils/fsrsParams.ts';
import { calculateProgress, calculateRetention } from '../src/utils/reviewMetrics.ts';
import {
	formatLocalDate,
	getStudyDayCutoff,
	getStudyDayKey,
	getStudyDayStart,
	shiftLocalDateKey,
} from '../src/utils/studyDay.ts';
import {
	DEFAULT_LEARNING_STEPS,
	DEFAULT_RELEARNING_STEPS,
	parseStudySteps,
} from '../src/utils/studySteps.ts';
import {
	buildTagTree,
	getSelectedTagSummary,
	getVisibleTagRows,
	isNodeFullySelected,
	isNodeIndeterminate,
} from '../src/utils/tagTree.ts';
import { WasmBridge } from '../src/wasm.ts';

beforeAll(async () => {
	const wasmPath = path.resolve(
		__dirname,
		'../../../crates/flashcards-wasm/pkg/flashcards_wasm_bg.wasm',
	);
	const wasmBuffer = fs.readFileSync(wasmPath);
	await initWasm({ module_or_path: wasmBuffer });
});

describe('Study Day Boundary Calculation (4:00 AM Rollover)', () => {
	it('calculates start and cutoff for evening reviews (e.g. 21:00)', () => {
		const testTime = new Date(2026, 4, 15, 21, 0, 0, 0);
		const startMs = getStudyDayStart(4, testTime);
		const cutoffMs = getStudyDayCutoff(4, testTime);

		const startDate = new Date(startMs);
		const cutoffDate = new Date(cutoffMs);

		expect(startDate.getFullYear()).toBe(2026);
		expect(startDate.getMonth()).toBe(4);
		expect(startDate.getDate()).toBe(15);
		expect(startDate.getHours()).toBe(4);

		expect(cutoffDate.getDate()).toBe(16);
		expect(cutoffDate.getHours()).toBe(4);
		expect(cutoffDate.getMinutes()).toBe(0);
	});

	it('calculates start and cutoff for post-midnight reviews before rollover (e.g. 02:30)', () => {
		const testTime = new Date(2026, 4, 16, 2, 30, 0, 0);
		const startMs = getStudyDayStart(4, testTime);
		const cutoffMs = getStudyDayCutoff(4, testTime);

		const startDate = new Date(startMs);
		const cutoffDate = new Date(cutoffMs);

		expect(startDate.getDate()).toBe(15);
		expect(startDate.getHours()).toBe(4);

		expect(cutoffDate.getDate()).toBe(16);
		expect(cutoffDate.getHours()).toBe(4);
	});

	it('formats and shifts study day keys', () => {
		const d = new Date(2026, 4, 15, 12, 0, 0);
		expect(formatLocalDate(d)).toBe('2026-05-15');
		expect(getStudyDayKey(d.getTime(), 4)).toBe('2026-05-15');
		expect(shiftLocalDateKey('2026-05-15', 3)).toBe('2026-05-18');
		expect(shiftLocalDateKey('2026-05-15', -1)).toBe('2026-05-14');
	});
});

describe('FSRS Parameters and Weight Parsing', () => {
	it('parses valid comma-separated 21-weight string', () => {
		const valid21 =
			'0.4, 0.9, 2.3, 10.9, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61, 0.1, 0.2, 0.3, 0.4';
		const parsed = parseWeights(valid21);
		expect(parsed).toBeDefined();
		expect(parsed).toHaveLength(21);
		expect(parsed![0]).toBe(0.4);
	});

	it('rejects weights with invalid length', () => {
		expect(parseWeights('0.4, 0.9, 2.3')).toBeUndefined();
		expect(parseWeights('')).toBeUndefined();
		expect(parseWeights(undefined)).toBeUndefined();
	});

	it('parses study step strings correctly', () => {
		expect(parseStudySteps('1m 10m 1d', DEFAULT_LEARNING_STEPS)).toEqual([60000, 600000, 86400000]);
		expect(parseStudySteps('', DEFAULT_LEARNING_STEPS)).toEqual([600000]);
		expect(parseStudySteps('invalid', DEFAULT_RELEARNING_STEPS)).toEqual([600000]);
	});

	it('builds FsrsParams with defaults and overrides', () => {
		const params = buildFsrsParams(DEFAULT_SETTINGS, {
			request_retention: 0.85,
		});
		expect(params.request_retention).toBe(0.85);
		expect(params.maximum_interval).toBe(DEFAULT_MAXIMUM_INTERVAL);
		expect(params.learning_steps).toEqual([600000]);
	});
});

describe('Cloze Markdown Formatting', () => {
	it('hides clozes when unrevealed using [...] badge', () => {
		const text = 'Photosynthesis produces {{oxygen}} and {{glucose}}.';
		const unrevealed = formatClozeText(text, false);
		expect(unrevealed).toBe(
			'Photosynthesis produces <span class="fc-cloze-mask">[ ... ]</span> and <span class="fc-cloze-mask">[ ... ]</span>.',
		);
	});

	it('reveals clozes when revealed', () => {
		const text = 'Photosynthesis produces {{oxygen}} and {{glucose}}.';
		const revealed = formatClozeText(text, true);
		expect(revealed).toBe(
			'Photosynthesis produces <mark class="fc-cloze-revealed">oxygen</mark> and <mark class="fc-cloze-revealed">glucose</mark>.',
		);
	});
});

describe('Review Metrics', () => {
	it('calculates progress accurately', () => {
		expect(calculateProgress(0, 10, false)).toEqual(
			{
				currentCardNumber: 1,
				totalCards: 10,
				progressPercent: 10,
				progressText: '1 / 10',
			}.progressText
				? {
						currentCardNumber: 1,
						progressPercent: 10,
						progressText: '1 / 10',
					}
				: {},
		);
		expect(calculateProgress(5, 10, false)).toEqual({
			currentCardNumber: 6,
			progressPercent: 60,
			progressText: '6 / 10',
		});
		expect(calculateProgress(9, 10, true)).toEqual({
			currentCardNumber: 10,
			progressPercent: 100,
			progressText: '10 / 10',
		});
	});

	it('calculates retention percentage accurately', () => {
		expect(calculateRetention(0, 0)).toBe(100);
		expect(calculateRetention(10, 8)).toBe(80);
		expect(calculateRetention(10, 10)).toBe(100);
		expect(calculateRetention(3, 1)).toBe(33);
	});
});

describe('Dashboard Grouping and Filtering', () => {
	const sampleCards: ReviewItem[] = [
		{
			card_id: 1,
			prompt_id: 'p1',
			note_title: 'Biology',
			note_path: 'Biology.md',
			card_type: 'inline',
			direction: 'forward',
			reversible: true,
			front: 'Mitochondria',
			back: 'Powerhouse of the cell',
			tags: ['biology', 'science'],
			state: 'review',
			state_num: 2,
			due_at: 1000,
			due_human: 'Now',
			stability: 2.5,
			difficulty: 5.0,
			reps: 3,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			last_review: 500,
			last_practiced_human: 'Yesterday',
		},
		{
			card_id: 2,
			prompt_id: 'p1',
			note_title: 'Biology',
			note_path: 'Biology.md',
			card_type: 'inline',
			direction: 'reverse',
			reversible: true,
			front: 'Powerhouse of the cell',
			back: 'Mitochondria',
			tags: ['biology', 'science'],
			state: 'new',
			state_num: 0,
			due_at: 2000,
			due_human: 'Tomorrow',
			stability: 0,
			difficulty: 0,
			reps: 0,
			lapses: 0,
			learning_step: 0,
			relearning_step: 0,
			last_review: null,
			last_practiced_human: 'Never',
		},
	];

	it('groups forward and reverse cards under single prompt item', () => {
		const grouped = groupCardsByPrompt(sampleCards);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]!.prompt_id).toBe('p1');
		expect(grouped[0]!.forward?.card_id).toBe(1);
		expect(grouped[0]!.reverse?.card_id).toBe(2);
		expect(grouped[0]!.reversible).toBe(true);
	});

	it('filters cards by status, tag, and search query', () => {
		const grouped = groupCardsByPrompt(sampleCards);
		expect(filterDashboardPrompt(grouped[0]!, 'all', 1500, '')).toBe(true);
		expect(filterDashboardPrompt(grouped[0]!, 'due', 1500, '')).toBe(true);
		expect(filterDashboardPrompt(grouped[0]!, 'new', 1500, '')).toBe(true);
		expect(filterDashboardPrompt(grouped[0]!, 'learning', 1500, '')).toBe(false);

		expect(filterDashboardPrompt(grouped[0]!, 'all', 1500, 'Powerhouse')).toBe(true);
		expect(filterDashboardPrompt(grouped[0]!, 'all', 1500, '#biology')).toBe(true);
		expect(filterDashboardPrompt(grouped[0]!, 'all', 1500, 'NonExistent')).toBe(false);

		expect(filterDashboardCard(sampleCards[0]!, 'Mitochondria')).toBe(true);
		expect(filterDashboardCard(sampleCards[0]!, '#science')).toBe(true);
		expect(filterDashboardCard(sampleCards[0]!, '#history')).toBe(false);
	});
});

describe('Syntax and Tag Manipulation Edge Cases', () => {
	it('initializes engine and serializes/deserializes via Postcard roundtrip', () => {
		const engine = new FlashcardsEngine();
		const bytes = engine.to_bytes();
		expect(bytes.length).toBeGreaterThan(0);

		const restored = FlashcardsEngine.from_bytes(bytes);
		expect(restored).toBeInstanceOf(FlashcardsEngine);
	});

	it('syncs multiline cards bounded by %% card-start %% and %% card-end %%', () => {
		const engine = new FlashcardsEngine();
		const md = `%% card-start id=m1x8yz %%
#card/history
First Question Line
More details

:::

First Answer Line
Second Answer Line
%% card-end %%`;
		const res = WasmBridge.syncNote(engine, 'History.md', md, 1700000000000, md.length, []);

		expect(res.prompt_count).toBe(1);
		const cards = WasmBridge.getAllCards(engine, 1700000000000);
		expect(cards).toHaveLength(2); // reversible
		expect(cards[0]!.tags).toContain('card/history');
	});

	it('toggles and adds tags in Markdown directly via WASM without regex', () => {
		const engine = new FlashcardsEngine();
		const initialMd = 'Question :: Answer ^k9x2mp\n';

		// Toggle #card/todo ON
		const withTodo = WasmBridge.togglePromptTag(engine, initialMd, 'k9x2mp', '#card/todo');
		expect(withTodo).toBe('Question :: Answer #card/todo ^k9x2mp\n');

		// Toggle #card/todo OFF
		const withoutTodo = WasmBridge.togglePromptTag(engine, withTodo!, 'k9x2mp', '#card/todo');
		expect(withoutTodo).toBe('Question :: Answer ^k9x2mp\n');

		// Add #card/leech
		const withLeech = WasmBridge.addPromptTag(engine, initialMd, 'k9x2mp', '#card/leech');
		expect(withLeech).toBe('Question :: Answer #card/leech ^k9x2mp\n');

		// Adding existing leech tag is idempotent
		const idempotent = WasmBridge.addPromptTag(engine, withLeech!, 'k9x2mp', '#card/leech');
		expect(idempotent).toBe('Question :: Answer #card/leech ^k9x2mp\n');
	});
});

describe('NoteScanner Integration', () => {
	it('syncs vault files and skips unchanged notes based on mtime and size', async () => {
		const engine = new FlashcardsEngine();
		const fileContent = 'What is biology? :: Study of life ^b111aa\n';
		const mockFile = {
			path: 'Biology.md',
			stat: { mtime: 1700000000000, size: fileContent.length },
		} as unknown as TFile;

		const mockVault = {
			read: vi.fn().mockResolvedValue(fileContent),
			cachedRead: vi.fn().mockResolvedValue(fileContent),
			modify: vi.fn().mockResolvedValue(undefined),
			getMarkdownFiles: vi.fn().mockReturnValue([mockFile]),
			adapter: {
				writeBinary: vi.fn().mockResolvedValue(undefined),
				exists: vi
					.fn()
					.mockImplementation((path: string) => Promise.resolve(!path.includes('cards.bin'))),
				mkdir: vi.fn().mockResolvedValue(undefined),
				stat: vi.fn().mockResolvedValue({ mtime: 1700000000000, size: 0 }),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue({
					frontmatter: null,
					tags: [],
					sections: [],
				} as unknown as CachedMetadata),
			},
		} as unknown as App;

		const scanner = new NoteScanner(mockApp, engine);

		// First scan processes the file
		const res1 = await scanner.fullScan();
		expect(res1.filesScanned).toBe(1);
		expect(res1.filesSkipped).toBe(0);
		expect(res1.totalPrompts).toBe(1);
		expect(mockVault.cachedRead).toHaveBeenCalledTimes(1);

		// Second scan skips since mtime and size did not change
		const res2 = await scanner.fullScan();
		expect(res2.filesScanned).toBe(0);
		expect(res2.filesSkipped).toBe(1);
		expect(mockVault.cachedRead).toHaveBeenCalledTimes(1); // No new disk read!
	});

	it('respects cards-ignore: true frontmatter by omitting and purging cards from engine', async () => {
		const engine = new FlashcardsEngine();
		WasmBridge.syncNote(engine, 'Ignored.md', 'Q :: A ^ign001\n', 1000, 20, []);
		expect(WasmBridge.getAllCards(engine, 1000)).toHaveLength(1);

		const mockFile = {
			path: 'Ignored.md',
			stat: { mtime: 2000, size: 50 },
		} as unknown as TFile;

		const mockVault = {
			read: vi.fn().mockResolvedValue('---\ncards-ignore: true\n---\nQ :: A ^ign001\n'),
			cachedRead: vi.fn().mockResolvedValue('---\ncards-ignore: true\n---\nQ :: A ^ign001\n'),
			modify: vi.fn().mockResolvedValue(undefined),
			adapter: {
				writeBinary: vi.fn().mockResolvedValue(undefined),
				exists: vi.fn().mockResolvedValue(false),
				mkdir: vi.fn().mockResolvedValue(undefined),
				stat: vi.fn().mockResolvedValue(null),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue({
					frontmatter: { 'cards-ignore': true },
				} as unknown as CachedMetadata),
			},
		} as unknown as App;

		const scanner = new NoteScanner(mockApp, engine);
		const syncRes = await scanner.syncFile(mockFile);
		expect(syncRes.prompt_count).toBe(0);
		expect(WasmBridge.getAllCards(engine, 2000)).toHaveLength(0);
	});

	it('handles file renames in engine and updates internal paths', async () => {
		const engine = new FlashcardsEngine();
		WasmBridge.syncNote(engine, 'OldName.md', 'Q :: A ^ren001\n', 1000, 20, []);
		expect(WasmBridge.getAllCards(engine, 1000)[0]!.note_path).toBe('OldName.md');

		const mockVault = {
			adapter: {
				writeBinary: vi.fn().mockResolvedValue(undefined),
				exists: vi.fn().mockResolvedValue(false),
				mkdir: vi.fn().mockResolvedValue(undefined),
				stat: vi.fn().mockResolvedValue(null),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};
		const mockApp = { vault: mockVault } as unknown as App;

		const scanner = new NoteScanner(mockApp, engine);
		await scanner.renameFile('OldName.md', 'NewName.md');
		expect(WasmBridge.getAllCards(engine, 1000)[0]!.note_path).toBe('NewName.md');
	});
});

describe('Multi-Device Syncthing Synchronization', () => {
	it('detects external disk modifications and merges without data loss', async () => {
		const desktopEngine = new FlashcardsEngine();
		WasmBridge.syncNote(
			desktopEngine,
			'Desktop.md',
			'Desktop Q :: Desktop A ^dsk111\n',
			1000,
			30,
			[],
		);

		// Remote device (e.g. mobile) creates a note and reviews a card
		const mobileEngine = FlashcardsEngine.from_bytes(desktopEngine.to_bytes());
		WasmBridge.syncNote(mobileEngine, 'Mobile.md', 'Mobile Q :: Mobile A ^mob222\n', 2000, 30, []);
		const mobileCards = WasmBridge.getAllCards(mobileEngine, 2000);
		expect(mobileCards).toHaveLength(2);
		const params = buildFsrsParams(DEFAULT_SETTINGS);
		WasmBridge.recordReview(mobileEngine, mobileCards[0]!.card_id, 3, 2500, params);

		const mobileBytes = mobileEngine.to_bytes();
		let diskBytes: Uint8Array = mobileBytes;
		let diskMtime = 2500;

		const mockVault = {
			adapter: {
				exists: vi
					.fn()
					.mockImplementation((p: string) =>
						Promise.resolve(p.includes('cards.bin') || p.includes('.flashcards')),
					),
				stat: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve({ mtime: diskMtime, size: diskBytes.byteLength }),
					),
				readBinary: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve(
							diskBytes.buffer.slice(
								diskBytes.byteOffset,
								diskBytes.byteOffset + diskBytes.byteLength,
							),
						),
					),
				writeBinary: vi.fn().mockImplementation((_p: string, buf: ArrayBuffer) => {
					diskBytes = new Uint8Array(buf);
					diskMtime += 1000;
					return Promise.resolve();
				}),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				mkdir: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};
		const mockApp = { vault: mockVault } as unknown as App;

		// Set initial desktop last known mtime
		SnapshotStore.setLastKnownSnapshotMtime(1000);
		SnapshotStore.setLastKnownSnapshotSize(desktopEngine.to_bytes().byteLength);

		// Desktop checks for disk changes
		const changed = await SnapshotStore.reloadOrMergeIfModified(mockApp, desktopEngine);
		expect(changed).toBe(true);

		// Desktop now has both notes and the review!
		const desktopCards = WasmBridge.getAllCards(desktopEngine, 3000);
		expect(desktopCards).toHaveLength(2);
		expect(desktopEngine.get_review_logs()).toContain('card_id');
	});

	it('pre-save guard merges disk changes before writing so remote reviews are preserved', async () => {
		const desktopEngine = new FlashcardsEngine();
		WasmBridge.syncNote(desktopEngine, 'Note1.md', 'Q1 :: A1 ^aaa111\n', 1000, 20, []);

		// Mobile has a copy and records a review
		const mobileEngine = FlashcardsEngine.from_bytes(desktopEngine.to_bytes());
		const params = buildFsrsParams(DEFAULT_SETTINGS);
		const mobileCards = WasmBridge.getAllCards(mobileEngine, 1000);
		WasmBridge.recordReview(mobileEngine, mobileCards[0]!.card_id, 3, 2000, params);
		const mobileBytes = mobileEngine.to_bytes();

		// Meanwhile on desktop, user adds Note2.md while offline/before sync
		WasmBridge.syncNote(desktopEngine, 'Note2.md', 'Q2 :: A2 ^bbb222\n', 1500, 20, []);

		// Syncthing transfers mobile's cards.bin to disk
		let diskBytes: Uint8Array = mobileBytes;
		let diskMtime = 2000;

		const mockVault = {
			adapter: {
				exists: vi
					.fn()
					.mockImplementation((p: string) =>
						Promise.resolve(p.includes('cards.bin') || p.includes('.flashcards')),
					),
				stat: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve({ mtime: diskMtime, size: diskBytes.byteLength }),
					),
				readBinary: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve(
							diskBytes.buffer.slice(
								diskBytes.byteOffset,
								diskBytes.byteOffset + diskBytes.byteLength,
							),
						),
					),
				writeBinary: vi.fn().mockImplementation((_p: string, buf: ArrayBuffer) => {
					diskBytes = new Uint8Array(buf);
					diskMtime += 1000;
					return Promise.resolve();
				}),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				mkdir: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};
		const mockApp = { vault: mockVault } as unknown as App;

		// Desktop was at mtime 1000
		SnapshotStore.setLastKnownSnapshotMtime(1000);
		SnapshotStore.setLastKnownSnapshotSize(desktopEngine.to_bytes().byteLength);

		// Desktop saves its engine
		await SnapshotStore.saveEngine(mockApp, desktopEngine);

		// Verify the saved disk snapshot contains BOTH Note2 and the mobile review!
		const finalEngine = FlashcardsEngine.from_bytes(diskBytes);
		const finalCards = WasmBridge.getAllCards(finalEngine, 4000);
		expect(finalCards).toHaveLength(2);
		expect(finalEngine.get_review_logs()).toContain('card_id');
	});

	it('gracefully recovers and creates a new engine when cards.bin has invalid magic header or corrupted bytes', async () => {
		const corruptedBytes = new Uint8Array([1, 2, 3, 4, 5]); // Invalid magic header, not b"FCB\x01"

		const mockVault = {
			adapter: {
				exists: vi.fn().mockResolvedValue(true),
				stat: vi.fn().mockResolvedValue({ mtime: 1000, size: 5 }),
				readBinary: vi.fn().mockResolvedValue(corruptedBytes.buffer),
				writeBinary: vi.fn().mockResolvedValue(undefined),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				mkdir: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};
		const mockApp = { vault: mockVault } as unknown as App;

		// loadEngine catches the corrupted header and starts a fresh engine
		const engine = await SnapshotStore.loadEngine(mockApp);
		expect(engine).toBeInstanceOf(FlashcardsEngine);
		expect(WasmBridge.getAllCards(engine, 1000)).toHaveLength(0);
	});

	it('supports ephemeral engine lifecycle: loads on session start, persists, and unloads', async () => {
		const seedEngine = new FlashcardsEngine();
		WasmBridge.syncNote(
			seedEngine,
			'Test.md',
			'Ephemeral Q :: Ephemeral A ^eph111\n',
			1000,
			30,
			[],
		);
		let diskBytes: Uint8Array = seedEngine.to_bytes();
		let diskMtime = 1000;

		const mockVault = {
			adapter: {
				exists: vi.fn().mockResolvedValue(true),
				stat: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve({ mtime: diskMtime, size: diskBytes.byteLength }),
					),
				readBinary: vi
					.fn()
					.mockImplementation(() =>
						Promise.resolve(
							diskBytes.buffer.slice(
								diskBytes.byteOffset,
								diskBytes.byteOffset + diskBytes.byteLength,
							),
						),
					),
				writeBinary: vi.fn().mockImplementation((_p: string, buf: ArrayBuffer) => {
					diskBytes = new Uint8Array(buf);
					diskMtime += 100;
					return Promise.resolve();
				}),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				mkdir: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};
		const mockApp = { vault: mockVault } as unknown as App;
		// Session 1: load on demand, grade card, save and drop
		{
			let sessionEngine: FlashcardsEngine | null = await SnapshotStore.loadEngine(mockApp);
			const cards = WasmBridge.getAllCards(sessionEngine, 1000);
			expect(cards).toHaveLength(1);
			expect(cards[0]!.state).toBe('new');

			const params = buildFsrsParams(DEFAULT_SETTINGS);
			WasmBridge.recordReview(sessionEngine, cards[0]!.card_id, 3, 1500, params);
			await SnapshotStore.saveEngine(mockApp, sessionEngine);

			// Explicitly drop engine reference from RAM
			sessionEngine = null;
			expect(sessionEngine).toBeNull();
		}

		// Session 2: separate session loads fresh from disk
		{
			const freshEngine = await SnapshotStore.loadEngine(mockApp);
			const cards = WasmBridge.getAllCards(freshEngine, 2000);
			expect(cards).toHaveLength(1);
			expect(cards[0]!.state).toBe('review');
			expect(cards[0]!.reps).toBe(1);
		}
	});

	it('handles concurrent offline card additions on multiple devices without collision or data loss', () => {
		const desktopEngine = new FlashcardsEngine();
		WasmBridge.syncNote(
			desktopEngine,
			'Desktop.md',
			'Desktop Q :: Desktop A ^dsk111\n',
			1000,
			30,
			[],
		);
		const deskCards = WasmBridge.getAllCards(desktopEngine, 1000);
		expect(deskCards).toHaveLength(1);
		expect(deskCards[0]!.card_id).toBe(1);

		const mobileEngine = new FlashcardsEngine();
		WasmBridge.syncNote(mobileEngine, 'Mobile.md', 'Mobile Q :: Mobile A ^mob222\n', 1000, 30, []);
		const mobiCards = WasmBridge.getAllCards(mobileEngine, 1000);
		expect(mobiCards).toHaveLength(1);
		expect(mobiCards[0]!.card_id).toBe(1); // Both independently got local ID 1!

		const params = buildFsrsParams(DEFAULT_SETTINGS);
		WasmBridge.recordReview(mobileEngine, 1, 3, 2000, params);

		const desktopBytes = desktopEngine.to_bytes();
		const mergedEngine = FlashcardsEngine.from_bytes(desktopBytes);
		const changed = mergedEngine.merge_from_bytes(mobileEngine.to_bytes());
		expect(changed).toBe(true);

		const allCards = WasmBridge.getAllCards(mergedEngine, 3000);
		expect(allCards).toHaveLength(2);
		expect(new Set(allCards.map((c) => c.card_id)).size).toBe(2); // Unique IDs!
		expect(new Set(allCards.map((c) => c.prompt_id))).toEqual(new Set(['dsk111', 'mob222']));

		const mobiMerged = allCards.find((c) => c.prompt_id === 'mob222')!;
		expect(mobiMerged.reps).toBe(1);
		expect(mobiMerged.last_review).toBe(2000);

		// Review log was safely remapped to mobiMerged.card_id
		const logs = JSON.parse(mergedEngine.get_review_logs());
		expect(logs).toHaveLength(1);
		expect(logs[0].card_id).toBe(String(mobiMerged.card_id));
	});
});

describe('ReviewSession Leech Threshold Handling', () => {
	function createMockAppAndFile(initialContent: string, filePath = 'Study.md') {
		let currentContent = initialContent;
		const mockFile = {
			path: filePath,
			stat: { mtime: 1000, size: initialContent.length },
		} as unknown as TFile;

		const mockVault = {
			read: vi.fn().mockImplementation(() => Promise.resolve(currentContent)),
			cachedRead: vi.fn().mockImplementation(() => Promise.resolve(currentContent)),
			modify: vi.fn().mockImplementation((_file: TFile, newContent: string) => {
				currentContent = newContent;
				return Promise.resolve();
			}),
			getFileByPath: vi.fn().mockImplementation((p: string) => {
				return p === filePath ? mockFile : null;
			}),
			getMarkdownFiles: vi.fn().mockReturnValue([mockFile]),
			adapter: {
				exists: vi
					.fn()
					.mockImplementation((path: string) => Promise.resolve(!path.includes('cards.bin'))),
				stat: vi.fn().mockResolvedValue({ mtime: 1000, size: 100 }),
				writeBinary: vi.fn().mockResolvedValue(undefined),
				readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
				list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
				mkdir: vi.fn().mockResolvedValue(undefined),
				remove: vi.fn().mockResolvedValue(undefined),
			},
		};

		const mockApp = {
			vault: mockVault,
			metadataCache: {
				getFileCache: vi.fn().mockReturnValue(null),
			},
		} as unknown as App;

		return {
			mockApp,
			mockFile,
			getContent: () => currentContent,
		};
	}

	it('detects leeches when lapses reach threshold and automatically tags prompt with #card/leech', async () => {
		const initialMarkdown = 'Leech question :: Leech answer ^leech1\n';
		const { mockApp, getContent } = createMockAppAndFile(initialMarkdown);
		const engine = new FlashcardsEngine();
		WasmBridge.syncNote(engine, 'Study.md', initialMarkdown, 1000, initialMarkdown.length, []);

		const items = WasmBridge.getAllCards(engine, 1000);
		const card = items[0]!;

		// Graduate the card to Review state first
		const params = buildFsrsParams(DEFAULT_SETTINGS);
		WasmBridge.recordReview(engine, card.card_id, 3, 1000, params);
		const updatedItems = WasmBridge.getAllCards(engine, 2000);
		const reviewCard = updatedItems[0]!;
		expect(reviewCard.state).toBe('review');

		const mockPlugin = {
			settings: { ...DEFAULT_SETTINGS, leechThreshold: 2 },
			refreshDashboardIfOpen: vi.fn(),
		} as unknown as FlashcardsPlugin;

		const session = new ReviewSession(mockApp, mockPlugin, engine, [reviewCard], 'All Cards');

		// Lapse 1 -> moves to Relearning, lapses = 1
		const r1 = await session.grade(reviewCard, 'forgot');
		expect(r1.isLeech).toBe(false);
		expect(reviewCard.lapses).toBe(1);

		// Graduate out of relearning back to Review state
		await session.grade(reviewCard, 'remembered');
		expect(reviewCard.state).toBe('review');

		// Lapse 2 -> reaches leechThreshold (2)
		const r2 = await session.grade(reviewCard, 'forgot');
		expect(r2.isLeech).toBe(true);
		expect(reviewCard.tags).toContain('#card/leech');

		// Check that the markdown file was updated with #card/leech
		expect(getContent()).toContain('#card/leech');
	});
});

describe('Nested Tag Decks & Tree Hierarchy', () => {
	const sampleStats = [
		{ tag: 'language/german', total_cards: 10, due_cards: 3, new_cards: 2 },
		{ tag: 'language/french', total_cards: 5, due_cards: 2, new_cards: 1 },
		{ tag: 'science/physics/quantum', total_cards: 4, due_cards: 1, new_cards: 1 },
		{ tag: 'math', total_cards: 8, due_cards: 0, new_cards: 4 },
	];

	it('builds nested tag trees and creates synthetic parent nodes with aggregated counts', () => {
		const roots = buildTagTree(sampleStats);

		// 3 root decks: language, science, math
		expect(roots).toHaveLength(3);

		const language = roots.find((r) => r.fullTag === 'language')!;
		expect(language).toBeDefined();
		expect(language.depth).toBe(0);
		// Synthetic parent sums up german (10) + french (5)
		expect(language.totalCards).toBe(15);
		expect(language.dueCards).toBe(5);
		expect(language.newCards).toBe(3);
		expect(language.children).toHaveLength(2);

		const german = language.children.find((c) => c.name === 'german')!;
		expect(german).toBeDefined();
		expect(german.fullTag).toBe('language/german');
		expect(german.depth).toBe(1);
		expect(german.totalCards).toBe(10);

		// Deep nesting: science -> physics -> quantum
		const science = roots.find((r) => r.fullTag === 'science')!;
		expect(science.totalCards).toBe(4);
		expect(science.children).toHaveLength(1);
		const physics = science.children[0]!;
		expect(physics.name).toBe('physics');
		expect(physics.children).toHaveLength(1);
		expect(physics.children[0]!.name).toBe('quantum');
	});

	it('flattens tree into visible rows and respects collapsed branches', () => {
		const roots = buildTagTree(sampleStats);
		const collapsed = new Set<string>();

		// Fully expanded: language (root) + german + french + science (root) + physics + quantum + math (root) = 7 rows
		const allRows = getVisibleTagRows(roots, collapsed, 'tag', true);
		expect(allRows).toHaveLength(7);
		expect(allRows.map((r) => r.fullTag)).toEqual([
			'language',
			'language/french',
			'language/german',
			'math',
			'science',
			'science/physics',
			'science/physics/quantum',
		]);

		// Collapse language
		collapsed.add('language');
		const collapsedRows = getVisibleTagRows(roots, collapsed, 'tag', true);
		// language children hidden: language, math, science, science/physics, science/physics/quantum = 5 rows
		expect(collapsedRows).toHaveLength(5);
		expect(collapsedRows.map((r) => r.fullTag)).not.toContain('language/german');
		expect(collapsedRows.map((r) => r.fullTag)).not.toContain('language/french');
	});

	it('cascades selection between parents, children, and indeterminate states', () => {
		const roots = buildTagTree(sampleStats);
		const language = roots.find((r) => r.fullTag === 'language')!;
		const german = language.children.find((c) => c.name === 'german')!;
		const selected = new Set<string>();

		// Initial: nothing selected
		expect(isNodeFullySelected(language, selected)).toBe(false);
		expect(isNodeIndeterminate(language, selected)).toBe(false);

		// Select only german
		selected.add('language/german');
		expect(isNodeFullySelected(german, selected)).toBe(true);
		expect(isNodeFullySelected(language, selected)).toBe(false);
		expect(isNodeIndeterminate(language, selected)).toBe(true);

		// Summary with partial selection only counts german
		const sum1 = getSelectedTagSummary(roots, selected);
		expect(sum1.total).toBe(10);
		expect(sum1.due).toBe(3);

		// Select all of language (language + german + french)
		selected.add('language');
		selected.add('language/french');
		expect(isNodeFullySelected(language, selected)).toBe(true);
		expect(isNodeIndeterminate(language, selected)).toBe(false);

		// Summary with full parent selected counts the entire deck (15) without double counting
		const sum2 = getSelectedTagSummary(roots, selected);
		expect(sum2.total).toBe(15);
		expect(sum2.due).toBe(5);
	});

	it('matches top-level tag and returns all descendant cards in WASM study queue', () => {
		const engine = new FlashcardsEngine();
		const md1 = 'German Q #language/german :: German A ^de01\n';
		const md2 = 'French Q #language/french :: French A ^fr01\n';
		const md3 = 'Physics Q #science/physics :: Physics A ^ph01\n';

		WasmBridge.syncNote(engine, 'De.md', md1, 1000, md1.length, []);
		WasmBridge.syncNote(engine, 'Fr.md', md2, 1000, md2.length, []);
		WasmBridge.syncNote(engine, 'Ph.md', md3, 1000, md3.length, []);

		// Querying with top-level "language" tag MUST return both German and French cards
		const langCards = WasmBridge.getDueCards(engine, 1000, 1000, ['language']);
		expect(langCards).toHaveLength(2);
		expect(langCards.map((c) => c.front).sort()).toEqual([
			'French Q #language/french',
			'German Q #language/german',
		]);

		// Querying with specific subtag "language/german" MUST return only German card
		const deCards = WasmBridge.getDueCards(engine, 1000, 1000, ['language/german']);
		expect(deCards).toHaveLength(1);
		expect(deCards[0]!.front).toBe('German Q #language/german');
	});

	it('respects intra-day learning steps in getDueCards and formats due_human accurately', () => {
		const engine = new FlashcardsEngine();
		const md = 'Capital of France :: Paris ^cap01\n';
		WasmBridge.syncNote(engine, 'Geo.md', md, 1_000_000, md.length, []);

		const now = 1_000_000;
		const dueCutoff = now + 14 * 3600 * 1000; // 14h in future (4am tomorrow)

		// 1. Initial new card
		const newCards = WasmBridge.getDueCards(engine, now, dueCutoff);
		expect(newCards).toHaveLength(1);
		expect(newCards[0]!.due_human).toBe('New');

		// 2. Review and mark "Forgot" (rating 1)
		const params = buildFsrsParams({} as any);
		const updated = WasmBridge.recordReview(engine, newCards[0]!.card_id, 1, now, params);
		expect(updated?.state).toBe('learning');
		// Step is 10 minutes (600,000 ms), so it must say "In 10m" rather than "Tomorrow"
		expect(updated?.due_human).toBe('In 10m');

		// 3. Immediately after rating: step has NOT elapsed, card must NOT be in due queue
		const immediateDue = WasmBridge.getDueCards(engine, now, dueCutoff);
		expect(immediateDue).toHaveLength(0);

		// Tag deck stats must also show 0 due cards
		const immediateDeckStats = WasmBridge.getTagDeckStats(engine, now, dueCutoff);
		if (immediateDeckStats.length > 0) {
			expect(immediateDeckStats[0]!.due_cards).toBe(0);
		}

		// 4. 10 minutes later: step has elapsed, card is now due to study
		const tenMinsLater = now + 600_000;
		const dueAfterStep = WasmBridge.getDueCards(engine, tenMinsLater, dueCutoff);
		expect(dueAfterStep).toHaveLength(1);
		expect(dueAfterStep[0]!.due_human).toBe('Due now');
	});

	it('filters learning cards correctly in filterDashboardPrompt based on elapsed step', () => {
		const promptItem: DashboardPromptItem = {
			prompt_id: 'p1',
			note_title: 'Note',
			note_path: 'Note.md',
			card_type: 'inline',
			reversible: false,
			front: 'Front',
			back: 'Back',
			tags: [],
			forward: {
				card_id: 1,
				prompt_id: 'p1',
				note_title: 'Note',
				note_path: 'Note.md',
				card_type: 'inline',
				direction: 'forward',
				reversible: false,
				front: 'Front',
				back: 'Back',
				tags: [],
				state: 'learning',
				state_num: 1,
				due_at: Date.now() + 600_000, // 10 minutes in future
				due_human: 'In 10m',
				stability: 0.5,
				difficulty: 5.0,
				reps: 1,
				lapses: 1,
				learning_step: 0,
				relearning_step: 0,
				last_review: Date.now(),
				last_practiced_human: 'Just now',
			},
		};

		const cutoff = Date.now() + 86400000;

		// While step has not elapsed, statusFilter 'due' must NOT include it
		expect(filterDashboardPrompt(promptItem, 'due', cutoff, '')).toBe(false);

		// But statusFilter 'learning' DOES include it
		expect(filterDashboardPrompt(promptItem, 'learning', cutoff, '')).toBe(true);

		// When step has elapsed, statusFilter 'due' includes it
		promptItem.forward!.due_at = Date.now() - 1000;
		expect(filterDashboardPrompt(promptItem, 'due', cutoff, '')).toBe(true);
	});
});
