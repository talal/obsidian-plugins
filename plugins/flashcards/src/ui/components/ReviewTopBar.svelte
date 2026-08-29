<script lang="ts">
	interface Props {
		deckName: string;
		currentIndex: number;
		totalCards: number;
		progressPercent: number;
		canUndo: boolean;
		isProcessing: boolean;
		onUndo: () => void;
		onClose: () => void;
	}

	let {
		deckName,
		currentIndex,
		totalCards,
		progressPercent,
		canUndo,
		isProcessing,
		onUndo,
		onClose,
	}: Props = $props();
</script>

<header class="fc-header">
	<div class="fc-header-left">
		<button
			class="fc-btn-header"
			onclick={onUndo}
			disabled={!canUndo || isProcessing}
			aria-label="Undo (Ctrl+Z / U)"
			title="Undo (Ctrl+Z / U)"
		>
			<span>Undo</span>
		</button>
	</div>

	<div class="fc-header-center">
		<div class="fc-breadcrumbs">
			<span class="fc-crumb-deck" dir="auto">{deckName}</span>
			<span class="fc-crumb-count">{Math.min(currentIndex + 1, totalCards)} / {totalCards}</span>
		</div>
		<div class="fc-progress-track">
			<div class="fc-progress-fill" style="width: {progressPercent}%;"></div>
		</div>
	</div>

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
