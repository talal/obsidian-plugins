<script lang="ts">
	import type { TagDeckStats } from '../../types.ts';
	import {
		buildTagTree,
		getAllDescendantTags,
		getSelectedTagSummary,
		getVisibleTagRows,
		isNodeFullySelected,
		isNodeIndeterminate,
		type TagTreeNode,
	} from '../../utils/tagTree.js';

	interface Props {
		tagStats?: TagDeckStats[];
		onSelectTags: (tags: string[]) => void;
		onClose: () => void;
	}

	let { tagStats = [], onSelectTags, onClose }: Props = $props();

	let selectedTags = $state<Set<string>>(new Set());
	let collapsedTags = $state<Set<string>>(new Set());
	let sortColumn = $state<'tag' | 'due' | 'new' | 'total'>('tag');
	let sortAsc = $state(true);

	let treeRoots = $derived(buildTagTree(tagStats));
	let visibleRows = $derived(
		getVisibleTagRows(treeRoots, collapsedTags, sortColumn, sortAsc),
	);

	// Collect all tag keys across entire tree
	let allTagsList = $derived.by(() => {
		const list: string[] = [];
		for (const root of treeRoots) {
			list.push(...getAllDescendantTags(root));
		}
		return list;
	});

	let allSelected = $derived(
		allTagsList.length > 0 && allTagsList.every((t) => selectedTags.has(t)),
	);

	let isHeaderIndeterminate = $derived(
		allTagsList.length > 0 &&
			!allSelected &&
			allTagsList.some((t) => selectedTags.has(t)),
	);

	let selectedSummary = $derived(getSelectedTagSummary(treeRoots, selectedTags));

	function toggleSort(col: 'tag' | 'due' | 'new' | 'total') {
		if (sortColumn === col) {
			sortAsc = !sortAsc;
		} else {
			sortColumn = col;
			sortAsc = col === 'tag';
		}
	}

	function toggleCollapse(fullTag: string) {
		const next = new Set(collapsedTags);
		const lower = fullTag.toLowerCase();
		if (next.has(lower)) {
			next.delete(lower);
		} else {
			next.add(lower);
		}
		collapsedTags = next;
	}

	function toggleNode(node: TagTreeNode) {
		const next = new Set(selectedTags);
		const descendants = getAllDescendantTags(node);
		const fullySelected = isNodeFullySelected(node, selectedTags);

		if (fullySelected) {
			for (const d of descendants) {
				next.delete(d);
			}
		} else {
			for (const d of descendants) {
				next.add(d);
			}
		}
		selectedTags = next;
	}

	function toggleSelectAll() {
		const next = new Set(selectedTags);
		if (allSelected) {
			next.clear();
		} else {
			for (const t of allTagsList) {
				next.add(t);
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

<p class="setting-item-description fc-tag-modal-description">
	Select tags or decks to assemble a study queue. Selecting a parent tag includes its nested tags.
</p>

<div class="fc-tag-table-container">
	<table class="fc-table fc-tag-table">
		<thead>
			<tr>
				<th class="fc-col-select">
					<input
						type="checkbox"
						checked={allSelected}
						indeterminate={isHeaderIndeterminate}
						aria-label="Select all tags"
						onchange={toggleSelectAll}
					/>
				</th>
				<th onclick={() => toggleSort('tag')} class="fc-sortable fc-col-tag">
					Tag / Deck {sortColumn === 'tag' ? (sortAsc ? '↑' : '↓') : ''}
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
			{#if visibleRows.length === 0}
				<tr>
					<td colspan="5" class="fc-empty-row">No tags found.</td>
				</tr>
			{:else}
				{#each visibleRows as node (node.fullTag)}
					{@const isChecked = isNodeFullySelected(node, selectedTags)}
					{@const isIndeterminate = isNodeIndeterminate(node, selectedTags)}
					{@const isCollapsed = collapsedTags.has(node.fullTag.toLowerCase())}
					<tr
						class="fc-tag-row"
						class:is-selected={isChecked || isIndeterminate}
						onclick={() => toggleNode(node)}
					>
						<td class="fc-col-select" onclick={(e) => e.stopPropagation()}>
							<input
								type="checkbox"
								checked={isChecked}
								indeterminate={isIndeterminate}
								aria-label={`Select tag ${node.fullTag}`}
								onchange={() => toggleNode(node)}
							/>
						</td>
						<td
							class="fc-col-tag"
							style="padding-inline-start: calc(var(--size-4-2) + {node.depth * 20}px);"
						>
							<div class="fc-tag-cell">
								{#if node.children.length > 0}
									<button
										type="button"
										class="clickable-icon fc-tree-toggle"
										aria-label={isCollapsed ? 'Expand deck' : 'Collapse deck'}
										onclick={(e) => {
											e.stopPropagation();
											toggleCollapse(node.fullTag);
										}}
									>
										<span class="fc-tree-chevron" class:is-collapsed={isCollapsed}>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<polyline points="6 9 12 15 18 9"></polyline>
											</svg>
										</span>
									</button>
								{:else}
									<span class="fc-tree-spacer"></span>
								{/if}
								<span class="tag" dir="auto" title={node.fullTag}>#{node.name}</span>
							</div>
						</td>
						<td
							class="fc-col-num"
							class:fc-stat-due={node.dueCards > 0}
							class:fc-stat-zero={node.dueCards === 0}
						>
							{node.dueCards}
						</td>
						<td
							class="fc-col-num"
							class:fc-stat-new={node.newCards > 0}
							class:fc-stat-zero={node.newCards === 0}
						>
							{node.newCards}
						</td>
						<td class="fc-col-num">
							{node.totalCards}
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
