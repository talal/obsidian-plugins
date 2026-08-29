#![no_main]

//! Fuzzing target for FSRS weight optimizer:
//! Asserts that arbitrary sequences of review logs (empty, single, massive,
//! negative delta_t, non-finite delta_t, out-of-range ratings, duplicate IDs)
//! never panic, terminate quickly, and always return exactly 21 finite weights.

use flashcards_wasm::optimizer::optimize_weights;
use flashcards_wasm::types::{FsrsParams, ReviewLogEntry};
use libfuzzer_sys::arbitrary::Unstructured;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);

    let weights: Option<Vec<f64>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let request_retention: Option<f64> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let relearning_steps: Option<Vec<i64>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };

    let log_count: u8 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };

    // Cap to 64 logs per iteration for fast fuzz execution
    let count = (log_count % 65) as usize;
    let mut logs = Vec::with_capacity(count);

    for _ in 0..count {
        let card_id_len: u8 = match u.arbitrary() {
            Ok(v) => v,
            Err(_) => return,
        };
        let card_id = format!("card-{}", card_id_len % 16);
        let rating: u8 = match u.arbitrary() {
            Ok(v) => v,
            Err(_) => return,
        };
        let delta_t: f64 = match u.arbitrary() {
            Ok(v) => v,
            Err(_) => return,
        };

        logs.push(ReviewLogEntry {
            card_id,
            rating,
            delta_t,
        });
    }

    let params = FsrsParams {
        w: weights,
        request_retention,
        maximum_interval: None,
        learning_steps: None,
        relearning_steps,
        enable_fuzz: None,
        due_counts: None,
        sibling_due_offset: None,
    };

    let optimized = optimize_weights(&params, &logs);

    // Invariants:
    // 1. Must return exactly 21 weights
    assert_eq!(
        optimized.len(),
        21,
        "FSRS optimizer must return exactly 21 parameters, got {}",
        optimized.len()
    );

    // 2. All weights must be finite numbers (no NaN, no +Inf, no -Inf)
    for (i, &w) in optimized.iter().enumerate() {
        assert!(
            w.is_finite(),
            "Weight at index {} must be finite, got {}",
            i,
            w
        );
    }
});
