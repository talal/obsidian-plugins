export type CardDirection = 'forward' | 'reverse' | null;
export type CardType = 'inline' | 'qa' | 'multiline' | 'cloze';
export type ReviewState = 'new' | 'learning' | 'review' | 'relearning';
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/** 1. Markdown Source Prompt */
export interface Prompt {
	id: string;
	file_path: string;
	card_type: CardType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	line_start: number;
	line_end: number;
	updated_at: number;
}

/** 2. Flashcard Review Entity (FSRS item) */
export interface Card {
	id: number;
	prompt_id: string;
	direction: CardDirection;
	state: ReviewState;
	due_at: number;
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	last_review: number | null;
	learning_step: number;
	relearning_step: number;
}

/** 3. Svelte UI View Model (joined Card + Prompt) */
export interface ReviewItem {
	card_id: number;
	prompt_id: string;
	note_title: string;
	note_path: string;
	direction: CardDirection;
	card_type: CardType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	state: ReviewState;
	state_num: number;
	due_at: number;
	due_human: string;
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	learning_step: number;
	relearning_step: number;
	last_review: number | null;
	last_practiced_human: string;
}

/** 4. Dashboard Statistics */
export interface DashboardStats {
	studied_today: number;
	daily_retention: number;
	study_streak: number;
	total_cards: number;
	due_today: number;
	new_cards: number;
}

/** 5. Tag Deck Statistics for TagPickerModal */
export interface TagDeckStats {
	tag: string;
	total_cards: number;
	due_cards: number;
	new_cards: number;
}

export interface ScanResult {
	filesScanned: number;
	filesSkipped: number;
	totalPrompts: number;
	failedFiles: string[];
}

export interface SyncNoteResult {
	updated_content: string | null;
	prompt_count: number;
}

export interface ParsedPrompt {
	id: string;
	card_type: CardType;
	reversible: boolean;
	front: string;
	back: string;
	tags: string[];
	line_start: number;
	line_end: number;
}

export interface DocumentSyncResult {
	updated_content: string | null;
	prompts: ParsedPrompt[];
}

/** Block ranges reported by Obsidian's MetadataCache. */
export interface ObsidianSectionHint {
	type: string;
	line_start: number;
	line_end: number;
}

export const DEFAULT_REQUEST_RETENTION = 0.9;
export const DEFAULT_MAXIMUM_INTERVAL = 36500;
export const DEFAULT_ROLLOVER_HOUR = 4;
export const DEFAULT_LEECH_THRESHOLD = 4;
export const DEFAULT_LEECH_TAG = '#card/leech';

export interface FsrsParams {
	request_retention: number;
	maximum_interval: number;
	learning_steps: number[];
	relearning_steps: number[];
	weights?: number[];
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
	rolloverHour?: number;
	leechThreshold?: number;
}

export const DEFAULT_SETTINGS: FlashcardsPluginSettings = {};
