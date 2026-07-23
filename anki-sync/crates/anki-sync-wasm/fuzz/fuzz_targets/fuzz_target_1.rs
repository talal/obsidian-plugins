#![no_main]

use anki_sync_wasm::scan_for_fuzz;
use libfuzzer_sys::fuzz_target;
use std::str;

fuzz_target!(|data: &[u8]| {
    if let Ok(input) = str::from_utf8(data) {
        scan_for_fuzz(input);
    }
});
