import type { Database, Statement } from 'sql.js';

import type { Block, CardBlockType, FileSyncState, ParsedBlock } from '../../types.js';

export function upsertBlock(db: Database, block: Block): void {
	db.run(
		`INSERT INTO blocks (id, file_path, block_type, reversible, front, back, tags, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   file_path = excluded.file_path,
		   block_type = excluded.block_type,
		   reversible = excluded.reversible,
		   front = excluded.front,
		   back = excluded.back,
		   tags = excluded.tags,
		   updated_at = excluded.updated_at`,
		[
			block.id,
			block.file_path,
			block.block_type,
			block.reversible,
			block.front,
			block.back,
			block.tags,
			block.updated_at,
		],
	);
}

export function reconcileCards(db: Database, block: Block): void {
	const now = Date.now();

	if (block.block_type === 'cloze') {
		db.run('DELETE FROM cards WHERE block_id = ? AND direction IS NOT NULL', [block.id]);
		db.run(
			`INSERT OR IGNORE INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
			 VALUES (?, NULL, 0, ?, 0.0, 0.0, 0, 0, NULL, 0, 0)`,
			[block.id, now],
		);
	} else {
		const neededDirs: ('forward' | 'reverse')[] =
			block.reversible === 1 ? ['forward', 'reverse'] : ['forward'];

		const placeholders = neededDirs.map(() => '?').join(',');
		db.run(
			`DELETE FROM cards WHERE block_id = ? AND (direction IS NULL OR direction NOT IN (${placeholders}))`,
			[block.id, ...neededDirs],
		);

		for (const dir of neededDirs) {
			db.run(
				`INSERT OR IGNORE INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
				 VALUES (?, ?, 0, ?, 0.0, 0.0, 0, 0, NULL, 0, 0)`,
				[block.id, dir, now],
			);
		}
	}
}

export function syncNoteBlocks(db: Database, filePath: string, parsedBlocks: ParsedBlock[]): void {
	const now = Date.now();
	const incomingIds = new Set<string>();
	for (let i = 0; i < parsedBlocks.length; i++) {
		incomingIds.add(parsedBlocks[i]!.id);
	}

	db.run('BEGIN TRANSACTION');

	let selectOldBlocksStmt: Statement | null = null;
	let deleteBlockStmt: Statement | null = null;
	let upsertBlockStmt: Statement | null = null;
	let insertCardStmt: Statement | null = null;
	let deleteNonClozeCardsStmt: Statement | null = null;
	let deleteNonForwardCardsStmt: Statement | null = null;
	let deleteNullDirectionCardsStmt: Statement | null = null;

	try {
		selectOldBlocksStmt = db.prepare('SELECT id FROM blocks WHERE file_path = ?');
		deleteBlockStmt = db.prepare('DELETE FROM blocks WHERE id = ?');
		upsertBlockStmt = db.prepare(
			`INSERT INTO blocks (id, file_path, block_type, reversible, front, back, tags, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   file_path = excluded.file_path,
			   block_type = excluded.block_type,
			   reversible = excluded.reversible,
			   front = excluded.front,
			   back = excluded.back,
			   tags = excluded.tags,
			   updated_at = excluded.updated_at`,
		);
		insertCardStmt = db.prepare(
			`INSERT OR IGNORE INTO cards (block_id, direction, state, due_at, stability, difficulty, reps, lapses, last_review, learning_step, relearning_step)
			 VALUES (?, ?, 0, ?, 0.0, 0.0, 0, 0, NULL, 0, 0)`,
		);
		deleteNonClozeCardsStmt = db.prepare(
			'DELETE FROM cards WHERE block_id = ? AND direction IS NOT NULL',
		);
		deleteNonForwardCardsStmt = db.prepare(
			"DELETE FROM cards WHERE block_id = ? AND (direction IS NULL OR direction != 'forward')",
		);
		deleteNullDirectionCardsStmt = db.prepare(
			'DELETE FROM cards WHERE block_id = ? AND direction IS NULL',
		);

		// 1. Process obsolete blocks
		selectOldBlocksStmt.bind([filePath]);
		while (selectOldBlocksStmt.step()) {
			const oldId = selectOldBlocksStmt.getAsObject().id as string;
			if (!incomingIds.has(oldId)) {
				deleteBlockStmt.run([oldId]);
			}
		}

		// 2. Process incoming blocks & card changes
		for (let i = 0; i < parsedBlocks.length; i++) {
			const b = parsedBlocks[i]!;
			const tagsStr = b.tags.length > 0 ? b.tags.join(' ') : '';
			const reversibleInt = b.reversible ? 1 : 0;

			// Upsert block
			upsertBlockStmt.run([
				b.id,
				filePath,
				b.block_type,
				reversibleInt,
				b.front,
				b.back,
				tagsStr,
				now,
			]);

			// Reconcile cards for block
			if (b.block_type === 'cloze') {
				deleteNonClozeCardsStmt.run([b.id]);
				insertCardStmt.run([b.id, null, now]);
			} else if (b.reversible) {
				deleteNullDirectionCardsStmt.run([b.id]);
				insertCardStmt.run([b.id, 'forward', now]);
				insertCardStmt.run([b.id, 'reverse', now]);
			} else {
				deleteNonForwardCardsStmt.run([b.id]);
				insertCardStmt.run([b.id, 'forward', now]);
			}
		}

		db.run('COMMIT');
	} catch (error) {
		db.run('ROLLBACK');
		throw error;
	} finally {
		selectOldBlocksStmt?.free();
		deleteBlockStmt?.free();
		upsertBlockStmt?.free();
		insertCardStmt?.free();
		deleteNonClozeCardsStmt?.free();
		deleteNonForwardCardsStmt?.free();
		deleteNullDirectionCardsStmt?.free();
	}
}

