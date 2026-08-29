use crate::types::{
    FsrsParams, Rating, SchedulingCard, SchedulingCardCandidate, SchedulingInfo, State,
};
use fsrs::{FSRS, MemoryState};

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

pub struct FsrsEngine {
    pub model: FSRS,
    pub params: FsrsParams,
}

impl FsrsEngine {
    pub fn new(params: FsrsParams) -> Self {
        let model = if let Some(w) = &params.w {
            let f32_w: Vec<f32> = w.iter().map(|&x| x as f32).collect();
            FSRS::new(&f32_w).unwrap_or_default()
        } else {
            FSRS::default()
        };

        Self { model, params }
    }

    /// Calculate next scheduling state candidates using official fsrs-rs model
    pub fn schedule(&self, current: &SchedulingCard, now_ms: i64) -> SchedulingInfo {
        let elapsed_days = if let Some(last_review_ms) = current.last_review {
            let diff_ms = (now_ms - last_review_ms).max(0);
            ((diff_ms as f64) / (1000.0 * 60.0 * 60.0 * 24.0)).round() as u32
        } else {
            0
        };

        let memory_state = if current.state == State::New
            || !current.stability.is_finite()
            || current.stability <= 0.0
        {
            None
        } else {
            let stability = (current.stability as f32).clamp(0.01, 36500.0);
            let difficulty = if current.difficulty.is_finite() {
                (current.difficulty as f32).clamp(1.0, 10.0)
            } else {
                5.0
            };
            Some(MemoryState {
                stability,
                difficulty,
            })
        };

        let retention = self.params.retention() as f32;
        let next_states = self
            .model
            .next_states(memory_state, retention, elapsed_days)
            .or_else(|_| self.model.next_states(None, retention, 0))
            .unwrap_or_else(|_| {
                FSRS::default()
                    .next_states(None, 0.9, 0)
                    .unwrap_or(fsrs::NextStates {
                        again: fsrs::ItemState {
                            memory: MemoryState {
                                stability: 0.1,
                                difficulty: 5.0,
                            },
                            interval: 0.0,
                        },
                        hard: fsrs::ItemState {
                            memory: MemoryState {
                                stability: 1.0,
                                difficulty: 5.0,
                            },
                            interval: 1.0,
                        },
                        good: fsrs::ItemState {
                            memory: MemoryState {
                                stability: 3.0,
                                difficulty: 5.0,
                            },
                            interval: 3.0,
                        },
                        easy: fsrs::ItemState {
                            memory: MemoryState {
                                stability: 7.0,
                                difficulty: 4.0,
                            },
                            interval: 7.0,
                        },
                    })
            });

        let rating_items = [
            (Rating::Again, next_states.again),
            (Rating::Hard, next_states.hard),
            (Rating::Good, next_states.good),
            (Rating::Easy, next_states.easy),
        ];

        let max_ivl = self.params.max_interval();
        let learning_steps = self.params.learning_steps();
        let relearning_steps = self.params.relearning_steps();
        let mut candidates = Vec::with_capacity(4);

        for (rating, item_state) in rating_items {
            let mut next_state = State::Review;
            let mut learning_step = 0;
            let mut relearning_step = 0;
            let mut step_duration_ms = None;

            match current.state {
                State::New => match rating {
                    Rating::Again | Rating::Hard => {
                        next_state = State::Learning;
                        step_duration_ms = learning_steps.first().copied();
                    }
                    Rating::Good | Rating::Easy => {}
                },
                State::Learning => match rating {
                    Rating::Again => {
                        next_state = State::Learning;
                        step_duration_ms = learning_steps.first().copied();
                    }
                    Rating::Hard => {
                        next_state = State::Learning;
                        let index = (current.learning_step as usize).min(learning_steps.len() - 1);
                        learning_step = index as u32;
                        step_duration_ms = Some(learning_steps[index]);
                    }
                    Rating::Good => {
                        let index = current.learning_step.saturating_add(1) as usize;
                        if let Some(duration) = learning_steps.get(index) {
                            next_state = State::Learning;
                            learning_step = index as u32;
                            step_duration_ms = Some(*duration);
                        }
                    }
                    Rating::Easy => {}
                },
                State::Relearning => match rating {
                    Rating::Again => {
                        next_state = State::Relearning;
                        step_duration_ms = relearning_steps.first().copied();
                    }
                    Rating::Hard => {
                        next_state = State::Relearning;
                        let index =
                            (current.relearning_step as usize).min(relearning_steps.len() - 1);
                        relearning_step = index as u32;
                        step_duration_ms = Some(relearning_steps[index]);
                    }
                    Rating::Good => {
                        let index = current.relearning_step.saturating_add(1) as usize;
                        if let Some(duration) = relearning_steps.get(index) {
                            next_state = State::Relearning;
                            relearning_step = index as u32;
                            step_duration_ms = Some(*duration);
                        }
                    }
                    Rating::Easy => {}
                },
                State::Review => {
                    if rating == Rating::Again {
                        next_state = State::Relearning;
                        step_duration_ms = relearning_steps.first().copied();
                    }
                }
            }

            let mut interval_days = if let Some(duration_ms) = step_duration_ms {
                (duration_ms as f64 / DAY_MS).max(0.0)
            } else if rating == Rating::Again {
                0.0
            } else {
                let ivl = item_state.interval as f64;
                if ivl.is_finite() {
                    ivl.clamp(1.0, max_ivl)
                } else {
                    1.0
                }
            };

            // Apply FSRS interval fuzzing and load balancing for multi-day intervals if enabled
            if step_duration_ms.is_none()
                && rating != Rating::Again
                && self.params.is_fuzz_enabled()
                && interval_days >= 2.5
            {
                let seed = if current.stability.is_finite() {
                    ((current.stability * 1000.0) as u64)
                        ^ ((current.reps as u64) << 16)
                        ^ (now_ms as u64)
                } else {
                    (current.reps as u64) ^ (now_ms as u64)
                };
                interval_days = calculate_load_balanced_interval(
                    interval_days,
                    max_ivl,
                    seed,
                    self.params.due_counts.as_deref(),
                    self.params.sibling_due_offset,
                );
            }

            let lapses = if rating == Rating::Again && current.state == State::Review {
                current.lapses.saturating_add(1)
            } else {
                current.lapses
            };

            let due_ms = if let Some(duration_ms) = step_duration_ms {
                now_ms.saturating_add(duration_ms)
            } else {
                now_ms.saturating_add((interval_days * DAY_MS) as i64)
            };

            let next_stability = if item_state.memory.stability.is_finite() {
                (item_state.memory.stability as f64).max(0.01)
            } else {
                0.1
            };
            let next_difficulty = if item_state.memory.difficulty.is_finite() {
                (item_state.memory.difficulty as f64).clamp(1.0, 10.0)
            } else {
                5.0
            };

            candidates.push(SchedulingCardCandidate {
                rating,
                card: SchedulingCard {
                    stability: next_stability,
                    difficulty: next_difficulty,
                    reps: current.reps.saturating_add(1),
                    lapses,
                    learning_step,
                    relearning_step,
                    state: next_state,
                    last_review: Some(now_ms),
                    due: due_ms,
                },
                interval_days,
            });
        }

        SchedulingInfo {
            card: current.clone(),
            next_states: candidates,
        }
    }
}

