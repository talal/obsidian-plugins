pub mod fsrs;
pub mod optimizer;
pub mod parser;
pub mod types;

use fsrs::FsrsEngine;
use optimizer::optimize_weights;
use parser::{ObsidianSectionHint, parse_markdown_blocks_with_sections};
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

/// Synchronize a markdown document against a scan-scoped CollisionRegistry.
/// Avoids rebuilding the collision registry for every document in a vault scan.
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

/// Synchronize a markdown document in a single pass (standalone wrapper):
/// Mints fresh 6-character lowercase base-36 IDs for missing or colliding blocks,
/// updates the document text, and returns the parsed blocks.
#[wasm_bindgen]
pub fn sync_document_wasm(
    markdown: &str,
    existing_ids_json: &str,
    note_tags_json: &str,
    section_hints_json: &str,
) -> Fallible<String> {
    let mut registry = CollisionRegistry::from_json(existing_ids_json)?;
    sync_document_with_registry(markdown, &mut registry, note_tags_json, section_hints_json)
}

/// Parse flashcard blocks from markdown note text without modifying content.
#[wasm_bindgen]
pub fn parse_blocks(
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

    let blocks = parse_markdown_blocks_with_sections(markdown, &note_tags, &section_hints);
    serde_json::to_string(&blocks).map_err(fail)
}

/// Generate a fresh, unique 6-character lowercase base-36 block ID ([0-9a-z]).
#[wasm_bindgen]
pub fn generate_block_id(existing_ids_json: &str) -> Fallible<String> {
    let mut registry = CollisionRegistry::from_json(existing_ids_json)?;
    Ok(registry.allocate_id())
}

/// Generate a fresh, unique 6-character block ID using an existing CollisionRegistry.
#[wasm_bindgen]
pub fn generate_block_id_with_registry(registry: &mut CollisionRegistry) -> String {
    registry.allocate_id()
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
