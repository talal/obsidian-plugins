<script lang="ts">
	import { setIcon } from 'obsidian';

	import type { DashboardStats, ReviewItem } from '../../types.ts';
	import {
		filterDashboardBlock,
		groupCardsByBlock,
		type DashboardBlockItem,
	} from '../../utils/dashboardCards.ts';

	interface Props {
		items: ReviewItem[];
		stats: DashboardStats;
		dueCutoff: number;
		onStartReview?: () => void;
		onStudyDeck?: () => void;
		onSync?: () => void;
		onOpenCard?: (item: ReviewItem) => void;
	}

	let {
		items = [],
		stats,
		dueCutoff,
		onStartReview,
		onStudyDeck,
		onSync,
		onOpenCard,
	}: Props = $props();

	function icon(node: HTMLElement, name: string) {
		setIcon(node, name);
		return {
			update(newName: string) {
				setIcon(node, newName);
			},
		};
	}

	let searchQuery = $state('');
	let statusFilter = $state<'all' | 'due' | 'new' | 'learning' | 'review'>('all');
	let sortColumn = $state<'note' | 'due' | 'reviews' | 'last'>('due');
	let sortAsc = $state(true);

	let blockItems = $derived(groupCardsByBlock(items));

	let statusCounts = $derived({
		all: blockItems.length,
		due: blockItems.filter((b) => filterDashboardBlock(b, 'due', dueCutoff, '')).length,
		new: blockItems.filter((b) => filterDashboardBlock(b, 'new', dueCutoff, '')).length,
		learning: blockItems.filter((b) => filterDashboardBlock(b, 'learning', dueCutoff, '')).length,
		review: blockItems.filter((b) => filterDashboardBlock(b, 'review', dueCutoff, '')).length,
	});

	let filteredItems = $derived(
		blockItems
			.filter((item) => filterDashboardBlock(item, statusFilter, dueCutoff, searchQuery))
			.sort((a, b) => {
				let cmp = 0;
				if (sortColumn === 'note') {
					cmp = a.noteTitle.localeCompare(b.noteTitle);
				} else if (sortColumn === 'due') {
					const aDue = Math.min(a.forward?.dueAt ?? Infinity, a.reverse?.dueAt ?? Infinity);
					const bDue = Math.min(b.forward?.dueAt ?? Infinity, b.reverse?.dueAt ?? Infinity);
					cmp = aDue - bDue;
				} else if (sortColumn === 'reviews') {
					const aReps = (a.forward?.reps ?? 0) + (a.reverse?.reps ?? 0);
					const bReps = (b.forward?.reps ?? 0) + (b.reverse?.reps ?? 0);
					cmp = aReps - bReps;
				} else if (sortColumn === 'last') {
					const aLast = Math.max(a.forward?.lastReview ?? 0, a.reverse?.lastReview ?? 0);
					const bLast = Math.max(b.forward?.lastReview ?? 0, b.reverse?.lastReview ?? 0);
					cmp = aLast - bLast;
				}
				return sortAsc ? cmp : -cmp;
			}),
	);

	function toggleSort(col: 'note' | 'due' | 'reviews' | 'last') {
		if (sortColumn === col) {
			sortAsc = !sortAsc;
		} else {
			sortColumn = col;
			sortAsc = true;
		}
	}
</script>