export function pruneDeletedNotes(db: Database, validFilePaths: Set<string>): number {
	let prunedCount = 0;
	const stmt = db.prepare('SELECT DISTINCT file_path FROM blocks');
	const toDelete: string[] = [];
	while (stmt.step()) {
		const path = stmt.getAsObject().file_path as string;
		if (!validFilePaths.has(path)) {
			toDelete.push(path);
		}
	}
	stmt.free();

	const stmtFiles = db.prepare('SELECT file_path FROM file_sync_state');
	const toDeleteFiles: string[] = [];
	while (stmtFiles.step()) {
		const path = stmtFiles.getAsObject().file_path as string;
		if (!validFilePaths.has(path)) {
			toDeleteFiles.push(path);
		}
	}
	stmtFiles.free();

	if (toDelete.length === 0 && toDeleteFiles.length === 0) {
		return 0;
	}

	db.run('BEGIN TRANSACTION');
	let deleteBlocksStmt: Statement | null = null;
	let deleteFilesStmt: Statement | null = null;
	try {
		deleteBlocksStmt = db.prepare('DELETE FROM blocks WHERE file_path = ?');
		deleteFilesStmt = db.prepare('DELETE FROM file_sync_state WHERE file_path = ?');
		for (const path of toDelete) {
			deleteBlocksStmt.run([path]);
			prunedCount++;
		}
		for (const path of toDeleteFiles) {
			deleteFilesStmt.run([path]);
		}
		db.run('COMMIT');
	} catch (error) {
		db.run('ROLLBACK');
		throw error;
	} finally {
		deleteBlocksStmt?.free();
		deleteFilesStmt?.free();
	}

	return prunedCount;
}

export function renameNote(db: Database, oldPath: string, newPath: string): void {
	db.run('UPDATE blocks SET file_path = ? WHERE file_path = ?', [newPath, oldPath]);
	db.run('UPDATE file_sync_state SET file_path = ? WHERE file_path = ?', [newPath, oldPath]);
}

export function getFileSyncState(db: Database, filePath: string): FileSyncState | null {
	const stmt = db.prepare(
		'SELECT file_path, modified_at, size, content_hash, updated_at FROM file_sync_state WHERE file_path = ?',
	);
	stmt.bind([filePath]);
	let state: FileSyncState | null = null;
	if (stmt.step()) {
		const row = stmt.getAsObject();
		state = {
			file_path: row.file_path as string,
			modified_at: row.modified_at as number,
			size: row.size as number,
			content_hash: (row.content_hash as string) || null,
			updated_at: row.updated_at as number,
		};
	}
	stmt.free();
	return state;
}

export function getAllFileSyncStates(db: Database): Map<string, FileSyncState> {
	const map = new Map<string, FileSyncState>();
	const stmt = db.prepare(
		'SELECT file_path, modified_at, size, content_hash, updated_at FROM file_sync_state',
	);
	while (stmt.step()) {
		const row = stmt.getAsObject();
		const filePath = row.file_path as string;
		map.set(filePath, {
			file_path: filePath,
			modified_at: row.modified_at as number,
			size: row.size as number,
			content_hash: (row.content_hash as string) || null,
			updated_at: row.updated_at as number,
		});
	}
	stmt.free();
	return map;
}

export function upsertFileSyncState(db: Database, state: FileSyncState): void {
	db.run(
		`INSERT INTO file_sync_state (file_path, modified_at, size, content_hash, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(file_path) DO UPDATE SET
		   modified_at = excluded.modified_at,
		   size = excluded.size,
		   content_hash = excluded.content_hash,
		   updated_at = excluded.updated_at`,
		[state.file_path, state.modified_at, state.size, state.content_hash, state.updated_at],
	);
}

