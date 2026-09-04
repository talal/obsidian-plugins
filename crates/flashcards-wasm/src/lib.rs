pub mod fsrs;
pub mod optimizer;
pub mod parser;
pub mod store;
pub mod types;

use fsrs::FsrsEngine;
use optimizer::optimize_weights;
use parser::{ObsidianSectionHint, parse_markdown_prompts};
use types::{FsrsParams, ReviewLogEntry, SchedulingCard};
use wasm_bindgen::prelude::*;

pub type Fallible<T> = Result<T, JsValue>;

#[inline]
pub fn fail(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}

#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
#[derive(Default)]
pub struct CollisionRegistry {
    inner: parser::syntax::CollisionRegistry,
}

#[wasm_bindgen]
impl CollisionRegistry {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: parser::syntax::CollisionRegistry::new(),
        }
    }

    /// Construct a collision registry pre-populated with IDs from a JSON string array.
    pub fn from_json(existing_ids_json: &str) -> Fallible<CollisionRegistry> {
        let existing_ids: Vec<String> = if existing_ids_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(existing_ids_json).map_err(fail)?
        };
        let mut reg = parser::syntax::CollisionRegistry::with_capacity(existing_ids.len());
        for s in existing_ids {
            if let Some(id) = parser::syntax::decode_block_id(&s) {
                reg.insert(id);
            }
        }
        Ok(CollisionRegistry { inner: reg })
    }

    /// Add an ID to the registry. Returns true if newly inserted, false if already owned.
    pub fn insert(&mut self, id: &str) -> bool {
        if let Some(decoded) = parser::syntax::decode_block_id(id) {
            self.inner.insert(decoded)
        } else {
            false
        }
    }

    /// Check if an ID is present in the registry.
    pub fn contains(&self, id: &str) -> bool {
        if let Some(decoded) = parser::syntax::decode_block_id(id) {
            self.inner.contains(decoded)
        } else {
            false
        }
    }

    /// Allocate and reserve a fresh unique 6-character lowercase base-36 block ID.
    pub fn allocate_id(&mut self) -> String {
        parser::syntax::encode_block_id(self.inner.allocate_unique())
    }

    /// Number of registered IDs.
    pub fn size(&self) -> usize {
        self.inner.len()
    }
}

/// Standalone Markdown document parser without engine state.
#[wasm_bindgen]
pub fn parse_prompts(
    markdown: &str,
    note_tags_json: &str,
    section_hints_json: &str,
) -> Fallible<String> {
    let note_tags: Vec<String> = if note_tags_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(note_tags_json).map_err(fail)?
    };

    let section_hints: Vec<ObsidianSectionHint> = if section_hints_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(section_hints_json).map_err(fail)?
    };

    let prompts = parse_markdown_prompts(markdown, &note_tags, &section_hints);
    serde_json::to_string(&prompts).map_err(fail)
}

/// Standalone document sync with collision registry.
#[wasm_bindgen]
pub fn sync_document_with_registry(
    markdown: &str,
    registry: &mut CollisionRegistry,
    note_tags_json: &str,
    section_hints_json: &str,
) -> Fallible<String> {
    let note_tags: Vec<String> = if note_tags_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(note_tags_json).map_err(fail)?
    };

    let section_hints: Vec<ObsidianSectionHint> = if section_hints_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(section_hints_json).map_err(fail)?
    };

    let result =
        parser::sync_document_with_reg(markdown, &mut registry.inner, &note_tags, &section_hints);
    serde_json::to_string(&result).map_err(fail)
}

/// Pure-Rust in-memory flashcards store and query engine compiled to WASM.
#[wasm_bindgen]
pub struct FlashcardsEngine {
    store: store::FlashcardsStore,
}

