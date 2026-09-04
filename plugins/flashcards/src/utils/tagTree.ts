import type { TagDeckStats } from '../types.js';

export interface TagTreeNode {
	fullTag: string; // Canonical full path, e.g. "language/german"
	name: string; // Last segment name, e.g. "german"
	depth: number; // 0 for root, 1 for child, etc.
	dueCards: number;
	newCards: number;
	totalCards: number;
	children: TagTreeNode[];
	parent?: TagTreeNode;
}

/**
 * Builds a hierarchical tag tree from flat TagDeckStats list.
 */
export function buildTagTree(tagStats: TagDeckStats[]): TagTreeNode[] {
	const map = new Map<string, TagTreeNode>();
	const roots: TagTreeNode[] = [];

	// 1. Populate map with known tag stats
	for (const stat of tagStats) {
		const norm = stat.tag.replace(/^#/, '').trim();
		if (!norm) continue;
		const parts = norm.split('/').filter(Boolean);
		if (parts.length === 0) continue;
		const name = parts[parts.length - 1] ?? norm;
		map.set(norm.toLowerCase(), {
			fullTag: norm,
			name,
			depth: parts.length - 1,
			dueCards: stat.due_cards,
			newCards: stat.new_cards,
			totalCards: stat.total_cards,
			children: [],
		});
	}

	// 2. Ensure all ancestor nodes exist (if missing, create synthetic parents)
	for (const node of Array.from(map.values())) {
		const parts = node.fullTag.split('/').filter(Boolean);
		for (let i = 1; i < parts.length; i++) {
			const ancestorTag = parts.slice(0, i).join('/');
			const ancestorKey = ancestorTag.toLowerCase();
			if (!map.has(ancestorKey)) {
				map.set(ancestorKey, {
					fullTag: ancestorTag,
					name: parts[i - 1] ?? ancestorTag,
					depth: i - 1,
					dueCards: 0,
					newCards: 0,
					totalCards: 0,
					children: [],
				});
			}
		}
	}

	// 3. Connect parents and children, extract roots
	for (const node of map.values()) {
		const parts = node.fullTag.split('/').filter(Boolean);
		if (parts.length === 1) {
			roots.push(node);
		} else {
			const parentTag = parts.slice(0, parts.length - 1).join('/');
			const parentNode = map.get(parentTag.toLowerCase());
			if (parentNode) {
				parentNode.children.push(node);
				node.parent = parentNode;
			} else {
				roots.push(node);
			}
		}
	}

	// 4. Fill synthetic parents' counts from children if they had 0
	function fillSyntheticCounts(node: TagTreeNode) {
		for (const child of node.children) {
			fillSyntheticCounts(child);
		}
		if (node.totalCards === 0 && node.children.length > 0) {
			node.dueCards = node.children.reduce((acc, c) => acc + c.dueCards, 0);
			node.newCards = node.children.reduce((acc, c) => acc + c.newCards, 0);
			node.totalCards = node.children.reduce((acc, c) => acc + c.totalCards, 0);
		}
	}
	for (const root of roots) {
		fillSyntheticCounts(root);
	}

	return roots;
}

/**
 * Traverses the tree and returns flattened visible rows respecting collapsed branches.
 */
export function getVisibleTagRows(
	roots: TagTreeNode[],
	collapsedTags: Set<string>,
	sortColumn: 'tag' | 'due' | 'new' | 'total',
	sortAsc: boolean,
): TagTreeNode[] {
	const visible: TagTreeNode[] = [];

	function sortSiblings(list: TagTreeNode[]): TagTreeNode[] {
		return [...list].sort((a, b) => {
			let cmp = 0;
			if (sortColumn === 'tag') {
				cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
			} else if (sortColumn === 'due') {
				cmp = a.dueCards - b.dueCards;
			} else if (sortColumn === 'new') {
				cmp = a.newCards - b.newCards;
			} else if (sortColumn === 'total') {
				cmp = a.totalCards - b.totalCards;
			}
			return sortAsc ? cmp : -cmp;
		});
	}

	function traverse(nodes: TagTreeNode[]) {
		const sorted = sortSiblings(nodes);
		for (const node of sorted) {
			visible.push(node);
			const isCollapsed = collapsedTags.has(node.fullTag.toLowerCase());
			if (!isCollapsed && node.children.length > 0) {
				traverse(node.children);
			}
		}
	}

	traverse(roots);
	return visible;
}

/**
 * Returns all descendant tags (including the node itself) in lowercase.
 */
export function getAllDescendantTags(node: TagTreeNode): string[] {
	const tags: string[] = [node.fullTag.toLowerCase()];
	for (const child of node.children) {
		tags.push(...getAllDescendantTags(child));
	}
	return tags;
}

/**
 * Checks whether all descendants of a node are in selectedTags.
 */
export function isNodeFullySelected(node: TagTreeNode, selectedTags: Set<string>): boolean {
	const descendants = getAllDescendantTags(node);
	return descendants.every((tag) => selectedTags.has(tag));
}

/**
 * Checks whether some (but not all) descendants of a node are in selectedTags.
 */
export function isNodeIndeterminate(node: TagTreeNode, selectedTags: Set<string>): boolean {
	if (node.children.length === 0) return false;
	const descendants = getAllDescendantTags(node);
	const someSelected = descendants.some((tag) => selectedTags.has(tag));
	const allSelected = descendants.every((tag) => selectedTags.has(tag));
	return someSelected && !allSelected;
}

/**
 * Calculates total cards and due cards for selected tags without double counting
 * ancestors and descendants.
 */
export function getSelectedTagSummary(
	roots: TagTreeNode[],
	selectedTags: Set<string>,
): { due: number; newCards: number; total: number } {
	if (selectedTags.size === 0) {
		return { due: 0, newCards: 0, total: 0 };
	}

	let due = 0;
	let newCards = 0;
	let total = 0;

	function collect(nodes: TagTreeNode[]) {
		for (const node of nodes) {
			const tagKey = node.fullTag.toLowerCase();
			if (selectedTags.has(tagKey)) {
				if (isNodeFullySelected(node, selectedTags)) {
					due += node.dueCards;
					newCards += node.newCards;
					total += node.totalCards;
					// Fully selected branch: do not descend into children to prevent double-counting
					continue;
				} else {
					if (node.children.length > 0) {
						collect(node.children);
					} else {
						due += node.dueCards;
						newCards += node.newCards;
						total += node.totalCards;
					}
				}
			} else {
				if (node.children.length > 0) {
					collect(node.children);
				}
			}
		}
	}

	collect(roots);
	return { due, newCards, total };
}
