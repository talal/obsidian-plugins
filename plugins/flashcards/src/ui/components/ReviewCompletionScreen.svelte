<script lang="ts">
	interface Props {
		sessionStudied: number;
		sessionRetention: number;
		startTime: number;
		onClose?: () => void;
	}

	let { sessionStudied, sessionRetention, startTime, onClose }: Props = $props();

	let durationSeconds = $derived(Math.max(1, Math.round((Date.now() - startTime) / 1000)));
	let paceSeconds = $derived(
		sessionStudied > 0 ? (durationSeconds / sessionStudied).toFixed(1) : '0',
	);
</script>

<div class="fc-completion-card">
	<div class="fc-completion-icon">
		<svg
			viewBox="0 0 24 24"
			width="48"
			height="48"
			stroke="var(--interactive-accent)"
			stroke-width="1.75"
			fill="none"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
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
		Reviewed {sessionStudied} cards in {durationSeconds} seconds.
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
			<span class="fc-stat-val">{paceSeconds}s</span>
			<span class="fc-stat-lbl">Pace (s/card)</span>
		</div>
		<div class="fc-stat-box">
			<span class="fc-stat-val">{durationSeconds}s</span>
			<span class="fc-stat-lbl">Duration</span>
		</div>
	</div>

	<div class="fc-completion-actions">
		<button class="fc-btn-done mod-cta" onclick={onClose}>
			<span>Done</span>
		</button>
	</div>
</div>
