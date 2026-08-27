<script lang="ts">
	import type { DashboardStats, ReviewItem } from '../../types.ts';
	import { filterDashboardCard } from '../../utils/dashboardFilter.ts';

	interface Props {
		items: ReviewItem[];
		stats: DashboardStats;
		dueCutoff: number;
		onStartReview?: () => void;
		onStudyDeck?: () => void;
		onOpenCard?: (item: ReviewItem) => void;
	}

	let { items = [], stats, dueCutoff, onStartReview, onStudyDeck, onOpenCard }: Props = $props();

	let searchQuery = $state('');
	let statusFilter = $state<'all' | 'due' | 'new' | 'learning' | 'review'>('all');
	let sortColumn = $state<'note' | 'due' | 'reviews' | 'last'>('due');
	let sortAsc = $state(true);

	let filteredItems = $derived(
		items
			.filter((item) => {
				// Status Filter
				if (statusFilter === 'due' && item.due > dueCutoff) return false;
				if (statusFilter === 'new' && item.state !== 'new') return false;
				if (statusFilter === 'learning' && item.state !== 'learning') return false;
				if (statusFilter === 'review' && item.state !== 'review') return false;

				return filterDashboardCard(item, searchQuery);
			})
			.sort((a, b) => {
				let cmp = 0;
				if (sortColumn === 'note') cmp = a.noteTitle.localeCompare(b.noteTitle);
				else if (sortColumn === 'due') cmp = a.due - b.due;
				else if (sortColumn === 'reviews') cmp = a.reps - b.reps;
				else if (sortColumn === 'last') cmp = (a.lastReview || 0) - (b.lastReview || 0);
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
	<!-- Top Overview Stats Cards -->
	<div class="fc-overview-header">
		<div class="fc-stats-grid-dashboard">
			<div class="fc-stat-card">
				<span class="fc-stat-number">{stats.studiedToday}</span>
				<span class="fc-stat-label">Studied Today</span>
			</div>
			<div class="fc-stat-card">
				<span class="fc-stat-number">{stats.dailyRetention}%</span>
				<span class="fc-stat-label">Daily Retention</span>
			</div>
			<div class="fc-stat-card">
				<span class="fc-stat-number">🔥 {stats.studyStreak}d</span>
				<span class="fc-stat-label">Study Streak</span>
			</div>
			<div class="fc-stat-card">
				<span class="fc-stat-number">{items.length}</span>
				<span class="fc-stat-label">Total Flashcards</span>
			</div>
		</div>

		<div class="fc-quick-actions">
			<button class="mod-cta" onclick={onStartReview}>
				<span>Study All ({stats.dueToday} due)</span>
			</button>
			<button onclick={onStudyDeck}>
				<span>Study Deck</span>
			</button>
		</div>
	</div>

	<!-- Filter and Search Toolbar -->
	<div class="fc-toolbar">
		<div class="fc-filter-pills">
			<button class="fc-pill" class:active={statusFilter === 'all'} onclick={() => statusFilter = 'all'}>All ({items.length})</button>
			<button class="fc-pill" class:active={statusFilter === 'due'} onclick={() => statusFilter = 'due'}>Due Today ({stats.dueToday})</button>
			<button class="fc-pill" class:active={statusFilter === 'new'} onclick={() => statusFilter = 'new'}>New ({stats.newCards})</button>
			<button class="fc-pill" class:active={statusFilter === 'learning'} onclick={() => statusFilter = 'learning'}>Learning</button>
			<button class="fc-pill" class:active={statusFilter === 'review'} onclick={() => statusFilter = 'review'}>Review</button>
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
					<th onclick={() => toggleSort('note')} class="fc-sortable fc-th-note">
						Note {sortColumn === 'note' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th class="fc-th-front">Front (Question)</th>
					<th class="fc-th-back">Back (Answer)</th>
					<th class="fc-th-tags">Tags</th>
					<th onclick={() => toggleSort('due')} class="fc-sortable fc-th-due">
						Due {sortColumn === 'due' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th onclick={() => toggleSort('reviews')} class="fc-sortable fc-th-reps">
						Reviews {sortColumn === 'reviews' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
					<th onclick={() => toggleSort('last')} class="fc-sortable fc-th-last">
						Last Practiced {sortColumn === 'last' ? (sortAsc ? '↑' : '↓') : ''}
					</th>
				</tr>
			</thead>
			<tbody>
				{#if filteredItems.length === 0}
					<tr>
						<td colspan="7" class="fc-empty-row">No flashcards match the current filter.</td>
					</tr>
				{:else}
					{#each filteredItems as item (item.id)}
						<tr onclick={() => onOpenCard?.(item)}>
							<td class="fc-cell-note">
								<span class="fc-note-link" title={item.notePath} dir="auto">{item.noteTitle}</span>
							</td>
							<td class="fc-cell-front">
								<span class="fc-text-preview" dir="auto">{item.front}</span>
								{#if item.direction === 'reverse'}
									<span class="fc-badge fc-badge-reverse">rev</span>
								{/if}
							</td>
							<td class="fc-cell-back">
								<span class="fc-text-preview" dir="auto">{item.back}</span>
							</td>
							<td class="fc-cell-tags">
								<div class="fc-tag-list">
									{#each item.tags as tag}
										<span class="fc-tag" dir="auto">#{tag}</span>
									{/each}
								</div>
							</td>
							<td class="fc-cell-due">
								<span class="fc-due-badge" class:fc-due-now={item.due <= Date.now()} dir="auto">
									{item.dueHuman}
								</span>
							</td>
							<td class="fc-cell-reps">{item.reps}</td>
							<td class="fc-cell-last">{item.lastPracticedHuman}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