impl Default for FlashcardsEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl FlashcardsEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            store: store::FlashcardsStore::new(),
        }
    }

    /// Load snapshot from binary postcard buffer (cards.bin).
    pub fn from_bytes(bytes: &[u8]) -> Fallible<FlashcardsEngine> {
        let store = store::FlashcardsStore::from_bytes(bytes).map_err(fail)?;
        Ok(FlashcardsEngine { store })
    }

    /// Serialize snapshot to binary postcard buffer (cards.bin).
    pub fn to_bytes(&self) -> Fallible<Vec<u8>> {
        self.store.to_bytes().map_err(fail)
    }

    /// Merges an external postcard snapshot into the current engine (e.g. from Syncthing sync).
    /// Reviews are unioned and latest card states are preserved.
    /// Returns true if changes were merged into the current store.
    pub fn merge_from_bytes(&mut self, bytes: &[u8]) -> Fallible<bool> {
        let other = store::FlashcardsStore::from_bytes(bytes).map_err(fail)?;
        Ok(self.store.merge(other))
    }

    /// Fast fingerprint comparison for note change detection.
    pub fn is_file_unchanged(&self, file_path: &str, mtime: f64, size: f64) -> bool {
        self.store
            .is_file_unchanged(file_path, mtime as i64, size as u64)
    }

    /// Synchronizes a single note's markdown content with the engine.
    /// Mints missing IDs if necessary, modifies store prompts & cards,
    /// and returns JSON: `{ updated_content: Option<String>, prompt_count: usize }`.
    pub fn sync_note(
        &mut self,
        file_path: &str,
        content: &str,
        mtime: f64,
        size: f64,
        inherited_tags_json: &str,
        section_hints_json: &str,
    ) -> Fallible<String> {
        let note_tags: Vec<String> = if inherited_tags_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(inherited_tags_json).map_err(fail)?
        };

        let section_hints: Vec<ObsidianSectionHint> = if section_hints_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(section_hints_json).map_err(fail)?
        };

        // Populate registry with all other existing prompt IDs across vault to prevent collisions
        let mut registry = parser::syntax::CollisionRegistry::new();
        for (id_str, p) in &self.store.prompts {
            if p.file_path != file_path
                && let Some(id) = parser::syntax::decode_block_id(id_str)
            {
                registry.insert(id);
            }
        }

        let sync_result =
            parser::sync_document_with_reg(content, &mut registry, &note_tags, &section_hints);
        let prompt_count = sync_result.prompts.len();
        self.store
            .sync_note_prompts(file_path, sync_result.prompts, mtime as i64, size as u64);

        #[derive(serde::Serialize)]
        struct SyncNoteOutcome {
            updated_content: Option<String>,
            prompt_count: usize,
        }

        serde_json::to_string(&SyncNoteOutcome {
            updated_content: sync_result.updated_content,
            prompt_count,
        })
        .map_err(fail)
    }

    /// Remove a note and all its prompts and cards from the store.
    pub fn remove_file(&mut self, file_path: &str) {
        self.store.remove_file(file_path);
    }

    /// Rename a note and update all containing prompts and sync fingerprints.
    pub fn rename_file(&mut self, old_path: &str, new_path: &str) {
        self.store.rename_file(old_path, new_path);
    }

    /// Prune any notes in the store that no longer exist on disk.
    pub fn prune_deleted_files(&mut self, valid_paths_json: &str) -> Fallible<usize> {
        let paths: Vec<String> = serde_json::from_str(valid_paths_json).map_err(fail)?;
        let set: std::collections::HashSet<String> = paths.into_iter().collect();
        Ok(self.store.prune_deleted_files(&set))
    }

    /// Get all cards due for study on or before due_cutoff_ms, optionally filtered by tag.
    pub fn get_due_cards(
        &self,
        tag_filter_json: &str,
        now_ms: f64,
        due_cutoff_ms: f64,
    ) -> Fallible<String> {
        let tags: Option<Vec<String>> = if tag_filter_json.trim().is_empty() {
            None
        } else {
            Some(serde_json::from_str(tag_filter_json).map_err(fail)?)
        };

        let cards = self
            .store
            .get_due_cards(tags.as_deref(), now_ms as i64, due_cutoff_ms as i64);
        serde_json::to_string(&cards).map_err(fail)
    }

    /// Get all cards in the vault joined with their prompt content.
    pub fn get_all_cards(&self, now_ms: f64) -> Fallible<String> {
        let cards = self.store.get_all_cards(now_ms as i64);
        serde_json::to_string(&cards).map_err(fail)
    }

    /// Record a review outcome for a card, updating its FSRS parameters and logging the review.
    pub fn record_review(
        &mut self,
        card_id: u32,
        rating_num: u8,
        now_ms: f64,
        params_json: &str,
    ) -> Fallible<String> {
        let rating = match rating_num {
            1 => types::Rating::Again,
            2 => types::Rating::Hard,
            3 => types::Rating::Good,
            4 => types::Rating::Easy,
            _ => return Err(fail("Invalid rating number (must be 1..=4)")),
        };

        let params: FsrsParams = if params_json.trim().is_empty() {
            FsrsParams::default()
        } else {
            serde_json::from_str(params_json).map_err(fail)?
        };

        let result = self
            .store
            .record_review(card_id, rating, now_ms as i64, &params);
        serde_json::to_string(&result).map_err(fail)
    }

    /// Undo the most recent review in the review log, restoring the card's previous state.
    /// Returns the restored ReviewItem JSON string, or null if nothing to undo.
    pub fn undo_last_review(&mut self, now_ms: f64) -> Fallible<Option<String>> {
        let restored = self.store.undo_last_review(now_ms as i64);
        match restored {
            Some(item) => Ok(Some(serde_json::to_string(&item).map_err(fail)?)),
            None => Ok(None),
        }
    }

    /// Get dashboard metrics (studied today, retention, streak, due count, total cards).
    pub fn get_dashboard_stats(&self, now_ms: f64, due_cutoff_ms: f64) -> Fallible<String> {
        let stats = self
            .store
            .get_dashboard_stats(now_ms as i64, due_cutoff_ms as i64);
        serde_json::to_string(&stats).map_err(fail)
    }

    /// Get upcoming due counts array for load-balanced interval calculation.
    pub fn get_upcoming_due_counts(
        &self,
        days: usize,
        now_ms: f64,
        due_cutoff_ms: f64,
    ) -> Vec<u32> {
        self.store
            .get_upcoming_due_counts(days, now_ms as i64, due_cutoff_ms as i64)
    }

    /// Get sibling card (e.g. reverse card for the same prompt) if it exists.
    pub fn get_sibling_card(&self, card_id: u32, prompt_id: &str) -> Fallible<String> {
        let card = self.store.get_sibling_card(card_id, prompt_id);
        serde_json::to_string(&card).map_err(fail)
    }

    /// Get deck stats grouped by tag.
    pub fn get_tag_deck_stats(&self, now_ms: f64, due_cutoff_ms: f64) -> Fallible<String> {
        let stats = self
            .store
            .get_tag_deck_stats(now_ms as i64, due_cutoff_ms as i64);
        serde_json::to_string(&stats).map_err(fail)
    }

    /// Toggle an inline tag (e.g. #card/todo, #card/leech) on the prompt in note content.
    pub fn toggle_prompt_tag(&self, content: &str, prompt_id: &str, tag: &str) -> Option<String> {
        parser::toggle_tag_in_content(content, prompt_id, tag)
    }

    /// Add an inline tag to the prompt in note content if not present.
    pub fn add_prompt_tag(&self, content: &str, prompt_id: &str, tag: &str) -> Option<String> {
        parser::add_tag_in_content(content, prompt_id, tag)
    }

    /// Get all historical review logs.
    pub fn get_review_logs(&self) -> Fallible<String> {
        let logs = self.store.get_review_logs();
        serde_json::to_string(&logs).map_err(fail)
    }

    /// Optimize FSRS model weights based on historical review logs.
    pub fn optimize_weights(&self, params_json: &str) -> Fallible<String> {
        let params: FsrsParams = if params_json.trim().is_empty() {
            FsrsParams::default()
        } else {
            serde_json::from_str(params_json).map_err(fail)?
        };
        let logs = self.store.get_review_logs();
        let weights = optimizer::optimize_weights(&params, &logs);
        serde_json::to_string(&weights).map_err(fail)
    }
}