<div class="fc-dashboard">
	<!-- Top Overview Metric Bar -->
	<header class="fc-dashboard-header">
		<div class="fc-stats-bar">
			<div class="fc-stat-item">
				<span class="fc-stat-number">{stats.studiedToday}</span>
				<span class="fc-stat-label">Studied today</span>
			</div>
			<div class="fc-stat-divider"></div>
			<div class="fc-stat-item">
				<span class="fc-stat-number">{stats.dailyRetention}%</span>
				<span class="fc-stat-label">Retention</span>
			</div>
			<div class="fc-stat-divider"></div>
			<div class="fc-stat-item">
				<span class="fc-stat-number">🔥 {stats.studyStreak}d</span>
				<span class="fc-stat-label">Streak</span>
			</div>
			<div class="fc-stat-divider"></div>
			<div class="fc-stat-item">
				<span class="fc-stat-number">{stats.totalCards}</span>
				<span class="fc-stat-label">Total cards</span>
			</div>
		</div>

		<div class="fc-header-actions">
			<button class="mod-cta" onclick={onStartReview}>
				<span>Study all ({stats.dueToday} due)</span>
			</button>
			<button onclick={onStudyDeck}>
				<span>Study deck</span>
			</button>
			<button aria-label="Sync" title="Sync" onclick={onSync} use:icon={'refresh-cw'}></button>
		</div>
	</header>

	<!-- Filter and Search Toolbar -->
	<div class="fc-toolbar">
		<div class="fc-filter-pills">
			<button class="fc-pill" class:active={statusFilter === 'all'} onclick={() => (statusFilter = 'all')}>All ({statusCounts.all})</button>
			<button class="fc-pill" class:active={statusFilter === 'due'} onclick={() => (statusFilter = 'due')}>Due today ({statusCounts.due})</button>
			<button class="fc-pill" class:active={statusFilter === 'new'} onclick={() => (statusFilter = 'new')}>New ({statusCounts.new})</button>
			<button class="fc-pill" class:active={statusFilter === 'learning'} onclick={() => (statusFilter = 'learning')}>Learning ({statusCounts.learning})</button>
			<button class="fc-pill" class:active={statusFilter === 'review'} onclick={() => (statusFilter = 'review')}>Review ({statusCounts.review})</button>
		</div>

		<div class="fc-search-box search-input-container">
			<input type="search" class="search-input" placeholder="Search notes or #tag..." dir="auto" bind:value={searchQuery} />
		</div>
	</div>

	<!-- Cards Table -->
	<div class="fc-table-container">
		<table class="fc-table">
			<thead>
				<tr>
					<th onclick={() => toggleSort('note')} class="fc-sortable">
						Note {sortColumn === 'note' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th>Front (Question)</th>
					<th>Back (Answer)</th>
					<th>Tags</th>
					<th onclick={() => toggleSort('due')} class="fc-sortable">
						Due {sortColumn === 'due' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th onclick={() => toggleSort('reviews')} class="fc-sortable">
						Reviews {sortColumn === 'reviews' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th onclick={() => toggleSort('last')} class="fc-sortable">
						Last practiced {sortColumn === 'last' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
				</tr>
			</thead>
			<tbody>
				{#if filteredItems.length === 0}
					<tr>
						<td colspan="7" class="fc-empty-row">No flashcards match the current filter.</td>
					</tr>
				{:else}
					{#each filteredItems as item (item.blockId)}
						<tr onclick={() => onOpenCard?.(item.forward ?? item.reverse)}>
							<td class="fc-cell-note">
								<span class="fc-note-link" title={item.notePath} dir="auto">{item.noteTitle}</span>
							</td>
							<td>
								<span class="fc-text-preview" dir="auto">{item.front}</span>
							</td>
							<td>
								<span class="fc-text-preview" dir="auto">{item.back}</span>
							</td>
							<td class="fc-cell-tags">
								<div class="fc-tag-list">
									{#each item.tags as tag}
										<span class="tag" dir="auto">#{tag}</span>
									{/each}
								</div>
							</td>
							<td class="fc-cell-due">
								{#if item.forward}
									<span class="fc-due-badge" class:fc-due-now={item.forward.dueAt <= dueCutoff} dir="auto">
										{item.forward.dueHuman}
									</span>
								{/if}
								{#if item.reverse}
									<div class="fc-metric-sub" dir="auto">
										<span class="fc-due-badge" class:fc-due-now={item.reverse.dueAt <= dueCutoff}>
											{item.reverse.dueHuman}
										</span>
										<span class="fc-sub-icon">⇄</span>
									</div>
								{/if}
							</td>
							<td class="fc-cell-reps">
								<span>{item.forward?.reps ?? 0}</span>
								{#if item.reverse}
									<div class="fc-metric-sub">
										<span>{item.reverse.reps}</span>
										<span class="fc-sub-icon">⇄</span>
									</div>
								{/if}
							</td>
							<td class="fc-cell-last">
								<span>{item.forward?.lastPracticedHuman ?? 'Never'}</span>
								{#if item.reverse}
									<div class="fc-metric-sub" dir="auto">
										<span>{item.reverse.lastPracticedHuman}</span>
										<span class="fc-sub-icon">⇄</span>
									</div>
								{/if}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
