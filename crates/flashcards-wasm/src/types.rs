use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardType {
    InlineForward,
    InlineBoth,
    Block,
    Cloze,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardDirection {
    Forward,
    Reverse,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedBlock {
    pub block_id: String,
    pub card_type: CardType,
    pub direction: CardDirection,
    pub front_raw: String,
    pub back_raw: String,
    pub tags: Vec<String>,
    pub content_hash: String,
    pub line_start: usize,
    pub line_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FsrsParams {
    #[serde(default)]
    pub request_retention: Option<f64>,
    #[serde(default)]
    pub maximum_interval: Option<f64>,
    #[serde(default)]
    pub w: Option<Vec<f64>>,
    #[serde(default)]
    pub enable_fuzz: Option<bool>,
    #[serde(default)]
    pub learning_steps: Option<Vec<i64>>, // Milliseconds
    #[serde(default)]
    pub relearning_steps: Option<Vec<i64>>, // Milliseconds
}

impl FsrsParams {
    pub fn retention(&self) -> f64 {
        self.request_retention.unwrap_or(0.90)
    }

    pub fn max_interval(&self) -> f64 {
        self.maximum_interval.unwrap_or(36500.0)
    }

    pub fn is_fuzz_enabled(&self) -> bool {
        self.enable_fuzz.unwrap_or(true)
    }

    pub fn learning_steps(&self) -> Vec<i64> {
        valid_steps(
            self.learning_steps.as_deref(),
            &[10 * 60 * 1000, 24 * 60 * 60 * 1000],
        )
    }

    pub fn relearning_steps(&self) -> Vec<i64> {
        valid_steps(self.relearning_steps.as_deref(), &[10 * 60 * 1000])
    }
}

fn valid_steps(steps: Option<&[i64]>, defaults: &[i64]) -> Vec<i64> {
    let valid: Vec<i64> = steps
        .unwrap_or_default()
        .iter()
        .copied()
        .filter(|step| *step > 0)
        .collect();
    if valid.is_empty() {
        defaults.to_vec()
    } else {
        valid
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
    pub due: i64,                 // Epoch ms
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
