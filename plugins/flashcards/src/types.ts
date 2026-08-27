export type CardDirection = 'forward' | 'reverse' | 'both';
export type CardType = 'inline_forward' | 'inline_both' | 'block' | 'cloze';
export type ReviewState = 'new' | 'learning' | 'review' | 'relearning';
export type ReviewRating = 'forgot' | 'hard' | 'good' | 'easy';

export interface CardBlock {
	noteId: string;
	blockId: string;
	noteTitle: string;
	notePath: string;
	cardType: CardType;
	direction: CardDirection;
	frontRaw: string;
	backRaw: string;
	tags: string[];
	contentHash: string;
	createdAt: number;
	updatedAt: number;
}

export interface ReviewItem {
	id: string; // e.g. 'noteId:blockId:forward'
	noteId: string;
	blockId: string;
	noteTitle: string;
	notePath: string;
	direction: 'forward' | 'reverse';
	cardType: CardType;
	front: string;
	back: string;
	tags: string[];
	state: ReviewState;
	due: number; // epoch ms
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

export interface StudySession {
	sessionId: number;
	startedAt: number;
	endedAt: number | null;
	deckFilter: string;
	cardsStudied: number;
	forgotCount: number;
	rememberedCount: number;
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
	block_id: string;
	card_type: CardType;
	direction: CardDirection;
	front_raw: string;
	back_raw: string;
	tags: string[];
	content_hash: string;
	line_start: number;
	line_end: number;
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
	rating: 'again' | 'hard' | 'good' | 'easy';
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
}

export const DEFAULT_SETTINGS: FlashcardsPluginSettings = {};
