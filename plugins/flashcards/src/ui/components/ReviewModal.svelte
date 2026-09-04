<script lang="ts">
	import type { App } from 'obsidian';
	import type { ReviewItem } from '../../types.ts';
	import { formatClozeText } from '../../utils/clozeFormat.ts';
	import { calculateProgress, calculateRetention } from '../../utils/reviewMetrics.ts';
	import ReviewBottomBar from './ReviewBottomBar.svelte';
	import ReviewCardCanvas from './ReviewCardCanvas.svelte';
	import ReviewCompletionScreen from './ReviewCompletionScreen.svelte';
	import ReviewTopBar from './ReviewTopBar.svelte';

	interface Props {
		app?: App;
		items: ReviewItem[];
		deckName?: string;
		onGrade?: (
			item: ReviewItem,
			rating: 'forgot' | 'remembered',
		) => Promise<{ isLeech?: boolean } | void> | { isLeech?: boolean } | void;
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
		if (currentCard.card_type === 'cloze') {
			return {
				isCloze: true,
				frontMarkdown: formatClozeText(currentCard.front, isRevealed),
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
			const gradeResult = await onGrade?.(card, rating);
			history.push({
				index: currentIndex,
				wasRevealed,
				card: previousCard,
				rating,
			});

			sessionStudied += 1;
			if (rating === 'forgot') {
				sessionForgot += 1;
				if (gradeResult && typeof gradeResult === 'object' && gradeResult.isLeech) {
					showToast('Marked as leech (#card/leech)');
				} else {
					showToast('Marked as forgot');
				}
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

	function handlePrev() {
		if (!isProcessing && !isFinished && currentIndex > 0) {
			currentIndex -= 1;
			isRevealed = false;
		}
	}

	function handleNext() {
		if (!isProcessing && !isFinished && currentIndex + 1 < items.length) {
			currentIndex += 1;
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

		if (
			((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') ||
			(!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'u')
		) {
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
	<ReviewTopBar
		{deckName}
		{currentIndex}
		{totalCards}
		{progressPercent}
		canUndo={history.length > 0}
		{isProcessing}
		onUndo={handleUndo}
		onClose={() => onClose?.()}
	/>

	<main class="fc-workspace">
		{#if isFinished}
			<ReviewCompletionScreen
				{sessionStudied}
				{sessionRetention}
				{startTime}
				onClose={() => onClose?.()}
			/>
		{:else if currentCard}
			<ReviewCardCanvas {app} card={currentCard} {isRevealed} {cardDisplay} />
		{/if}
	</main>

	{#if currentCard && !isFinished}
		<ReviewBottomBar
			{currentIndex}
			{totalCards}
			{isRevealed}
			{isProcessing}
			onPrev={handlePrev}
			onNext={handleNext}
			onReveal={handleReveal}
			onGrade={handleGrade}
		/>
	{/if}

	{#if toastMessage}
		<div class="fc-toast" role="status">
			{toastMessage}
		</div>
	{/if}
</div>
