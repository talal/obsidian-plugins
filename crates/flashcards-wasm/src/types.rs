use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardBlockType {
    Inline,
    Block,
    Cloze,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedBlock {
    pub id: String,
    pub block_type: CardBlockType,
    pub reversible: bool,
    pub front: String,
    pub back: String,
    pub tags: Vec<String>,
    pub line_start: usize,
    pub line_end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentSyncResult {
    pub updated_content: Option<String>,
    pub blocks: Vec<ParsedBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rating {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

impl Serialize for State {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            State::New => serializer.serialize_str("new"),
            State::Learning => serializer.serialize_str("learning"),
            State::Review => serializer.serialize_str("review"),
            State::Relearning => serializer.serialize_str("relearning"),
        }
    }
}

impl<'de> Deserialize<'de> for State {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StateVisitor;

        impl<'de> serde::de::Visitor<'de> for StateVisitor {
            type Value = State;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str(
                    "a state integer (0..=3) or string ('new', 'learning', 'review', 'relearning')",
                )
            }

            fn visit_i64<E>(self, value: i64) -> Result<State, E>
            where
                E: serde::de::Error,
            {
                match value {
                    0 => Ok(State::New),
                    1 => Ok(State::Learning),
                    2 => Ok(State::Review),
                    3 => Ok(State::Relearning),
                    _ => Err(E::custom(format!("invalid state integer: {value}"))),
                }
            }

            fn visit_u64<E>(self, value: u64) -> Result<State, E>
            where
                E: serde::de::Error,
            {
                self.visit_i64(value as i64)
            }

            fn visit_str<E>(self, value: &str) -> Result<State, E>
            where
                E: serde::de::Error,
            {
                match value.to_ascii_lowercase().as_str() {
                    "new" | "0" => Ok(State::New),
                    "learning" | "1" => Ok(State::Learning),
                    "review" | "2" => Ok(State::Review),
                    "relearning" | "3" => Ok(State::Relearning),
                    _ => Err(E::custom(format!("invalid state string: {value}"))),
                }
            }
        }

        deserializer.deserialize_any(StateVisitor)
    }
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
