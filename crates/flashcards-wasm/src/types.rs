use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardType {
    Inline,
    Qa,
    Multiline,
    Cloze,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Forward,
    Reverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

impl State {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => State::Learning,
            2 => State::Review,
            3 => State::Relearning,
            _ => State::New,
        }
    }
}

/// 1. Markdown Source Prompt extracted from markdown note
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prompt {
    pub id: String, // 6-char lowercase base-36
    pub file_path: String,
    pub card_type: CardType,
    pub reversible: bool,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    pub line_start: usize,
    pub line_end: usize,
    pub updated_at: i64,
}

/// 2. Flashcard Review Entity (FSRS item)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Card {
    pub id: u32,
    pub prompt_id: String,
    pub direction: Option<Direction>,
    pub state: State,
    pub due_at: i64,
    pub stability: f64,
    pub difficulty: f64,
    pub reps: u32,
    pub lapses: u32,
    pub last_review: Option<i64>,
    pub learning_step: u32,
    pub relearning_step: u32,
}

/// 3. Historical Review Log
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewLog {
    pub id: u32,
    pub card_id: u32,
    pub rating: Rating,
    pub review_time: i64,
    pub elapsed_days: f64,
    pub scheduled_days: f64,
    pub state: State,
    pub due_at: i64,
    pub stability: f64,
    pub difficulty: f64,
    pub learning_step: u32,
    pub relearning_step: u32,
}

/// 4. File Sync State for rapid change detection
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileSyncState {
    pub file_path: String,
    pub modified_at: i64,
    pub size: u64,
    pub prompt_ids: Vec<String>,
}

/// 5. Root In-Memory Store persisted to cards.bin via Postcard
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FlashcardsStore {
    pub prompts: HashMap<String, Prompt>,
    pub cards: HashMap<u32, Card>,
    pub reviews: Vec<ReviewLog>,
    pub file_sync: HashMap<String, FileSyncState>,
    pub next_card_id: u32,
    pub next_review_id: u32,
}

/// Parsed prompt structure emitted by markdown parser
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedPrompt {
    pub id: String,
    pub card_type: CardType,
    pub reversible: bool,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    pub line_start: usize,
    pub line_end: usize,
}

/// Document sync outcome from note parsing
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentSyncResult {
    pub updated_content: Option<String>,
    pub prompts: Vec<ParsedPrompt>,
}

/// Svelte UI view model (joined Card + Prompt)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewItem {
    pub card_id: u32,
    pub prompt_id: String,
    pub note_title: String,
    pub note_path: String,
    pub direction: Option<Direction>,
    pub card_type: CardType,
    pub reversible: bool,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    pub state: State,
    pub state_num: u8,
    pub due_at: i64,
    pub due_human: String,
    pub stability: f64,
    pub difficulty: f64,
    pub reps: u32,
    pub lapses: u32,
    pub learning_step: u32,
    pub relearning_step: u32,
    pub last_review: Option<i64>,
    pub last_practiced_human: String,
}

/// High-level dashboard statistics
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DashboardStats {
    pub studied_today: u32,
    pub daily_retention: u32,
    pub study_streak: u32,
    pub total_cards: u32,
    pub due_today: u32,
    pub new_cards: u32,
}

/// Tag deck statistics for deck picker modal
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagDeckStats {
    pub tag: String,
    pub total_cards: u32,
    pub due_cards: u32,
    pub new_cards: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsrsParams {
    pub request_retention: f64,
    pub maximum_interval: f64,
    pub learning_steps: Vec<i64>,   // Milliseconds
    pub relearning_steps: Vec<i64>, // Milliseconds
    #[serde(default)]
    pub weights: Option<Vec<f64>>,
    #[serde(default)]
    pub due_counts: Option<Vec<u32>>,
    #[serde(default)]
    pub sibling_due_offset: Option<u32>,
}

impl Default for FsrsParams {
    fn default() -> Self {
        Self {
            request_retention: 0.90,
            maximum_interval: 36500.0,
            learning_steps: vec![10 * 60 * 1000],
            relearning_steps: vec![10 * 60 * 1000],
            weights: None,
            due_counts: None,
            sibling_due_offset: None,
        }
    }
}

impl FsrsParams {
    pub fn retention(&self) -> f64 {
        if self.request_retention.is_finite() && self.request_retention > 0.0 {
            self.request_retention.clamp(0.70, 0.99)
        } else {
            0.90
        }
    }

    pub fn max_interval(&self) -> f64 {
        if self.maximum_interval.is_finite() && self.maximum_interval >= 1.0 {
            self.maximum_interval.clamp(1.0, 36500.0)
        } else {
            36500.0
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingCard {
    pub stability: f64,
    pub difficulty: f64,
    pub reps: u32,
    pub lapses: u32,
    #[serde(default)]
    pub learning_step: u32,
    #[serde(default)]
    pub relearning_step: u32,
    pub state: State,
    pub last_review: Option<i64>, // Epoch ms
    #[serde(alias = "due_at")]
    pub due: i64, // Epoch ms
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingInfo {
    pub card: SchedulingCard,
    pub next_states: Vec<SchedulingCardCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingCardCandidate {
    pub rating: Rating,
    pub card: SchedulingCard,
    pub interval_days: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewLogEntry {
    #[serde(default)]
    pub card_id: String,
    pub rating: u8,
    pub delta_t: f64, // Days elapsed since last review
}
