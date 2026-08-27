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
	let isDrawerOpen = $state(false);
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
	let progressText = $derived(progress.progressText);
	let sessionRetention = $derived(calculateRetention(sessionStudied, sessionRemembered));

	let cardDisplay = $derived.by(() => {
		if (!currentCard) return null;
		if (currentCard.cardType === 'cloze') {
			const text = currentCard.front;
			const frontMarkdown = isRevealed
				? text.replace(/==([^=]+)==/g, '<mark class="fc-cloze-revealed">$1</mark>')
				: text.replace(/==([^=]+)==/g, '<span class="fc-cloze-mask">[ ... ]</span>');
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
		}, 3000);
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

	let touchStartX = $state(0);
	let touchStartY = $state(0);

	function handleTouchStart(e: TouchEvent) {
		const touch = e.touches[0];
		if (touch) {
			touchStartX = touch.clientX;
			touchStartY = touch.clientY;
		}
	}

	function handleTouchEnd(e: TouchEvent) {
		const touch = e.changedTouches[0];
		if (!touch) return;
		const deltaX = touch.clientX - touchStartX;
		const deltaY = touch.clientY - touchStartY;

		// Horizontal swipe threshold 40px dominant over vertical
		if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
			if (deltaX > 0) {
				handlePrev();
			} else {
				handleNext();
			}
		}
	}

	function handleWorkspaceTap(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		// Exception: tapping on the card itself, bottom bar, or interactive elements
		if (target?.closest('.fc-card, .fc-bottom-bar, a, button, input, textarea, select, kbd, mark, code')) {
			return;
		}
		if (window.getSelection()?.toString()) return;

		const clickX = e.clientX;
		const isLeftHalf = clickX < window.innerWidth / 2;

		if (isLeftHalf) {
			handlePrev();
		} else {
			handleNext();
		}
	}

	function handleToggleTodoTag() {
		if (!currentCard || isProcessing || isFinished) return;
		const hasTodo = currentCard.tags.includes('todo/card');
		if (hasTodo) {
			currentCard.tags = currentCard.tags.filter((t) => t !== 'todo/card');
			showToast('Removed #todo/card tag from card block');
		} else {
			currentCard.tags.push('todo/card');
			showToast('Added #todo/card tag to card block');
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

		if (e.key === '?' || (e.shiftKey && e.key === '/')) {
			e.preventDefault();
			isDrawerOpen = !isDrawerOpen;
			return;
		}

		if (e.key === 'Escape') {
			if (isDrawerOpen) {
				isDrawerOpen = false;
				return;
			}
			onClose?.();
			return;
		}

		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
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

		if (e.key === ' ' || e.code === 'Space') {
			e.preventDefault();
			if (!isRevealed) {
				handleReveal();
			} else {
				void handleGrade('remembered');
			}
		} else if (e.key === 'f' || e.key === 'F') {
			e.preventDefault();
			if (!isRevealed) {
				handleReveal();
			} else {
				void handleGrade('forgot');
			}
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
		<div class="fc-header-left">
			<button class="clickable-icon" onclick={onClose} aria-label="Close (Esc)">
				<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
			<div class="fc-breadcrumbs">
				<span class="fc-crumb-deck" dir="auto">{deckName}</span>
				<span class="fc-crumb-sep">/</span>
				<span class="fc-crumb-mode">Due cards</span>
			</div>
		</div>

		<div class="fc-header-right">
			<div class="fc-progress-pill">
				<div class="fc-progress-ring" style="--p: {progressPercent}%"></div>
				<span class="fc-progress-text">{progressText}</span>
			</div>
			<button class="clickable-icon" onclick={() => isDrawerOpen = true} aria-label="Shortcuts (?)">
				<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
					<rect x="2" y="4" width="20" height="16" rx="2"></rect>
					<path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10"></path>
				</svg>
			</button>
		</div>
	</header>

	<!-- Main Workspace Area -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<main
		class="fc-workspace"
		onclick={handleWorkspaceTap}
		ontouchstart={handleTouchStart}
		ontouchend={handleTouchEnd}
	>
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
				<h2>Session Complete!</h2>
				<p class="fc-completion-sub">You have reviewed all due cards in this queue.</p>

				<div class="fc-stats-grid">
					<div class="fc-stat-box">
						<span class="fc-stat-val">{sessionStudied}</span>
						<span class="fc-stat-lbl">Cards Studied</span>
					</div>
					<div class="fc-stat-box">
						<span class="fc-stat-val">{sessionRetention}%</span>
						<span class="fc-stat-lbl">Retention</span>
					</div>
					<div class="fc-stat-box">
						<span class="fc-stat-val">{Math.round((Date.now() - startTime) / 1000)}s</span>
						<span class="fc-stat-lbl">Time Spent</span>
					</div>
				</div>
			</div>
		{:else if currentCard}
			<!-- Flashcard Stage -->
			<div class="fc-card-container">
				<article class="fc-card">
					<!-- Card Header Meta -->
					<div class="fc-card-meta">
						<span class="fc-note-title" dir="auto">{currentCard.noteTitle}</span>
						{#if currentCard.direction === 'reverse'}
							<span class="fc-badge fc-badge-reverse">Reverse</span>
						{/if}
						{#if currentCard.tags.includes('todo/card')}
							<span class="fc-badge fc-badge-todo">Todo</span>
						{/if}
						<span class="fc-card-due" dir="auto">{currentCard.dueHuman}</span>
					</div>

					<!-- Card Content -->
					<div
						class="fc-card-front"
						class:fc-card-cloze={cardDisplay?.isCloze}
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

					<!-- Bottom Subtle Hint (Desktop) -->
					<div class="fc-card-hint">
						{#if !isRevealed}
							<span>Press <kbd>Space</kbd> to reveal answer</span>
						{:else}
							<span>Press <kbd>Space</kbd> if remembered, <kbd>F</kbd> if forgot</span>
						{/if}
					</div>
				</article>
			</div>
		{/if}
	</main>

	<!-- Clamped Bottom Action Bar (Mobile Only) -->
	{#if currentCard && !isFinished}
		<footer class="fc-bottom-bar">
			{#if !isRevealed}
				<button class="fc-btn-mobile-action mod-cta" onclick={handleReveal} disabled={isProcessing}>
					<span>Show Answer</span>
				</button>
			{:else}
				<div class="fc-mobile-rating-group">
					<button class="fc-btn-mobile-action" onclick={() => handleGrade('forgot')} disabled={isProcessing}>
						<span>Forgot</span>
					</button>
					<button class="fc-btn-mobile-action mod-cta" onclick={() => handleGrade('remembered')} disabled={isProcessing}>
						<span>Remembered</span>
					</button>
				</div>
			{/if}
		</footer>
	{/if}

	<!-- Cheatsheet Drawer -->
	{#if isDrawerOpen}
		<div class="fc-drawer-overlay" onclick={() => isDrawerOpen = false} role="presentation"></div>
		<aside class="fc-drawer">
			<div class="fc-drawer-header">
				<h3>Keyboard Shortcuts</h3>
				<button class="clickable-icon" onclick={() => isDrawerOpen = false} aria-label="Close">
					<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>
			<div class="fc-drawer-content">
				<div class="fc-shortcut-row">
					<span>Mark Remembered</span>
					<kbd>Space</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Mark Forgot</span>
					<kbd>F</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Reveal Answer</span>
					<span><kbd>Space</kbd>/<kbd>↓</kbd></span>
				</div>
				<div class="fc-shortcut-row">
					<span>Hide Answer</span>
					<kbd>↑</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Next Card (Skip)</span>
					<kbd>→</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Previous Card</span>
					<kbd>←</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Undo Last Review</span>
					<kbd>Ctrl + Z</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Toggle <code>#todo/card</code> tag on Card</span>
					<kbd>T</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Toggle Cheatsheet</span>
					<kbd>?</kbd>
				</div>
				<div class="fc-shortcut-row">
					<span>Close Modal</span>
					<kbd>Esc</kbd>
				</div>
			</div>
		</aside>
	{/if}

	<!-- Toast Notification -->
	{#if toastMessage}
		<div class="fc-toast">
			<span dir="auto">{toastMessage}</span>
		</div>
	{/if}
</div>