/// Calculates the constrained fuzz bounds [lower, upper] for a target interval in days.
pub fn constrained_fuzz_bounds(interval_days: f64, max_ivl: f64) -> (u32, u32) {
    if interval_days < 2.5 {
        let ivl = (interval_days.round() as u32).max(1);
        return (ivl, ivl);
    }

    let (lower, upper) = if interval_days < 7.0 {
        let rounded = interval_days.round() as u32;
        (rounded.saturating_sub(1).max(1), rounded.saturating_add(1))
    } else if interval_days < 30.0 {
        let lower = (interval_days * 0.85).round() as u32;
        let upper = (interval_days * 1.15).round() as u32;
        (lower.max(1), upper.max(lower))
    } else {
        let lower = (interval_days * 0.95).round() as u32;
        let upper = (interval_days * 1.05).round() as u32;
        (lower.max(1), upper.max(lower))
    };

    let max_u32 = max_ivl.clamp(1.0, u32::MAX as f64) as u32;
    (
        lower.min(max_u32).max(1),
        upper.min(max_u32).max(lower.min(max_u32).max(1)),
    )
}

/// Computes penalty modifier for days close to sibling due date.
///
/// Dispersion penalties prevent sibling cards (e.g. forward and reverse directions
/// of the same fact) from being reviewed together, preventing priming bias:
/// - Same day (Δ = 0): 10⁻⁶ multiplier effectively forbids co-scheduling.
/// - Adjacent days (Δ = 1..4): Graded linear penalty (20% -> 40% -> 60% -> 80%).
/// - Distant days (Δ >= 5): Full weight (1.0).
fn sibling_penalty(day: u32, sibling_due_offset: Option<u32>) -> f64 {
    if let Some(sibling_day) = sibling_due_offset {
        let diff = (day as i32 - sibling_day as i32).abs();
        match diff {
            0 => 0.000001,
            1 => 0.20,
            2 => 0.40,
            3 => 0.60,
            4 => 0.80,
            _ => 1.0,
        }
    } else {
        1.0
    }
}

