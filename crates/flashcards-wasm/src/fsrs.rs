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

        let memory_state = if current.state == State::New || current.stability <= 0.0 {
            None
        } else {
            Some(MemoryState {
                stability: current.stability as f32,
                difficulty: current.difficulty as f32,
            })
        };

        let retention = self.params.retention() as f32;
        let next_states = self
            .model
            .next_states(memory_state, retention, elapsed_days)
            .unwrap_or_else(|_| {
                // Fallback to fresh next states if invalid
                self.model.next_states(None, retention, 0).unwrap()
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
                duration_ms as f64 / DAY_MS
            } else if rating == Rating::Again {
                0.0
            } else {
                (item_state.interval as f64).max(1.0).min(max_ivl)
            };

            // Apply FSRS interval fuzzing for multi-day intervals if enabled
            if step_duration_ms.is_none()
                && rating != Rating::Again
                && self.params.is_fuzz_enabled()
                && interval_days >= 2.5
            {
                let seed = ((current.stability * 1000.0) as u64)
                    ^ ((current.reps as u64) << 16)
                    ^ (now_ms as u64);
                let factor = (((seed % 200) as f64) - 100.0) / 2000.0; // [-0.05, +0.05]
                let fuzzed = (interval_days * (1.0 + factor)).round();
                interval_days = fuzzed.clamp(1.0, max_ivl);
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

            candidates.push(SchedulingCardCandidate {
                rating,
                card: SchedulingCard {
                    stability: item_state.memory.stability as f64,
                    difficulty: item_state.memory.difficulty as f64,
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
}
