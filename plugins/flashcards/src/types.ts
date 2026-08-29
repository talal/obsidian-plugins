export type CardDirection = 'forward' | 'reverse' | null;
export type CardBlockType = 'inline' | 'block' | 'cloze';
export type ReviewState = 'new' | 'learning' | 'review' | 'relearning';
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/** 1. Canonical Markdown Source Block (1:1 with SQLite blocks table) */
export interface Block {
	id: string;
	file_path: string;
	block_type: CardBlockType;
	reversible: number; // 0 or 1
	front: string;
	back: string;
	tags: string; // Space-separated string (e.g. 'german vocab')
	updated_at: number; // UTC epoch ms
}

/** 2. Flashcard Review Entity (1:1 with SQLite cards table) */
export interface CardRecord {
	id: number;
	block_id: string;
	direction: 'forward' | 'reverse' | null;
	state: number; // 0=New, 1=Learning, 2=Review, 3=Relearning
	due_at: number; // UTC epoch ms
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	last_review: number | null;
	learning_step: number;
	relearning_step: number;
}

/** 3. Study Session Record (1:1 with SQLite sessions table) */
export interface SessionRecord {
	id?: number;
	started_at: number;
	ended_at: number | null;
	card_count: number;
	forgot_count: number;
	remembered_count: number;
}

/** 4. Immutable Review Log (1:1 with SQLite reviews table) */
export interface ReviewRecord {
	id?: number;
	session_id?: number;
	card_id: number;
	rating: number; // 1=Again, 2=Hard, 3=Good, 4=Easy
	state: number;
	due_at: number;
	stability: number;
	difficulty: number;
	reviewed_at: number; // UTC epoch ms
}

/** In-memory Card Performance update committed at end of session */
export interface CardPerformanceUpdate {
	id: number;
	state: number;
	due_at: number;
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	last_review: number | null;
	learning_step: number;
	relearning_step: number;
}

/** Svelte UI View Model (Joined cards JOIN blocks) */
export interface ReviewItem {
	cardId: number;
	blockId: string;
	noteTitle: string;
	notePath: string;
	direction: 'forward' | 'reverse' | null;
	blockType: CardBlockType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	state: ReviewState;
	stateNum: number;
	dueAt: number; // epoch ms
	dueHuman: string;
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	learningStep: number;
	relearningStep: number;
	lastReview: number | null;
	lastPracticedHuman: string;
}

export interface DashboardStats {
	studiedToday: number;
	dailyRetention: number;
	studyStreak: number;
	totalCards: number;
	dueToday: number;
	newCards: number;
}

export interface ParsedBlock {
	id: string;
	block_type: CardBlockType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	line_start: number;
	line_end: number;
}

export interface DocumentSyncResult {
	updated_content: string | null;
	blocks: ParsedBlock[];
}

/** Block ranges reported by Obsidian's MetadataCache. */
export interface ObsidianSectionHint {
	type: string;
	line_start: number;
	line_end: number;
}

export interface FsrsParams {
	request_retention?: number;
	maximum_interval?: number;
	w?: number[];
	enable_fuzz?: boolean;
	learning_steps?: number[];
	relearning_steps?: number[];
	due_counts?: number[];
	sibling_due_offset?: number;
}

export interface SchedulingCard {
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	learning_step: number;
	relearning_step: number;
	state: ReviewState;
	last_review: number | null;
	due: number;
}

export interface SchedulingCardCandidate {
	rating: ReviewRating;
	card: SchedulingCard;
	interval_days: number;
}

export interface SchedulingInfo {
	card: SchedulingCard;
	next_states: SchedulingCardCandidate[];
}

export interface ReviewLogEntry {
	card_id: string;
	rating: number;
	delta_t: number;
}

export interface FlashcardsPluginSettings {
	requestRetention?: number;
	maximumInterval?: number;
	learningSteps?: string;
	relearningSteps?: string;
	customWeights?: string;
	enableFuzz?: boolean;
	rolloverHour?: number;
	leechThreshold?: number;
	leechTag?: string;
}

export const DEFAULT_SETTINGS: FlashcardsPluginSettings = {};