/// Selects the optimal interval within the fuzz window by smoothing review load and dispersing siblings.
pub fn calculate_load_balanced_interval(
    interval_days: f64,
    max_ivl: f64,
    seed: u64,
    due_counts: Option<&[u32]>,
    sibling_due_offset: Option<u32>,
) -> f64 {
    let (lower, upper) = constrained_fuzz_bounds(interval_days, max_ivl);
    if lower >= upper {
        return lower as f64;
    }

    let mut candidates = Vec::with_capacity((upper - lower + 1) as usize);
    let mut total_weight = 0.0;

    for day in lower..=upper {
        let count = due_counts
            .and_then(|counts| counts.get(day as usize).copied())
            .unwrap_or(0);

        // Super-linear (p=2.15) inverse load dampening heavily penalizes busy days
        let count_weight = if count == 0 {
            1.0
        } else {
            (1.0 / count as f64).powf(2.15)
        };

        // Cubic (1/d³)—bias favors days closer to the target interval, preventing upward interval drift
        let interval_bias = (1.0 / (day as f64)).powi(3);
        let sib_penalty = sibling_penalty(day, sibling_due_offset);
        let weight = (count_weight * interval_bias * sib_penalty).max(1e-12);

        candidates.push((day, weight));
        total_weight += weight;
    }

    if total_weight <= 0.0 || !total_weight.is_finite() {
        return interval_days.round().clamp(lower as f64, upper as f64);
    }

    // Deterministic pseudo-random selection based on seed
    let mut state = seed.wrapping_mul(0x9E3779B97F4A7C15);
    state ^= state >> 30;
    state = state.wrapping_mul(0xBF58476D1CE4E5B9);
    state ^= state >> 27;
    state = state.wrapping_mul(0x94D049BB133111EB);
    state ^= state >> 31;
    let rand_frac = ((state >> 11) as f64) / ((1u64 << 53) as f64);

    let mut cumulative = 0.0;
    let target = rand_frac * total_weight;
    for (day, weight) in candidates {
        cumulative += weight;
        if cumulative >= target {
            return day as f64;
        }
    }

    upper as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_card_scheduling() {
        let engine = FsrsEngine::new(FsrsParams::default());
        let card = SchedulingCard {
            stability: 0.0,
            difficulty: 0.0,
            reps: 0,
            lapses: 0,
            learning_step: 0,
            relearning_step: 0,
            state: State::New,
            last_review: None,
            due: 0,
        };

        let now = 1700000000000;
        let info = engine.schedule(&card, now);
        assert_eq!(info.next_states.len(), 4);

        let again = &info.next_states[0];
        assert_eq!(again.rating, Rating::Again);
        assert_eq!(again.card.state, State::Learning);
        assert_eq!(again.card.lapses, 0); // New card should not increment lapses on Again

        let good = &info.next_states[2];
        assert_eq!(good.rating, Rating::Good);
        assert_eq!(good.card.state, State::Review);
        assert!(good.card.stability > 1.0);
        assert!(good.interval_days >= 1.0);
    }

    #[test]
    fn test_review_card_recall_and_forget() {
        let engine = FsrsEngine::new(FsrsParams::default());
        let card = SchedulingCard {
            stability: 5.0,
            difficulty: 3.0,
            reps: 3,
            lapses: 0,
            learning_step: 0,
            relearning_step: 0,
            state: State::Review,
            last_review: Some(1700000000000 - 1000 * 60 * 60 * 24 * 5),
            due: 1700000000000,
        };

        let info = engine.schedule(&card, 1700000000000);
        let again = &info.next_states[0];
        assert_eq!(again.card.state, State::Relearning);
        assert_eq!(again.card.lapses, 1);
        assert!(again.card.stability < 5.0);

        let good = &info.next_states[2];
        assert_eq!(good.card.state, State::Review);
        assert!(good.card.stability > 5.0);
    }

    #[test]
    fn test_learning_steps_advance_before_graduation() {
        let first_step = 10 * 60 * 1000;
        let second_step = 2 * 24 * 60 * 60 * 1000;
        let engine = FsrsEngine::new(FsrsParams {
            learning_steps: Some(vec![first_step, second_step]),
            ..FsrsParams::default()
        });
        let card = SchedulingCard {
            stability: 0.0,
            difficulty: 0.0,
            reps: 0,
            lapses: 0,
            learning_step: 0,
            relearning_step: 0,
            state: State::New,
            last_review: None,
            due: 0,
        };
        let now = 1700000000000;

        let first = engine.schedule(&card, now).next_states[0].card.clone();
        assert_eq!(first.state, State::Learning);
        assert_eq!(first.learning_step, 0);
        assert_eq!(first.due, now + first_step);

        let second = engine.schedule(&first, first.due).next_states[2]
            .card
            .clone();
        assert_eq!(second.state, State::Learning);
        assert_eq!(second.learning_step, 1);
        assert_eq!(second.due, first.due + second_step);

        let graduated = engine.schedule(&second, second.due).next_states[2]
            .card
            .clone();
        assert_eq!(graduated.state, State::Review);
        assert_eq!(graduated.learning_step, 0);
    }

    #[test]
    fn test_constrained_fuzz_bounds() {
        // < 2.5: No fuzz
        assert_eq!(constrained_fuzz_bounds(1.0, 36500.0), (1, 1));
        assert_eq!(constrained_fuzz_bounds(2.0, 36500.0), (2, 2));

        // 2.5 <= ivl < 7: ±1 day
        assert_eq!(constrained_fuzz_bounds(4.0, 36500.0), (3, 5));
        assert_eq!(constrained_fuzz_bounds(6.0, 36500.0), (5, 7));

        // 7 <= ivl < 30: ±15%
        let (low10, high10) = constrained_fuzz_bounds(10.0, 36500.0);
        assert_eq!(low10, 9);
        assert_eq!(high10, 12);

        let (low20, high20) = constrained_fuzz_bounds(20.0, 36500.0);
        assert_eq!(low20, 17);
        assert_eq!(high20, 23);

        // >= 30: ±5%
        let (low100, high100) = constrained_fuzz_bounds(100.0, 36500.0);
        assert_eq!(low100, 95);
        assert_eq!(high100, 105);

        // Capped by max_ivl
        let (low_capped, high_capped) = constrained_fuzz_bounds(100.0, 98.0);
        assert_eq!(low_capped, 95);
        assert_eq!(high_capped, 98);
    }

    #[test]
    fn test_load_balancing_steers_away_from_congested_days() {
        // Range for 4 days is [3, 5]
        let due_counts = vec![0, 0, 0, 100, 0, 100]; // Day 3 has 100, Day 4 has 0, Day 5 has 100

        let mut chosen_days = std::collections::HashMap::new();
        for seed in 0..100 {
            let ivl = calculate_load_balanced_interval(4.0, 36500.0, seed, Some(&due_counts), None);
            *chosen_days.entry(ivl as u32).or_insert(0) += 1;
        }

        // Day 4 (with count 0) should be overwhelmingly chosen over congested days 3 & 5
        let count_day4 = chosen_days.get(&4).copied().unwrap_or(0);
        assert!(
            count_day4 > 90,
            "Expected Day 4 to be overwhelmingly chosen (>90%), got {count_day4}"
        );
    }

    #[test]
    fn test_sibling_dispersion_avoids_sibling_due_day() {
        // Range for 10 days is [9, 12]
        // Sibling is due on Day 10
        let mut chosen_days = std::collections::HashMap::new();
        for seed in 0..100 {
            let ivl = calculate_load_balanced_interval(10.0, 36500.0, seed, None, Some(10));
            *chosen_days.entry(ivl as u32).or_insert(0) += 1;
        }

        // Day 10 has a heavy penalty (0.000001) so it should almost never be chosen
        let count_day10 = chosen_days.get(&10).copied().unwrap_or(0);
        assert_eq!(
            count_day10, 0,
            "Sibling due day 10 should be avoided, got {count_day10}"
        );
    }
}
