/**
 * Core data types for the Obsidian → Anki Sync plugin.
 */

export type NoteType =
	| 'inline-forward'
	| 'inline-bidirectional'
	| 'block-forward'
	| 'block-bidirectional';

export interface Note {
	/** Note UUID; null until first sync */
	id: string | null;
	type: NoteType;
	/** HTML for block cards, plain text for inline */
	front: string;
	/** HTML for block cards, plain text for inline */
	back: string;
	/** Resolved from frontmatter anki-deck */
	deck: string;
	/** Vault-relative path, for logging/orphan detection */
	sourceFile: string;
	/** Line of `%% card start %%` or the inline line (0-indexed) */
	lineStart: number;
	/** Line of `%% card end %%` or the inline line (0-indexed) */
	lineEnd: number;
	/** Hash of front+back, to skip no-op updates */
	contentHash: string;
}

export interface SyncResult {
	created: number;
	updated: number;
	skipped: number;
	orphaned: number;
	errors: string[];
}
