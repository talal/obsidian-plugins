<script lang="ts">
	import { setIcon } from 'obsidian';

	interface Props {
		sessionStudied: number;
		sessionRetention: number;
		startTime: number;
		onClose?: () => void;
	}

	let { sessionStudied, sessionRetention, startTime, onClose }: Props = $props();

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				setIcon(node, newName);
			},
		};
	}

	let durationSeconds = $derived(Math.max(1, Math.round((Date.now() - startTime) / 1000)));
	let paceSeconds = $derived(
		sessionStudied > 0 ? (durationSeconds / sessionStudied).toFixed(1) : '0',
	);
</script>

<div class="fc-completion-card">
	<div class="fc-completion-icon" use:icon={'party-popper'}></div>
	<h2>Session Completed</h2>
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
