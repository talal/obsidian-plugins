pub mod fsrs;
pub mod optimizer;
pub mod parser;
pub mod types;

use fsrs::FsrsEngine;
use optimizer::optimize_weights;
use parser::{ObsidianSectionHint, parse_markdown_blocks_with_sections};
use types::{FsrsParams, ReviewLogEntry, SchedulingCard};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Parse flashcard blocks from markdown note text
#[wasm_bindgen]
pub fn parse_blocks(
    markdown: &str,
    note_tags_json: &str,
    section_hints_json: &str,
) -> Result<String, JsValue> {
    let note_tags: Vec<String> = if note_tags_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(note_tags_json).map_err(|e| JsValue::from_str(&e.to_string()))?
    };

    let section_hints: Vec<ObsidianSectionHint> = if section_hints_json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(section_hints_json).map_err(|e| JsValue::from_str(&e.to_string()))?
    };

    let blocks = parse_markdown_blocks_with_sections(markdown, &note_tags, &section_hints);
    serde_json::to_string(&blocks).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Calculate next scheduling states for a card given FSRS parameters
#[wasm_bindgen]
pub fn calculate_schedule(
    card_json: &str,
    params_json: &str,
    now_ms: f64,
) -> Result<String, JsValue> {
    let card: SchedulingCard =
        serde_json::from_str(card_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let params: FsrsParams = if params_json.trim().is_empty() {
        FsrsParams::default()
    } else {
        serde_json::from_str(params_json).map_err(|e| JsValue::from_str(&e.to_string()))?
    };

    let engine = FsrsEngine::new(params);
    let info = engine.schedule(&card, now_ms as i64);

    serde_json::to_string(&info).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Optimize FSRS parameters over historical review logs
#[wasm_bindgen]
pub fn optimize_fsrs_weights(params_json: &str, logs_json: &str) -> Result<String, JsValue> {
    let params: FsrsParams = if params_json.trim().is_empty() {
        FsrsParams::default()
    } else {
        serde_json::from_str(params_json).map_err(|e| JsValue::from_str(&e.to_string()))?
    };

    let logs: Vec<ReviewLogEntry> =
        serde_json::from_str(logs_json).map_err(|e| JsValue::from_str(&e.to_string()))?;

    let new_weights = optimize_weights(&params, &logs);
    serde_json::to_string(&new_weights).map_err(|e| JsValue::from_str(&e.to_string()))
}