/// Generate a fresh, unique 6-character lowercase base-36 block ID ([0-9a-z]).
#[wasm_bindgen]
pub fn generate_block_id(existing_ids_json: &str) -> Fallible<String> {
    let mut registry = CollisionRegistry::from_json(existing_ids_json)?;
    Ok(registry.allocate_id())
}

/// Calculate next scheduling states for a card given FSRS parameters.
#[wasm_bindgen]
pub fn calculate_schedule(card_json: &str, params_json: &str, now_ms: f64) -> Fallible<String> {
    let card: SchedulingCard = serde_json::from_str(card_json).map_err(fail)?;

    let params: FsrsParams = if params_json.trim().is_empty() {
        FsrsParams::default()
    } else {
        serde_json::from_str(params_json).map_err(fail)?
    };

    let engine = FsrsEngine::new(params);
    let info = engine.schedule(&card, now_ms as i64);

    serde_json::to_string(&info).map_err(fail)
}

/// Optimize FSRS parameters over historical review logs.
#[wasm_bindgen]
pub fn optimize_fsrs_weights(params_json: &str, logs_json: &str) -> Fallible<String> {
    let params: FsrsParams = if params_json.trim().is_empty() {
        FsrsParams::default()
    } else {
        serde_json::from_str(params_json).map_err(fail)?
    };

    let logs: Vec<ReviewLogEntry> = serde_json::from_str(logs_json).map_err(fail)?;

    let new_weights = optimize_weights(&params, &logs);
    serde_json::to_string(&new_weights).map_err(fail)
}
