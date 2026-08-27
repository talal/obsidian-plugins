export function generateBlockId(): string {
	return Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export interface ResolveNoteIdParams {
	noteId?: string | null;
	filePath: string;
	conflictingPathInDb?: string | null;
	conflictingPathInVault?: string | null;
	oldFileExistsOnDisk?: boolean;
}

export interface ResolveNoteIdResult {
	noteId?: string;
	idCollisionFixed: boolean;
}

export function resolveNoteIdCollision(params: ResolveNoteIdParams): ResolveNoteIdResult {
	let noteId = params.noteId ?? undefined;
	let idCollisionFixed = false;

	if (noteId) {
		if (params.conflictingPathInVault && params.conflictingPathInVault !== params.filePath) {
			// Another file in the vault already claimed this noteId in this scan session
			noteId = undefined;
			idCollisionFixed = true;
		} else if (params.conflictingPathInDb && params.conflictingPathInDb !== params.filePath) {
			// If DB had a different path, check if the old file still exists on disk
			if (params.oldFileExistsOnDisk) {
				// Both files exist on disk with the same noteId -> Collision!
				noteId = undefined;
				idCollisionFixed = true;
			}
			// Otherwise, the old file was renamed/moved to filePath: retain noteId and history!
		}
	}

	return { noteId, idCollisionFixed };
}

export function deduplicateBlockIds<T extends { block_id: string }>(
	blocks: T[],
): { duplicateBlocksFixed: number } {
	let duplicateBlocksFixed = 0;
	const seenBlockIds = new Set<string>();

	for (const b of blocks) {
		if (b.block_id) {
			if (seenBlockIds.has(b.block_id)) {
				b.block_id = '';
				duplicateBlocksFixed++;
			} else {
				seenBlockIds.add(b.block_id);
			}
		}
	}

	return { duplicateBlocksFixed };
}

export function stampBlockId(lineContent: string, cardType: string, newId: string): string {
	if (cardType === 'block') {
		if (/card-start(?:\s+id=\S+)?/i.test(lineContent)) {
			return lineContent.replace(/card-start(?:\s+id=\S+)?/i, `card-start id=${newId}`);
		}
		return lineContent.replace('card-start', `card-start id=${newId}`);
	}
	if (/\s*\^[^\s]+$/i.test(lineContent.trimEnd())) {
		return lineContent.trimEnd().replace(/\s*\^[^\s]+$/i, ` ^${newId}`);
	}
	return `${lineContent.trimEnd()} ^${newId}`;
}
