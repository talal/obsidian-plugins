use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn format_markdown(input: &str) -> Result<String, JsValue> {
    formatter_core::format(input).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn would_change_markdown(input: &str) -> Result<bool, JsValue> {
    formatter_core::would_change(input).map_err(|e| JsValue::from_str(&e.to_string()))
}
