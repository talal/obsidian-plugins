<script lang="ts">
	interface Props {
		currentIndex: number;
		isRevealed: boolean;
		isProcessing: boolean;
		onPrev: () => void;
		onReveal: () => void;
		onGrade: (rating: 'forgot' | 'remembered') => void;
	}

	let {
		currentIndex,
		isRevealed,
		isProcessing,
		onPrev,
		onReveal,
		onGrade,
	}: Props = $props();
</script>

<footer class="fc-bottom-bar">
	<button
		class="fc-nav-btn"
		onclick={onPrev}
		disabled={currentIndex === 0 || isProcessing}
		aria-label="Back (←)"
		title="Back (←)"
	>
		<span>Back</span>
	</button>

	<div class="fc-center-actions">
		{#if !isRevealed}
			<button
				class="fc-action-btn fc-btn-reveal mod-cta"
				onclick={onReveal}
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
					onclick={() => onGrade('forgot')}
					disabled={isProcessing}
					aria-label="Forgot (F / 1)"
					title="Forgot (F / 1)"
				>
					<span>Forgot</span>
				</button>
				<button
					class="fc-action-btn fc-btn-remembered mod-cta"
					onclick={() => onGrade('remembered')}
					disabled={isProcessing}
					aria-label="Remembered (Space / 3)"
					title="Remembered (Space / 3)"
				>
					<span>Remembered</span>
				</button>
			</div>
		{/if}
	</div>
</footer>
