<script lang="ts">
	interface Props {
		availableTags?: string[];
		onSelectTags: (tags: string[]) => void;
		onClose: () => void;
	}

	let { availableTags = [], onSelectTags, onClose }: Props = $props();

	let tagInput = $state('');

	let selectedTags = $derived(
		tagInput
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => t.replace(/^#/, ''))
	);

	function handleSubmit(e?: Event) {
		e?.preventDefault();
		if (selectedTags.length > 0) {
			onSelectTags(selectedTags);
		}
	}

	function toggleTag(tag: string) {
		const current = [...selectedTags];
		const lower = tag.toLowerCase();
		const index = current.findIndex((t) => t.toLowerCase() === lower);
		if (index >= 0) {
			current.splice(index, 1);
		} else {
			current.push(tag);
		}
		tagInput = current.join(' ');
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<p class="setting-item-description">Select or enter tags to assemble a custom practice queue.</p>

<form onsubmit={handleSubmit}>
	<div class="search-input-container">
		<input
			type="search"
			class="search-input"
			placeholder="e.g. geography pakistan"
			dir="auto"
			bind:value={tagInput}
		/>
	</div>

	{#if availableTags.length > 0}
		<div class="fc-tag-suggestions">
			<span class="setting-item-description">Available tags in cards:</span>
			<div class="fc-suggest-chips">
				{#each availableTags as tag}
					{@const isSelected = selectedTags.some((s) => s.toLowerCase() === tag.toLowerCase())}
					<button
						type="button"
						class="fc-pill"
						class:active={isSelected}
						onclick={() => toggleTag(tag)}
						dir="auto"
					>
						#{tag}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="modal-button-container">
		<button type="button" onclick={onClose}>Cancel</button>
		<button type="submit" class="mod-cta" disabled={selectedTags.length === 0}>
			Start study session ({selectedTags.length > 0 ? selectedTags.length : 0} tags)
		</button>
	</div>
</form>
