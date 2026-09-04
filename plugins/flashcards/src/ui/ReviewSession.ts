import type { App } from 'obsidian';

import type FlashcardsPlugin from '../main.js';
import { NoteScanner } from '../scanner/NoteScanner.js';
import { SnapshotStore } from '../storage.js';
import { DEFAULT_LEECH_TAG, type ReviewItem } from '../types.js';
import { buildFsrsParams } from '../utils/fsrsParams.js';
import { getStudyDayCutoff } from '../utils/studyDay.js';
import { type FlashcardsEngine, WasmBridge } from '../wasm.js';

export class ReviewSession {
	constructor(
		private app: App,
		private plugin: FlashcardsPlugin,
		public engine: FlashcardsEngine,
		public items: ReviewItem[],
		public deckName = 'All Cards',
	) {}

	public async grade(
		item: ReviewItem,
		ratingStr: 'forgot' | 'remembered',
	): Promise<{ isLeech?: boolean }> {
		const now = Date.now();
		const rolloverHour = this.plugin.settings.rolloverHour ?? 4;
		const dueCutoff = getStudyDayCutoff(rolloverHour, new Date(now));
		const dueCounts = WasmBridge.getUpcomingDueCounts(this.engine, 90, now, dueCutoff);
		const sibling = WasmBridge.getSiblingCard(this.engine, item.card_id, item.prompt_id);
		let siblingDueOffset: number | undefined = undefined;
		if (sibling && sibling.due > now) {
			siblingDueOffset = Math.max(0, Math.round((sibling.due - now) / 86400000));
		}

		const params = buildFsrsParams(this.plugin.settings, {
			due_counts: dueCounts,
			sibling_due_offset: siblingDueOffset,
		});

		const ratingNum = ratingStr === 'forgot' ? 1 : 3;
		const prevState = item.state;
		const updated = WasmBridge.recordReview(this.engine, item.card_id, ratingNum, now, params);
		if (updated) {
			Object.assign(item, updated);
		}

		await SnapshotStore.saveEngine(this.app, this.engine);

		const leechThreshold = this.plugin.settings.leechThreshold ?? 4;
		let isLeech = false;
		if (ratingStr === 'forgot' && prevState === 'review' && item.lapses >= leechThreshold) {
			isLeech = true;
			if (!item.tags.includes(DEFAULT_LEECH_TAG)) {
				item.tags.push(DEFAULT_LEECH_TAG);
			}
			void this.handleCardLeech(item);
		}

		return { isLeech };
	}

	public async undo(): Promise<void> {
		const restored = WasmBridge.undoReview(this.engine, Date.now());
		if (restored) {
			const target = this.items.find((i) => i.card_id === restored.card_id);
			if (target) {
				Object.assign(target, restored);
			}
			await SnapshotStore.saveEngine(this.app, this.engine);
		}
	}

	public async toggleTodo(item: ReviewItem): Promise<void> {
		const file = this.app.vault.getFileByPath(item.note_path);
		if (file) {
			const content = await this.app.vault.read(file);
			const updated = WasmBridge.togglePromptTag(
				this.engine,
				content,
				item.prompt_id,
				'#card/todo',
			);
			if (updated && updated !== content) {
				await this.app.vault.modify(file, updated);
				await new NoteScanner(this.app, this.engine).syncFile(file);
				const idx = item.tags.indexOf('#card/todo');
				if (idx >= 0) {
					item.tags.splice(idx, 1);
				} else {
					item.tags.push('#card/todo');
				}
				this.plugin.refreshDashboardIfOpen();
			}
		}
	}

	public async finishSession(): Promise<void> {
		await SnapshotStore.saveEngine(this.app, this.engine);
		this.plugin.refreshDashboardIfOpen();
	}

	private async handleCardLeech(item: ReviewItem): Promise<void> {
		const file = this.app.vault.getFileByPath(item.note_path);
		if (file) {
			const content = await this.app.vault.read(file);
			const updated = WasmBridge.addPromptTag(
				this.engine,
				content,
				item.prompt_id,
				DEFAULT_LEECH_TAG,
			);
			if (updated && updated !== content) {
				await this.app.vault.modify(file, updated);
				await new NoteScanner(this.app, this.engine).syncFile(file);
				this.plugin.refreshDashboardIfOpen();
			}
		}
	}
}
