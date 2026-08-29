<script lang="ts">
	import { Component, MarkdownRenderer, type App } from 'obsidian';
	import type { ReviewItem } from '../../types.ts';
	import { calculateProgress, calculateRetention } from '../../utils/reviewMetrics.ts';

	interface Props {
		app?: App;
		items: ReviewItem[];
		deckName?: string;
		onGrade?: (item: ReviewItem, rating: 'forgot' | 'remembered') => Promise<void> | void;
		onUndo?: (item: ReviewItem) => Promise<void> | void;
		onToggleTodo?: (item: ReviewItem) => Promise<void> | void;
		onClose?: () => void;
		onFinishSession?: (studied: number, forgot: number, remembered: number) => Promise<void> | void;
	}

	let {
		app,
		items = [],
		deckName = 'All Cards',
		onGrade,
		onUndo,
		onToggleTodo,
		onClose,
		onFinishSession,
	}: Props = $props();

	function renderMarkdownAction(
		node: HTMLElement,
		params: { app?: App; markdown: string; sourcePath: string },
	) {
		let comp = new Component();
		comp.load();
		let renderId = 0;

		const render = async (app: App | undefined, md: string, path: string) => {
			const currentId = ++renderId;
			node.empty();
			if (app) {
				await MarkdownRenderer.render(app, md, node, path, comp);
			} else {
				node.innerHTML = md;
			}
			if (currentId !== renderId) {
				node.empty();
			}
		};

		void render(params.app, params.markdown, params.sourcePath);

		return {
			update(newParams: { app?: App; markdown: string; sourcePath: string }) {
				comp.unload();
				comp = new Component();
				comp.load();
				void render(newParams.app, newParams.markdown, newParams.sourcePath);
			},
			destroy() {
				comp.unload();
			},
		};
	}

	// Session State
	let currentIndex = $state(0);
	let isRevealed = $state(false);
	let isFinished = $state(false);
	let isProcessing = $state(false);

	// Session Metrics
	let sessionStudied = $state(0);
	let sessionForgot = $state(0);
	let sessionRemembered = $state(0);
	let startTime = $state(Date.now());

	// History for Undo
	let history = $state<
		{ index: number; wasRevealed: boolean; card: ReviewItem; rating: 'forgot' | 'remembered' }[]
	>([]);
	let toastMessage = $state<string | null>(null);

	let currentCard = $derived(items[currentIndex]);
	let totalCards = $derived(items.length);
	let progress = $derived(calculateProgress(currentIndex, totalCards, isFinished));
	let progressPercent = $derived(progress.progressPercent);
	let sessionRetention = $derived(calculateRetention(sessionStudied, sessionRemembered));

	let cardDisplay = $derived.by(() => {
		if (!currentCard) return null;
		if (currentCard.blockType === 'cloze') {
			const text = currentCard.front;
			const frontMarkdown = isRevealed
				? text.replace(/\{\{([^}]+)\}\}/g, '<mark class="fc-cloze-revealed">$1</mark>')
				: text.replace(/\{\{([^}]+)\}\}/g, '<span class="fc-cloze-mask">[ ... ]</span>');
			return {
				isCloze: true,
				frontMarkdown,
				backMarkdown: '',
			};
		}
		return {
			isCloze: false,
			frontMarkdown: currentCard.front,
			backMarkdown: currentCard.back,
		};
	});

	function showToast(msg: string) {
		toastMessage = msg;
		setTimeout(() => {
			if (toastMessage === msg) toastMessage = null;
		}, 2500);
	}

	function handleReveal() {
		if (!isProcessing && !isFinished && !isRevealed) {
			isRevealed = true;
		}
	}

	async function handleGrade(rating: 'forgot' | 'remembered') {
		if (!currentCard || isProcessing || isFinished) return;

		const card = currentCard;
		const previousCard = { ...card, tags: [...card.tags] };
		const wasRevealed = isRevealed;
		isProcessing = true;
		try {
			await onGrade?.(card, rating);
			history.push({
				index: currentIndex,
				wasRevealed,
				card: previousCard,
				rating,
			});

			sessionStudied += 1;
			if (rating === 'forgot') {
				sessionForgot += 1;
				showToast('Marked as forgot');
			} else {
				sessionRemembered += 1;
				showToast('Marked as remembered');
			}

			if (currentIndex + 1 < items.length) {
				currentIndex += 1;
				isRevealed = false;
			} else {
				isFinished = true;
				await onFinishSession?.(sessionStudied, sessionForgot, sessionRemembered);
			}
		} catch (error) {
			console.error('Failed to save flashcard review:', error);
			showToast('Could not save review');
		} finally {
			isProcessing = false;
		}
	}

	async function handleUndo() {
		if (isProcessing) return;
		const last = history[history.length - 1];
		if (!last) {
			showToast('Nothing to undo');
			return;
		}
		history.pop();
		const previousIndex = currentIndex;
		const previousRevealState = isRevealed;
		const previousFinishedState = isFinished;
		const previousStudied = sessionStudied;
		const previousForgot = sessionForgot;
		const previousRemembered = sessionRemembered;
		if (last.rating === 'forgot') sessionForgot = Math.max(0, sessionForgot - 1);
		else sessionRemembered = Math.max(0, sessionRemembered - 1);
		sessionStudied = Math.max(0, sessionStudied - 1);

		currentIndex = last.index;
		isRevealed = last.wasRevealed;
		isFinished = false;
		isProcessing = true;
		try {
			await onUndo?.(last.card);
			showToast('Review undone');
		} catch (error) {
			console.error('Failed to undo flashcard review:', error);
			history.push(last);
			currentIndex = previousIndex;
			isRevealed = previousRevealState;
			isFinished = previousFinishedState;
			sessionStudied = previousStudied;
			sessionForgot = previousForgot;
			sessionRemembered = previousRemembered;
			showToast('Could not undo review');
		} finally {
			isProcessing = false;
		}
	}

	function handleNext() {
		if (!isProcessing && !isFinished && currentIndex + 1 < items.length) {
			currentIndex += 1;
			isRevealed = false;
		}
	}

	function handlePrev() {
		if (!isProcessing && !isFinished && currentIndex > 0) {
			currentIndex -= 1;
			isRevealed = false;
		}
	}

	function handleToggleTodoTag() {
		if (!currentCard || isProcessing || isFinished) return;
		const hasTodo = currentCard.tags.includes('card/todo');
		if (hasTodo) {
			currentCard.tags = currentCard.tags.filter((t) => t !== 'card/todo');
			showToast('Removed #card/todo tag');
		} else {
			currentCard.tags.push('card/todo');
			showToast('Added #card/todo tag');
		}
		void onToggleTodo?.(currentCard);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement ||
			(e.target as HTMLElement)?.isContentEditable
		) {
			return;
		}

		if (e.key === 'Escape') {
			onClose?.();
			return;
		}

		if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') || (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'u')) {
			e.preventDefault();
			void handleUndo();
			return;
		}

		if (isFinished || isProcessing) return;

		if (e.key === 't' || e.key === 'T') {
			e.preventDefault();
			handleToggleTodoTag();
			return;
		}

		if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
			e.preventDefault();
			if (!isRevealed) {
				handleReveal();
			} else {
				void handleGrade('remembered');
			}
		} else if (e.key === 'f' || e.key === 'F' || e.key === '1') {
			e.preventDefault();
			if (!isRevealed) {
				handleReveal();
			} else {
				void handleGrade('forgot');
			}
		} else if (e.key === '3' && isRevealed) {
			e.preventDefault();
			void handleGrade('remembered');
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			handleNext();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			handlePrev();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!isRevealed) handleReveal();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (isRevealed) isRevealed = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="fc-review-stage" tabindex="-1">
	<!-- Top Navigation Bar -->
	<header class="fc-header">
		<!-- Left: Undo Button -->
		<div class="fc-header-left">
			<button
				class="fc-btn-header"
				onclick={handleUndo}
				disabled={history.length === 0 || isProcessing}
				aria-label="Undo (Ctrl+Z / U)"
				title="Undo (Ctrl+Z / U)"
			>
				<span>Undo</span>
			</button>
		</div>

		<!-- Center: Deck Breadcrumb & 4px Progress Line -->
		<div class="fc-header-center">
			<div class="fc-breadcrumbs">
				<span class="fc-crumb-deck" dir="auto">{deckName}</span>
				<span class="fc-crumb-count">{Math.min(currentIndex + 1, totalCards)} / {totalCards}</span>
			</div>
			<div class="fc-progress-track">
				<div class="fc-progress-fill" style="width: {progressPercent}%;"></div>
			</div>
		</div>

		<!-- Right: End Session Button -->
		<div class="fc-header-right">
			<button
				class="fc-btn-header fc-btn-end"
				onclick={onClose}
				aria-label="End session (Esc)"
				title="End session (Esc)"
			>
				<span>End</span>
			</button>
		</div>
	</header>

	<!-- Main Workspace Area -->
	<main class="fc-workspace">
		{#if isFinished}
			<!-- Completion Screen -->
			<div class="fc-completion-card">
				<div class="fc-completion-icon">
					<svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--interactive-accent)" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round">
						<path d="M5.8 11.3 2 22l10.7-3.79" />
						<path d="M4 3h.01" />
						<path d="M22 8h.01" />
						<path d="M15 2h.01" />
						<path d="M22 20h.01" />
						<path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12v0c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" />
						<path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11v0c-.11.7-.7 1.22-1.4 1.22H17" />
						<path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98v0C9.52 4.91 9 5.5 9 6.2V7" />
						<path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />
					</svg>
				</div>
				<h2>Session Completed 🎉</h2>
				<p class="fc-completion-sub">
					Reviewed {sessionStudied} cards in {Math.max(1, Math.round((Date.now() - startTime) / 1000))} seconds.
				</p>

				<div class="fc-stats-grid">
					<div class="fc-stat-box">
						<span class="fc-stat-val">{sessionStudied}</span>
						<span class="fc-stat-lbl">Cards Studied</span>
					</div>
					<div class="fc-stat-box">
						<span class="fc-stat-val">{sessionRetention}%</span>
						<span class="fc-stat-lbl">Retention Rate</span>
					</div>
					<div class="fc-stat-box">
						<span class="fc-stat-val">
							{sessionStudied > 0 ? ((Date.now() - startTime) / 1000 / sessionStudied).toFixed(1) : '0'}s
						</span>
						<span class="fc-stat-lbl">Pace (s/card)</span>
					</div>
					<div class="fc-stat-box">
						<span class="fc-stat-val">{Math.round((Date.now() - startTime) / 1000)}s</span>
						<span class="fc-stat-lbl">Duration</span>
					</div>
				</div>

				<div class="fc-completion-actions">
					<button class="fc-btn-done mod-cta" onclick={onClose}>
						<span>Done</span>
					</button>
				</div>
			</div>
		{:else if currentCard}
			<!-- Flashcard Stage -->
			<div class="fc-card-container">
				<article class="fc-card">
					<!-- Card Header Meta -->
					<div class="fc-card-meta">
						<span class="fc-note-title" dir="auto">{currentCard.noteTitle}</span>
						<div class="fc-meta-badges">
							{#if currentCard.direction === 'reverse'}
								<span class="fc-badge fc-badge-reverse">Reverse</span>
							{/if}
							{#if currentCard.tags.includes('card/todo')}
								<span class="fc-badge fc-badge-todo">Todo</span>
							{/if}
							<span class="fc-card-due" dir="auto">{currentCard.dueHuman}</span>
						</div>
					</div>

					<!-- Card Content -->
					<div class="fc-card-body">
						<div
							class="fc-card-front"
							dir="auto"
							use:renderMarkdownAction={{ app, markdown: cardDisplay?.frontMarkdown ?? '', sourcePath: currentCard.notePath }}
						></div>

						<!-- Divider and Back Content (only for non-cloze cards) -->
						{#if !cardDisplay?.isCloze && isRevealed && cardDisplay?.backMarkdown}
							<div class="fc-card-divider"></div>
							<div
								class="fc-card-back"
								dir="auto"
								use:renderMarkdownAction={{ app, markdown: cardDisplay.backMarkdown, sourcePath: currentCard.notePath }}
							></div>
						{/if}
					</div>
				</article>
			</div>
		{/if}
	</main>

	<!-- Clamped Bottom Action Bar: [Back] [Forgot / Remembered] [Next] -->
	{#if currentCard && !isFinished}
		<footer class="fc-bottom-bar">
			<!-- Back Navigation Button -->
			<button
				class="fc-nav-btn"
				onclick={handlePrev}
				disabled={currentIndex === 0 || isProcessing}
				aria-label="Back (←)"
				title="Back (←)"
			>
				<span>Back</span>
			</button>

			<!-- Center Action Group -->
			<div class="fc-center-actions">
				{#if !isRevealed}
					<button
						class="fc-action-btn fc-btn-reveal mod-cta"
						onclick={handleReveal}
						disabled={isProcessing}
						aria-label="Show Answer (Space)"
						title="Show Answer (Space)"
					>
						<span>Show Answer</span>
					</button>
				{:else}
					<div class="fc-rating-pair">
						<button
							class="fc-action-btn fc-btn-forgot"
							onclick={() => handleGrade('forgot')}
							disabled={isProcessing}
							aria-label="Forgot (F / 1)"
							title="Forgot (F / 1)"
						>
							<span>Forgot</span>
						</button>
						<button
							class="fc-action-btn fc-btn-remembered mod-cta"
							onclick={() => handleGrade('remembered')}
							disabled={isProcessing}
							aria-label="Remembered (Space / 3)"
							title="Remembered (Space / 3)"
						>
							<span>Remembered</span>
						</button>
					</div>
				{/if}
			</div>

			<!-- Next Navigation Button -->
			<button
				class="fc-nav-btn"
				onclick={handleNext}
				disabled={currentIndex >= items.length - 1 || isProcessing}
				aria-label="Next (→)"
				title="Next (→)"
			>
				<span>Next</span>
			</button>
		</footer>
	{/if}

	<!-- Toast Notification -->
	{#if toastMessage}
		<div class="fc-toast">
			<span dir="auto">{toastMessage}</span>
		</div>
	{/if}
</div>

<style>
	.fc-review-stage {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		background: var(--background-secondary);
		color: var(--text-normal);
		outline: none;
		user-select: text;
		position: relative;
		overflow: hidden;
	}

	/* Top Navigation Bar */
	.fc-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		background: var(--background-primary);
		border-bottom: var(--border-width) solid var(--background-modifier-border);
		z-index: 10;
		gap: 12px;
		flex-shrink: 0;
	}

	.fc-header-left,
	.fc-header-right {
		display: flex;
		align-items: center;
		min-width: 60px;
	}

	.fc-header-right {
		justify-content: flex-end;
	}

	.fc-btn-header {
		display: inline-flex;
		align-items: center;
		padding: 6px 14px;
		font-size: var(--font-ui-small);
		font-weight: 500;
		color: var(--text-muted);
		background: transparent;
		border: var(--border-width) solid var(--background-modifier-border);
		border-radius: var(--radius-m);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.fc-btn-header:hover:not(:disabled) {
		color: var(--text-normal);
		background: var(--background-modifier-hover);
		border-color: var(--background-modifier-border-hover);
	}

	.fc-btn-header:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.fc-header-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		flex: 1;
		max-width: 400px;
	}

	.fc-breadcrumbs {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
	}

	.fc-crumb-deck {
		font-weight: 600;
		color: var(--text-normal);
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fc-crumb-count {
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
	}

	.fc-progress-track {
		width: 100%;
		height: 4px;
		background: var(--background-modifier-border);
		border-radius: 2px;
		overflow: hidden;
	}

	.fc-progress-fill {
		height: 100%;
		background: var(--interactive-accent);
		transition: width 0.25s ease;
		border-radius: 2px;
	}

	/* Main Workspace Area */
	.fc-workspace {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 20px 16px;
		overflow-y: auto;
		background: var(--background-secondary);
	}

	.fc-card-container {
		width: 100%;
		max-width: 760px;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	.fc-card {
		background: var(--background-primary);
		border: var(--border-width) solid var(--background-modifier-border);
		border-radius: var(--radius-l);
		box-shadow: var(--shadow-l);
		padding: 28px 32px;
		display: flex;
		flex-direction: column;
		min-height: 280px;
		max-height: calc(100vh - 190px);
		overflow: hidden;
	}

	.fc-card-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 14px;
		margin-bottom: 16px;
		border-bottom: var(--border-width) solid var(--background-modifier-border);
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.fc-note-title {
		font-weight: 500;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 60%;
	}

	.fc-meta-badges {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}

	.fc-badge-reverse {
		color: var(--text-accent);
	}

	.fc-badge-todo {
		color: var(--text-error);
	}

	.fc-card-due {
		color: var(--text-muted);
		opacity: 0.85;
	}

	.fc-card-body {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.fc-card-front,
	.fc-card-back {
		font-size: clamp(1.15rem, 2vw, 1.35rem);
		line-height: 1.6;
		color: var(--text-normal);
		word-break: break-word;
	}

	:global(.fc-cloze-mask) {
		background: var(--background-modifier-border);
		color: var(--text-muted);
		padding: 2px 8px;
		border-radius: var(--radius-s);
		font-weight: 600;
		user-select: none;
	}

	:global(.fc-cloze-revealed) {
		background: transparent;
		color: var(--text-accent);
		font-weight: 700;
		text-decoration: underline;
		text-decoration-thickness: 2px;
	}

	.fc-card-divider {
		height: 1px;
		background: var(--background-modifier-border);
		margin: 8px 0;
		flex-shrink: 0;
	}

	/* Bottom Clamped Action Bar */
	.fc-bottom-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 20px;
		background: var(--background-primary);
		border-top: var(--border-width) solid var(--background-modifier-border);
		gap: 12px;
		z-index: 10;
		flex-shrink: 0;
	}

	.fc-nav-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 16px;
		height: 48px;
		font-size: var(--font-ui-small);
		font-weight: 500;
		border-radius: var(--radius-m);
		background: var(--background-secondary);
		border: var(--border-width) solid var(--background-modifier-border);
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.fc-nav-btn:hover:not(:disabled) {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
		border-color: var(--background-modifier-border-hover);
	}

	.fc-nav-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.fc-center-actions {
		flex: 1;
		display: flex;
		justify-content: center;
		max-width: 600px;
	}

	.fc-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 48px;
		font-size: var(--font-ui-medium);
		font-weight: 600;
		border-radius: var(--radius-m);
		cursor: pointer;
		transition: all 0.15s ease;
		padding: 0 20px;
	}

	.fc-btn-reveal {
		width: 100%;
		max-width: 380px;
		height: 50px;
	}

	.fc-rating-pair {
		display: flex;
		gap: 12px;
		width: 100%;
		max-width: 500px;
	}

	.fc-btn-forgot {
		flex: 1;
		background: var(--background-secondary);
		border: var(--border-width) solid var(--background-modifier-error);
		color: var(--text-error);
	}

	.fc-btn-forgot:hover:not(:disabled) {
		background: var(--background-modifier-error-hover);
	}

	.fc-btn-remembered {
		flex: 1;
	}

	/* Completion Screen */
	.fc-completion-card {
		background: var(--background-primary);
		border: var(--border-width) solid var(--background-modifier-border);
		border-radius: var(--radius-l);
		box-shadow: var(--shadow-l);
		padding: 40px;
		max-width: 520px;
		width: 100%;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.fc-completion-icon {
		margin-bottom: 16px;
	}

	.fc-completion-card h2 {
		margin: 0 0 8px 0;
		font-size: var(--font-ui-large);
	}

	.fc-completion-sub {
		color: var(--text-muted);
		margin: 0 0 24px 0;
		font-size: var(--font-ui-medium);
	}

	.fc-stats-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
		width: 100%;
		margin-bottom: 28px;
	}

	.fc-stat-box {
		background: var(--background-secondary);
		border: var(--border-width) solid var(--background-modifier-border);
		border-radius: var(--radius-m);
		padding: 14px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.fc-stat-val {
		font-size: 22px;
		font-weight: 700;
		color: var(--text-accent);
	}

	.fc-stat-lbl {
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
	}

	.fc-completion-actions {
		width: 100%;
	}

	.fc-btn-done {
		width: 100%;
		height: 44px;
		font-weight: 600;
		border-radius: var(--radius-m);
		cursor: pointer;
	}

	/* Toast Notification */
	.fc-toast {
		position: fixed;
		bottom: 84px;
		left: 50%;
		transform: translateX(-50%);
		background: var(--background-primary);
		border: var(--border-width) solid var(--background-modifier-border);
		box-shadow: var(--shadow-l);
		border-radius: var(--radius-m);
		padding: 8px 16px;
		font-size: var(--font-ui-small);
		color: var(--text-normal);
		z-index: 50;
		animation: fcFadeIn 0.15s ease;
	}

	@keyframes fcFadeIn {
		from {
			opacity: 0;
			transform: translate(-50%, 8px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}

	/* Mobile Optimizations (<= 768px) */
	@media (max-width: 768px) {
		.fc-header {
			padding: 8px 12px;
		}

		.fc-workspace {
			padding: 12px;
		}

		.fc-card {
			padding: 20px 18px;
			min-height: 240px;
			box-shadow: none;
			border-radius: var(--radius-m);
		}

		.fc-bottom-bar {
			padding: 10px 12px max(28px, env(safe-area-inset-bottom));
		}

		.fc-nav-btn {
			padding: 0 12px;
			height: 48px;
		}

		.fc-action-btn {
			height: 48px;
			font-size: var(--font-ui-small);
			padding: 0 12px;
		}
	}
</style>