export function deleteFileSyncState(db: Database, filePath: string): void {
	db.run('DELETE FROM file_sync_state WHERE file_path = ?', [filePath]);
}

export function getFileToBlockIdsMap(db: Database): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const stmt = db.prepare('SELECT file_path, id FROM blocks');
	while (stmt.step()) {
		const row = stmt.getAsObject();
		const filePath = row.file_path as string;
		const id = row.id as string;
		let ids = map.get(filePath);
		if (!ids) {
			ids = [];
			map.set(filePath, ids);
		}
		ids.push(id);
	}
	stmt.free();
	return map;
}

export function getFileToBlocksMap(db: Database): Map<string, ParsedBlock[]> {
	const map = new Map<string, ParsedBlock[]>();
	const stmt = db.prepare(
		'SELECT file_path, id, block_type, reversible, front, back, tags FROM blocks',
	);
	while (stmt.step()) {
		const row = stmt.getAsObject();
		const filePath = row.file_path as string;
		const block: ParsedBlock = {
			id: row.id as string,
			block_type: row.block_type as CardBlockType,
			reversible: (row.reversible as number) === 1,
			front: row.front as string,
			back: row.back as string,
			tags: row.tags ? (row.tags as string).split(' ').filter(Boolean) : [],
			line_start: 0,
			line_end: 0,
		};
		let blocks = map.get(filePath);
		if (!blocks) {
			blocks = [];
			map.set(filePath, blocks);
		}
		blocks.push(block);
	}
	stmt.free();
	return map;
}

export function getBlocksForFile(db: Database, filePath: string): ParsedBlock[] {
	const blocks: ParsedBlock[] = [];
	const stmt = db.prepare(
		'SELECT id, block_type, reversible, front, back, tags FROM blocks WHERE file_path = ?',
	);
	stmt.bind([filePath]);
	while (stmt.step()) {
		const row = stmt.getAsObject();
		blocks.push({
			id: row.id as string,
			block_type: row.block_type as CardBlockType,
			reversible: (row.reversible as number) === 1,
			front: row.front as string,
			back: row.back as string,
			tags: row.tags ? (row.tags as string).split(' ').filter(Boolean) : [],
			line_start: 0,
			line_end: 0,
		});
	}
	stmt.free();
	return blocks;
}

export function getAllBlockIds(db: Database): Set<string> {
	const ids = new Set<string>();
	const stmt = db.prepare('SELECT id FROM blocks');
	while (stmt.step()) {
		ids.add(stmt.getAsObject().id as string);
	}
	stmt.free();
	return ids;
}

export function getBlockFileOwnershipMap(db: Database): Map<string, string> {
	const map = new Map<string, string>();
	const stmt = db.prepare('SELECT id, file_path FROM blocks');
	while (stmt.step()) {
		const row = stmt.getAsObject();
		map.set(row.id as string, row.file_path as string);
	}
	stmt.free();
	return map;
}

export function getBlockIdsExcludingFile(db: Database, filePath: string): Set<string> {
	const ids = new Set<string>();
	const stmt = db.prepare('SELECT id FROM blocks WHERE file_path != ?');
	stmt.bind([filePath]);
	while (stmt.step()) {
		ids.add(stmt.getAsObject().id as string);
	}
	stmt.free();
	return ids;
}

export function optimizeDatabase(
	db: Database,
	validFilePaths?: Set<string>,
): { prunedBlocks: number; integrityOk: boolean } {
	db.run('PRAGMA foreign_keys = ON;');

	let prunedBlocks = 0;
	if (validFilePaths) {
		const stmt = db.prepare('SELECT id, file_path FROM blocks');
		const toDelete: string[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			if (!validFilePaths.has(row.file_path as string)) {
				toDelete.push(row.id as string);
			}
		}
		stmt.free();

		for (const id of toDelete) {
			db.run('DELETE FROM blocks WHERE id = ?', [id]);
			prunedBlocks++;
		}
	}

	db.run('DELETE FROM cards WHERE block_id NOT IN (SELECT id FROM blocks);');
	db.run('DELETE FROM reviews WHERE card_id NOT IN (SELECT id FROM cards);');

	let integrityOk = true;
	const checkStmt = db.prepare('PRAGMA integrity_check;');
	if (checkStmt.step()) {
		const res = checkStmt.getAsObject();
		const val = Object.values(res)[0];
		if (val !== 'ok') {
			integrityOk = false;
		}
	}
	checkStmt.free();

	db.run('VACUUM;');
	db.run('PRAGMA optimize;');

	return {
		prunedBlocks,
		integrityOk,
	};
}
