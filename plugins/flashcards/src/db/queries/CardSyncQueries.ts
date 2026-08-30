import type { Database } from 'sql.js';

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
	const incomingIds = new Set(parsedBlocks.map((b) => b.id));

	db.run('BEGIN TRANSACTION');
	try {
		const stmt = db.prepare('SELECT id FROM blocks WHERE file_path = ?');
		stmt.bind([filePath]);
		const toDelete: string[] = [];
		while (stmt.step()) {
			const id = stmt.getAsObject().id as string;
			if (!incomingIds.has(id)) {
				toDelete.push(id);
			}
		}
		stmt.free();

		for (const oldId of toDelete) {
			db.run('DELETE FROM blocks WHERE id = ?', [oldId]);
		}

		for (const b of parsedBlocks) {
			const blockRecord: Block = {
				id: b.id,
				file_path: filePath,
				block_type: b.block_type as CardBlockType,
				reversible: b.reversible ? 1 : 0,
				front: b.front,
				back: b.back,
				tags: b.tags.join(' '),
				updated_at: now,
			};
			upsertBlock(db, blockRecord);
			reconcileCards(db, blockRecord);
		}

		db.run('COMMIT');
	} catch (error) {
		db.run('ROLLBACK');
		throw error;
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

	for (const path of toDelete) {
		db.run('DELETE FROM blocks WHERE file_path = ?', [path]);
		prunedCount++;
	}

	const stmtFiles = db.prepare('SELECT file_path FROM file_sync_state');
	const toDeleteFiles: string[] = [];
	while (stmtFiles.step()) {
		const path = stmtFiles.getAsObject().file_path as string;
		if (!validFilePaths.has(path)) {
			toDeleteFiles.push(path);
		}
	}
	stmtFiles.free();

	for (const path of toDeleteFiles) {
		db.run('DELETE FROM file_sync_state WHERE file_path = ?', [path]);
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
