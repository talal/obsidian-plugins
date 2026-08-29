#![no_main]

//! Fuzzing target for FSRS-6 scheduling calculations:
//! Asserts that arbitrary card states, learning steps, retention values,
//! weights, timestamps, and intervals never panic and always produce
//! finite, strictly bounded candidate states.

use flashcards_wasm::fsrs::FsrsEngine;
use flashcards_wasm::types::{FsrsParams, Rating, SchedulingCard, State};
use libfuzzer_sys::arbitrary::Unstructured;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut u = Unstructured::new(data);

    let state_byte: u8 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let state = match state_byte % 4 {
        0 => State::New,
        1 => State::Learning,
        2 => State::Review,
        _ => State::Relearning,
    };

    let stability: f64 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let difficulty: f64 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let due: i64 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let last_review: Option<i64> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let reps: u32 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let lapses: u32 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let learning_step: u32 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let relearning_step: u32 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };

    let weights: Option<Vec<f64>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let request_retention: Option<f64> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let maximum_interval: Option<f64> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let learning_steps: Option<Vec<i64>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let relearning_steps: Option<Vec<i64>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let due_counts: Option<Vec<u32>> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let sibling_due_offset: Option<u32> = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };
    let now_ms: i64 = match u.arbitrary() {
        Ok(v) => v,
        Err(_) => return,
    };

    let card = SchedulingCard {
        state,
        stability,
        difficulty,
        due,
        last_review,
        reps,
        lapses,
        learning_step,
        relearning_step,
    };

    let learning_steps = match learning_steps {
        Some(steps) if !steps.is_empty() => steps,
        _ => vec![10 * 60 * 1000],
    };
    let relearning_steps = match relearning_steps {
        Some(steps) if !steps.is_empty() => steps,
        _ => vec![10 * 60 * 1000],
    };

    let params = FsrsParams {
        weights,
        request_retention: request_retention.unwrap_or(0.90),
        maximum_interval: maximum_interval.unwrap_or(36500.0),
        learning_steps,
        relearning_steps,
        due_counts,
        sibling_due_offset,
    };

    let engine = FsrsEngine::new(params);
    let result = engine.schedule(&card, now_ms);

    // Invariants:
    // 1. Must produce exactly 4 candidate transitions (Again, Hard, Good, Easy)
    assert_eq!(
        result.next_states.len(),
        4,
        "Must produce next states for all 4 ratings"
    );

    for candidate in &result.next_states {
        let rating = candidate.rating;
        assert!(
            matches!(
                rating,
                Rating::Again | Rating::Hard | Rating::Good | Rating::Easy
            ),
            "Candidate rating must be valid"
        );

        let next_card = &candidate.card;

        // Numerical safety invariants: stability and difficulty must be finite & non-negative
        assert!(
            next_card.stability.is_finite(),
            "Stability must be finite, got {}",
            next_card.stability
        );
        assert!(
            next_card.stability >= 0.0,
            "Stability must be non-negative, got {}",
            next_card.stability
        );

        assert!(
            next_card.difficulty.is_finite(),
            "Difficulty must be finite, got {}",
            next_card.difficulty
        );
        assert!(
            next_card.difficulty >= 0.0,
            "Difficulty must be non-negative, got {}",
            next_card.difficulty
        );

        assert!(
            candidate.interval_days.is_finite(),
            "Interval days must be finite, got {}",
            candidate.interval_days
        );
        assert!(
            candidate.interval_days >= 0.0,
            "Interval days must be non-negative, got {}",
            candidate.interval_days
        );

        // Rep count monotonicity
        assert!(
            next_card.reps >= card.reps,
            "Reps count must not decrease"
        );

        // State validity
        assert!(
            matches!(
                next_card.state,
                State::New | State::Learning | State::Review | State::Relearning
            ),
            "Next card state must be valid"
        );
    }
});
