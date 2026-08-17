#![no_main]

use formatter_core::format;
use libfuzzer_sys::fuzz_target;
use std::str;

fuzz_target!(|data: &[u8]| {
    // Only process valid UTF-8 strings
    if let Ok(input) = str::from_utf8(data) {
        // 1. Ensure it doesn't panic
        let _ = format(input);
    }
});
