pub mod fsrs;
pub mod optimizer;
pub mod parser;
pub mod types;

use std::collections::HashSet;

use fsrs::FsrsEngine;
use optimizer::optimize_weights;
use parser::{ObsidianSectionHint, parse_markdown_blocks_with_sections, sync_document};
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

/// Synchronize a markdown document in a single pass:
/// Mints fresh 6-character lowercase base-36 IDs for missing or colliding blocks,
/// updates the document text, and returns the parsed blocks.
#[wasm_bindgen]
pub fn sync_document_wasm(
    markdown: &str,
    existing_ids_json: &str,
    note_tags_json: &str,
    section_hints_json: &str,
) -> Fallible<String> {
    let existing_ids: HashSet<String> = if existing_ids_json.trim().is_empty() {
        HashSet::new()
    } else {
        serde_json::from_str(existing_ids_json).map_err(fail)?
    };

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

    let result = sync_document(markdown, &existing_ids, &note_tags, &section_hints);
    serde_json::to_string(&result).map_err(fail)
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
    let existing_ids: HashSet<String> = if existing_ids_json.trim().is_empty() {
        HashSet::new()
    } else {
        serde_json::from_str(existing_ids_json).map_err(fail)?
    };

    let id = parser::syntax::generate_unique_block_id(&existing_ids);
    Ok(id)
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
