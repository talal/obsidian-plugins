import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import initWasm, { FlashcardsEngine } from '../../../crates/flashcards-wasm/pkg/flashcards_wasm.js';
import type FlashcardsPlugin from '../src/main.ts';
import { NoteScanner } from '../src/scanner/NoteScanner.ts';
import { SnapshotStore } from '../src/storage.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';
import { ReviewSession } from '../src/ui/ReviewSession.ts';
import { getStudyDayCutoff } from '../src/utils/studyDay.ts';
import { WasmBridge } from '../src/wasm.ts';
import { VirtualVault } from './virtualVault.ts';

beforeAll(async () => {
	const wasmPath = path.resolve(
		__dirname,
		'../../../crates/flashcards-wasm/pkg/flashcards_wasm_bg.wasm',
	);
	const wasmBuffer = fs.readFileSync(wasmPath);
	await initWasm({ module_or_path: wasmBuffer });
});

describe('Headless E2E User Journey & Full Workflow', () => {
	it('executes full lifecycle: authoring -> sync -> ID minting -> review -> undo -> tagging -> conflict merge -> pruning', async () => {
		// =========================================================================
		// PHASE 1: Note Authoring in Virtual Vault (No IDs yet)
		// =========================================================================
		const initialBiologyNote = [
			'# Mitosis and Cell Division',
			'',
			'What is mitosis? :: Process of nuclear cell division into two identical daughter cells',
			'Prophase ::: First stage of mitosis where chromosomes condense',
		].join('\n');

		const initialCsNote = [
			'# Computer Science',
			'',
			'Binary search has time complexity of {{O(log n)}}. #cs/algorithms',
			'Q: What is a closure? #cs/languages',
			'A: A function bundled with references to its surrounding lexical scope.',
		].join('\n');

		const vault = new VirtualVault({
			'Biology.md': initialBiologyNote,
			'CS.md': initialCsNote,
		});
		const app = vault.createApp();

		// =========================================================================
		// PHASE 2: Vault Synchronization & Block ID Minting
		// =========================================================================
		let engine = await SnapshotStore.loadEngine(app);
		const scanner = new NoteScanner(app, engine);
		const syncResult = await scanner.fullScan();

		// 2 notes scanned, 5 prompts/cards generated
		expect(syncResult.filesScanned).toBe(2);
		expect(syncResult.totalPrompts).toBe(4); // 2 in Bio + 2 in CS
		expect(syncResult.failedFiles).toHaveLength(0);

		// Verify that notes on the virtual filesystem were modified to stamp unique 6-char IDs
		const updatedBio = vault.getText('Biology.md')!;
		expect(updatedBio).toMatch(/\^([a-z0-9]{6})/);
		expect(updatedBio).toContain('What is mitosis? :: Process of nuclear cell division');
		expect(updatedBio).toContain('Prophase ::: First stage of mitosis');

		const updatedCs = vault.getText('CS.md')!;
		expect(updatedCs).toMatch(/\^([a-z0-9]{6})/);

		// Verify cards.bin was written to virtual disk with magic header b"FCB\x01"
		const cardsBin = vault.getBinary('.flashcards/cards.bin')!;
		expect(cardsBin).toBeDefined();
		expect(cardsBin.byteLength).toBeGreaterThan(50);
		const magic = new TextDecoder().decode(cardsBin.slice(0, 3));
		const version = cardsBin[3];
		expect(magic).toBe('FCB');
		expect(version).toBe(1);

		// =========================================================================
		// PHASE 3: Hierarchical Deck Selection
		// =========================================================================
		const now = Date.now();
		const dueCutoff = getStudyDayCutoff(4, new Date(now));
		const tagStats = WasmBridge.getTagDeckStats(engine, now, dueCutoff);

		// Parent deck "cs" must aggregate both sub-tags (algorithms + languages)
		const csParent = tagStats.find((s) => s.tag === 'cs');
		expect(csParent).toBeDefined();
		expect(csParent?.total_cards).toBe(2);

		const csAlgo = tagStats.find((s) => s.tag === 'cs/algorithms');
		expect(csAlgo).toBeDefined();
		expect(csAlgo?.total_cards).toBe(1);

		// Querying deck with tag "cs/algorithms" returns only the binary search card
		const algoQueue = WasmBridge.getDueCards(engine, now, dueCutoff, ['cs/algorithms']);
		expect(algoQueue).toHaveLength(1);
		expect(algoQueue[0]!.front).toContain('Binary search');

		// =========================================================================
		// PHASE 4: Interactive Study Session, Tagging, and Multi-Step Undo
		// =========================================================================
		const allCards = WasmBridge.getAllCards(engine, now);
		// 5 total materialized cards: 1 inline forward + 2 reversible siblings + 1 cloze + 1 QA
		expect(allCards).toHaveLength(5);

		const studyQueue = WasmBridge.getDueCards(engine, now, dueCutoff);
		// Anti-priming sibling burying: only 1 card per prompt per study session (4 prompts = 4 due cards)
		expect(studyQueue).toHaveLength(4);

		const mockPlugin = {
			settings: { ...DEFAULT_SETTINGS },
			refreshDashboardIfOpen: () => {},
		} as unknown as FlashcardsPlugin;

		const session = new ReviewSession(app, mockPlugin, engine, studyQueue, 'All Cards');

		// Card 1: Grade Remembered
		const card1 = studyQueue[0]!;
		await session.grade(card1, 'remembered');
		expect(card1.reps).toBe(1);
		expect(card1.state).toBe('review');

		// Verify cards.bin on the virtual filesystem was immediately updated
		const binAfterCard1 = vault.getBinary('.flashcards/cards.bin')!;
		expect(binAfterCard1).toBeDefined();

		// Card 2: Tag with #card/todo using hotkey T
		const card2 = studyQueue[1]!;
		await session.toggleTodo(card2);

		// Verify note file on virtual disk now contains #card/todo!
		const noteAfterTodo = vault.getText(card2.note_path)!;
		expect(noteAfterTodo).toContain('#card/todo');

		// Card 2: User clicks "Forgot"
		await session.grade(card2, 'forgot');
		expect(card2.state).toBe('learning');
		expect(card2.due_human).toBe('In 10m');

		// User says "Oops, I misclicked!" and hits Undo (U / Ctrl+Z)
		await session.undo();
		expect(card2.state).toBe('new');
		expect(card2.reps).toBe(0);

		// User grades Card 2 as "Remembered" instead
		await session.grade(card2, 'remembered');
		expect(card2.state).toBe('review');
		expect(card2.reps).toBe(1);

		// Grade remaining cards in today's first study session
		await session.grade(studyQueue[2]!, 'remembered');
		await session.grade(studyQueue[3]!, 'remembered');

		// Finish first session
		await session.finishSession();

		// Sibling anti-priming verified: the buried reverse sibling card is now available in a second session
		const secondQueue = WasmBridge.getDueCards(engine, now, dueCutoff);
		expect(secondQueue).toHaveLength(1);
		expect(secondQueue[0]!.direction).toBe('reverse');
		expect(secondQueue[0]!.card_type).toBe('inline');

		// Complete the remaining reverse card
		const session2 = new ReviewSession(app, mockPlugin, engine, secondQueue, 'All Cards');
		await session2.grade(secondQueue[0]!, 'remembered');
		await session2.finishSession();

		// Verify queue is now completely empty (all cards in all directions completed)
		const remainingDue = WasmBridge.getDueCards(engine, now, dueCutoff);
		expect(remainingDue).toHaveLength(0);

		// Verify dashboard stats
		const stats = WasmBridge.getDashboardStats(engine, now, dueCutoff);
		expect(stats.total_cards).toBe(5);
		expect(stats.due_today).toBe(0);
		expect(stats.studied_today).toBe(5);
		expect(stats.daily_retention).toBe(100);

		// =========================================================================
		// PHASE 5: Multi-Device Syncthing Conflict Auto-Resolution
		// =========================================================================
		// Simulate a mobile device that reviewed cards offline and Syncthing synced a conflict file
		const mobileEngine = new FlashcardsEngine();
		WasmBridge.syncNote(
			mobileEngine,
			'MobileNote.md',
			'Mobile Question :: Mobile Answer ^mobi01\n',
			now + 1000,
			40,
			['mobile'],
		);
		const mobileCards = WasmBridge.getDueCards(mobileEngine, now + 1000, dueCutoff);
		WasmBridge.recordReview(mobileEngine, mobileCards[0]!.card_id, 3, now + 1000, {
			request_retention: 0.9,
			maximum_interval: 36500,
			learning_steps: [600000],
			relearning_steps: [600000],
		});
		const mobileBytes = mobileEngine.to_bytes();

		// Put conflict file in virtual vault .flashcards/
		vault.setBinary(
			'.flashcards/cards.sync-conflict-20260904-120000-MOBILE.bin',
			new Uint8Array(mobileBytes),
		);

		// Starting a session or loading engine on Desktop auto-resolves and absorbs the conflict
		const desktopEngine = await SnapshotStore.loadEngine(app);

		// Conflict file must be deleted from virtual disk
		const conflictFileStillExists = await app.vault.adapter.exists(
			'.flashcards/cards.sync-conflict-20260904-120000-MOBILE.bin',
		);
		expect(conflictFileStillExists).toBe(false);

		// Consolidated store now has 6 cards (5 from desktop + 1 from mobile)
		const allConsolidated = WasmBridge.getAllCards(desktopEngine, now + 2000);
		expect(allConsolidated).toHaveLength(6);
		const mobileCardInStore = allConsolidated.find((c) => c.note_path === 'MobileNote.md');
		expect(mobileCardInStore).toBeDefined();
		expect(mobileCardInStore?.reps).toBe(1);

		// =========================================================================
		// PHASE 6: Stale File Deletion & Pruning
		// =========================================================================
		// User deletes Biology.md from vault
		vault.delete('Biology.md');

		// Sync runs
		const pruneScanner = new NoteScanner(app, desktopEngine);
		const pruneResult = await pruneScanner.fullScan();

		// CS.md was unchanged, so change detection skipped it, while Biology.md was pruned
		expect(pruneResult.filesScanned).toBe(0);
		expect(pruneResult.filesSkipped).toBe(1);

		// Biology cards are cleanly pruned from the store
		const remainingCards = WasmBridge.getAllCards(desktopEngine, now + 3000);
		const bioCards = remainingCards.filter((c) => c.note_path === 'Biology.md');
		expect(bioCards).toHaveLength(0);
	});
});
