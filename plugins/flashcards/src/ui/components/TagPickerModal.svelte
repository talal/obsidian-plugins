<script lang="ts">
	import type { TagDeckStat } from '../../utils/tagStats.ts';

	interface Props {
		tagStats?: TagDeckStat[];
		onSelectTags: (tags: string[]) => void;
		onClose: () => void;
	}

	let { tagStats = [], onSelectTags, onClose }: Props = $props();

	let selectedTags = $state<Set<string>>(new Set());
	let sortColumn = $state<'tag' | 'due' | 'new' | 'total'>('due');
	let sortAsc = $state(false);

	let sortedTags = $derived(
		[...tagStats].sort((a, b) => {
			let cmp = 0;
			if (sortColumn === 'tag') {
				cmp = a.tag.localeCompare(b.tag);
			} else if (sortColumn === 'due') {
				cmp = a.due - b.due;
			} else if (sortColumn === 'new') {
				cmp = a.newCards - b.newCards;
			} else if (sortColumn === 'total') {
				cmp = a.total - b.total;
			}
			return sortAsc ? cmp : -cmp;
		}),
	);

	let allSelected = $derived(
		sortedTags.length > 0 && sortedTags.every((t) => selectedTags.has(t.tag.toLowerCase())),
	);

	let selectedSummary = $derived.by(() => {
		let due = 0;
		let newCards = 0;
		let total = 0;
		for (const item of tagStats) {
			if (selectedTags.has(item.tag.toLowerCase())) {
				due += item.due;
				newCards += item.newCards;
				total += item.total;
			}
		}
		return { due, newCards, total };
	});

	function toggleSort(col: 'tag' | 'due' | 'new' | 'total') {
		if (sortColumn === col) {
			sortAsc = !sortAsc;
		} else {
			sortColumn = col;
			sortAsc = col === 'tag' ? true : false;
		}
	}

	function toggleTag(tag: string) {
		const next = new Set(selectedTags);
		const lower = tag.toLowerCase();
		if (next.has(lower)) {
			next.delete(lower);
		} else {
			next.add(lower);
		}
		selectedTags = next;
	}

	function toggleSelectAll() {
		const next = new Set(selectedTags);
		if (allSelected) {
			next.clear();
		} else {
			for (const item of tagStats) {
				next.add(item.tag.toLowerCase());
			}
		}
		selectedTags = next;
	}

	function handleStart() {
		if (selectedTags.size > 0) {
			onSelectTags(Array.from(selectedTags));
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		} else if (e.key === 'Enter') {
			if (selectedTags.size > 0) {
				handleStart();
			}
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<p class="setting-item-description fc-tag-modal-description">Select tags to assemble a custom study queue.</p>

<div class="fc-tag-table-container">
	<table class="fc-table fc-tag-table">
		<thead>
			<tr>
				<th class="fc-col-select">
					<input
						type="checkbox"
						checked={allSelected}
						aria-label="Select all tags"
						onchange={toggleSelectAll}
					/>
				</th>
				<th onclick={() => toggleSort('tag')} class="fc-sortable fc-col-tag">
					Tag {sortColumn === 'tag' ? (sortAsc ? '↑' : '↓') : ''}
				</th>
				<th onclick={() => toggleSort('due')} class="fc-sortable fc-col-num">
					Due {sortColumn === 'due' ? (sortAsc ? '↑' : '↓') : ''}
				</th>
				<th onclick={() => toggleSort('new')} class="fc-sortable fc-col-num">
					New {sortColumn === 'new' ? (sortAsc ? '↑' : '↓') : ''}
				</th>
				<th onclick={() => toggleSort('total')} class="fc-sortable fc-col-num">
					Total {sortColumn === 'total' ? (sortAsc ? '↑' : '↓') : ''}
				</th>
			</tr>
		</thead>
		<tbody>
			{#if sortedTags.length === 0}
				<tr>
					<td colspan="5" class="fc-empty-row">No tags found.</td>
				</tr>
			{:else}
				{#each sortedTags as item (item.tag)}
					{@const isChecked = selectedTags.has(item.tag.toLowerCase())}
					<tr
						class="fc-tag-row"
						class:is-selected={isChecked}
						onclick={() => toggleTag(item.tag)}
					>
						<td class="fc-col-select" onclick={(e) => e.stopPropagation()}>
							<input
								type="checkbox"
								checked={isChecked}
								aria-label={`Select tag ${item.tag}`}
								onchange={() => toggleTag(item.tag)}
							/>
						</td>
						<td class="fc-col-tag">
							<span class="tag" dir="auto">#{item.tag}</span>
						</td>
						<td class="fc-col-num" class:fc-stat-due={item.due > 0} class:fc-stat-zero={item.due === 0}>
							{item.due}
						</td>
						<td class="fc-col-num" class:fc-stat-new={item.newCards > 0} class:fc-stat-zero={item.newCards === 0}>
							{item.newCards}
						</td>
						<td class="fc-col-num">
							{item.total}
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

<div class="modal-button-container">
	<button type="button" onclick={onClose}>Cancel</button>
	<button
		type="button"
		class="mod-cta"
		disabled={selectedTags.size === 0}
		onclick={handleStart}
	>
		{#if selectedTags.size === 0}
			Select tags to study
		{:else}
			Study selected ({selectedSummary.due} due • {selectedSummary.total} total)
		{/if}
	</button>
</div>
