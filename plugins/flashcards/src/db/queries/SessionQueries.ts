import type { Database, Statement } from 'sql.js';

import type {
	CardPerformanceUpdate,
	DashboardStats,
	ReviewLogEntry,
	ReviewRecord,
	SessionRecord,
} from '../../types.js';
import {
	getStudyDayCutoff,
	getStudyDayKey,
	getStudyDayStart,
	shiftLocalDateKey,
} from '../../utils/studyDay.js';

export function commitSession(
	db: Database,
	session: SessionRecord,
	reviews: ReviewRecord[],
	cardUpdates: CardPerformanceUpdate[],
	existingSessionId?: number,
): number {
	db.run('BEGIN TRANSACTION');
	let sessionId = existingSessionId ?? 0;
	let insertReviewStmt: Statement | null = null;
	let updateCardStmt: Statement | null = null;

	try {
		if (sessionId > 0) {
			db.run(
				`UPDATE sessions
				 SET ended_at = ?, card_count = ?, forgot_count = ?, remembered_count = ?
				 WHERE id = ?`,
				[
					session.ended_at,
					session.card_count,
					session.forgot_count,
					session.remembered_count,
					sessionId,
				],
			);
			db.run('DELETE FROM reviews WHERE session_id = ?', [sessionId]);
		} else {
			db.run(
				`INSERT INTO sessions (started_at, ended_at, card_count, forgot_count, remembered_count)
				 VALUES (?, ?, ?, ?, ?)`,
				[
					session.started_at,
					session.ended_at,
					session.card_count,
					session.forgot_count,
					session.remembered_count,
				],
			);

			const idStmt = db.prepare('SELECT last_insert_rowid() as id');
			idStmt.step();
			sessionId = idStmt.getAsObject().id as number;
			idStmt.free();
		}

		if (reviews.length > 0) {
			insertReviewStmt = db.prepare(
				`INSERT INTO reviews (session_id, card_id, rating, state, due_at, stability, difficulty, reviewed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (let i = 0; i < reviews.length; i++) {
				const r = reviews[i]!;
				insertReviewStmt.run([
					sessionId,
					r.card_id,
					r.rating,
					r.state,
					r.due_at,
					r.stability,
					r.difficulty,
					r.reviewed_at,
				]);
			}
		}

		if (cardUpdates.length > 0) {
			updateCardStmt = db.prepare(
				`UPDATE cards
				 SET state = ?, due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?,
				     last_review = ?, learning_step = ?, relearning_step = ?
				 WHERE id = ?`,
			);
			for (let i = 0; i < cardUpdates.length; i++) {
				const c = cardUpdates[i]!;
				updateCardStmt.run([
					c.state,
					c.due_at,
					c.stability,
					c.difficulty,
					c.reps,
					c.lapses,
					c.last_review,
					c.learning_step,
					c.relearning_step,
					c.id,
				]);
			}
		}

		db.run('COMMIT');
	} catch (error) {
		db.run('ROLLBACK');
		throw error;
	} finally {
		insertReviewStmt?.free();
		updateCardStmt?.free();
	}

	return sessionId;
}

export function getReviewLogsForOptimization(db: Database): ReviewLogEntry[] {
	const stmt = db.prepare(`
		SELECT card_id, rating, reviewed_at,
		       COALESCE(
		           LAG(reviewed_at) OVER (PARTITION BY card_id ORDER BY reviewed_at ASC, id ASC),
		           reviewed_at
		       ) as prev_time
		FROM reviews
		ORDER BY reviewed_at ASC, id ASC
	`);
	const logs: ReviewLogEntry[] = [];
	while (stmt.step()) {
		const row = stmt.getAsObject();
		const rating = row.rating as number;
		const reviewTime = row.reviewed_at as number;
		const prevTime = row.prev_time as number;
		const deltaMs = Math.max(0, reviewTime - prevTime);
		const deltaT = deltaMs / (1000 * 60 * 60 * 24);
		logs.push({
			card_id: String(row.card_id),
			rating,
			delta_t: deltaT,
		});
	}
	stmt.free();
	return logs;
}

export function getDashboardStats(db: Database, rolloverHour = 4): DashboardStats {
	const startOfDayMs = getStudyDayStart(rolloverHour);
	const endOfDayMs = getStudyDayCutoff(rolloverHour);

	const logStmt = db.prepare(`
		SELECT COUNT(*) as count,
		       SUM(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) as remembered
		FROM reviews
		WHERE reviewed_at >= ? AND reviewed_at < ?
	`);
	logStmt.bind([startOfDayMs, endOfDayMs]);
	let studiedToday = 0;
	let rememberedToday = 0;
	if (logStmt.step()) {
		const row = logStmt.getAsObject();
		studiedToday = (row.count as number) || 0;
		rememberedToday = (row.remembered as number) || 0;
	}
	logStmt.free();

	const dailyRetention =
		studiedToday > 0 ? Math.round((rememberedToday / studiedToday) * 100) : 100;

	const streakStmt = db.prepare('SELECT reviewed_at FROM reviews ORDER BY reviewed_at DESC');
	const days = new Set<string>();
	const currentDay = getStudyDayKey(Date.now(), rolloverHour);
	const yesterday = shiftLocalDateKey(currentDay, -1);
	let expectedDay: string | null = null;
	let studyStreak = 0;

	while (streakStmt.step()) {
		const dayKey = getStudyDayKey(streakStmt.getAsObject().reviewed_at as number, rolloverHour);
		days.add(dayKey);

		if (expectedDay === null) {
			if (days.has(currentDay)) {
				expectedDay = currentDay;
			} else if (days.has(yesterday)) {
				expectedDay = yesterday;
			} else if (dayKey < yesterday) {
				break;
			}
		}

		if (expectedDay !== null) {
			while (days.has(expectedDay)) {
				studyStreak++;
				expectedDay = shiftLocalDateKey(expectedDay, -1);
			}
			if (dayKey < expectedDay) {
				break;
			}
		}
	}
	streakStmt.free();

	let totalCards = 0;
	let dueToday = 0;
	let newCards = 0;

	const cardStmt = db.prepare(`
		SELECT COUNT(*) as total_cards,
		       SUM(CASE WHEN c.state = 0 THEN 1 ELSE 0 END) as new_cards,
		       SUM(CASE WHEN c.due_at <= ? THEN 1 ELSE 0 END) as due_today
		FROM cards c
		JOIN blocks b ON c.block_id = b.id
	`);
	cardStmt.bind([endOfDayMs]);
	if (cardStmt.step()) {
		const row = cardStmt.getAsObject();
		totalCards = (row.total_cards as number) || 0;
		newCards = (row.new_cards as number) || 0;
		dueToday = (row.due_today as number) || 0;
	}
	cardStmt.free();

	return {
		studiedToday,
		dailyRetention,
		studyStreak,
		totalCards,
		dueToday,
		newCards,
	};
}
