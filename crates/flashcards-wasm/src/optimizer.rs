use std::collections::BTreeMap;

use crate::types::{FsrsParams, ReviewLogEntry};
use fsrs::{ComputeParametersInput, DEFAULT_PARAMETERS, FSRSItem, FSRSReview, compute_parameters};

const MIN_TRAINING_ITEMS: usize = 8;

fn fallback_parameters(params: &FsrsParams) -> Vec<f64> {
    if let Some(weights) = &params.w
        && weights.len() == DEFAULT_PARAMETERS.len()
        && weights.iter().all(|weight| weight.is_finite())
    {
        return weights.clone();
    }

    DEFAULT_PARAMETERS
        .iter()
        .map(|&weight| weight as f64)
        .collect()
}

fn rounded_delta_t(delta_t: f64) -> Option<u32> {
    if !delta_t.is_finite() || delta_t < 0.0 {
        return None;
    }

    Some(delta_t.round().min(u32::MAX as f64) as u32)
}

/// Optimizes FSRS parameters using the trainer shipped with fsrs-rs.
///
/// The database supplies one log row per review. The trainer expects one item
/// per review containing that card's complete history, so each card history is
/// expanded into chronological prefixes before training.
pub fn optimize_weights(initial_params: &FsrsParams, logs: &[ReviewLogEntry]) -> Vec<f64> {
    let fallback = fallback_parameters(initial_params);
    if logs.is_empty() {
        return fallback;
    }

    let mut histories: BTreeMap<String, Vec<FSRSReview>> = BTreeMap::new();
    for (index, entry) in logs.iter().enumerate() {
        if !(1..=4).contains(&entry.rating) {
            return fallback;
        }

        let card_id = if entry.card_id.is_empty() {
            // Logs without an identity cannot safely be joined to another
            // card's history. Treat each one as an isolated legacy card.
            format!("legacy-{index}")
        } else {
            entry.card_id.clone()
        };
        let history = histories.entry(card_id).or_default();
        let delta_t = if history.is_empty() {
            0
        } else {
            match rounded_delta_t(entry.delta_t) {
                Some(value) => value,
                None => return fallback,
            }
        };
        history.push(FSRSReview {
            rating: entry.rating as u32,
            delta_t,
        });
    }

    let mut train_set = Vec::new();
    let mut card_ids = Vec::new();
    for (card_index, reviews) in histories.values().enumerate() {
        for end in 1..reviews.len() {
            let prefix = reviews[..=end].to_vec();
            if prefix.iter().any(|review| review.delta_t > 0) {
                train_set.push(FSRSItem { reviews: prefix });
                card_ids.push(card_index as i64);
            }
        }
    }

    if train_set.len() < MIN_TRAINING_ITEMS {
        return fallback;
    }

    let trained = compute_parameters(ComputeParametersInput {
        train_set,
        card_ids: Some(card_ids),
        enable_short_term: true,
        num_relearning_steps: Some(initial_params.relearning_steps().len()),
        ..Default::default()
    });

    match trained {
        Ok(weights)
            if weights.len() == DEFAULT_PARAMETERS.len()
                && weights.iter().all(|weight| weight.is_finite()) =>
        {
            weights.into_iter().map(|weight| weight as f64).collect()
        }
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(card_id: &str, rating: u8, delta_t: f64) -> ReviewLogEntry {
        ReviewLogEntry {
            card_id: card_id.to_string(),
            rating,
            delta_t,
        }
    }

    #[test]
    fn test_optimize_weights_falls_back_for_insufficient_data() {
        let params = FsrsParams::default();
        let logs = vec![log("card", 3, 0.0), log("card", 3, 2.0)];

        let optimized = optimize_weights(&params, &logs);
        assert_eq!(optimized.len(), DEFAULT_PARAMETERS.len());
        assert!(optimized.iter().all(|weight| weight.is_finite()));
    }

    #[test]
    fn test_optimize_weights_accepts_again_and_good_only_logs() {
        let params = FsrsParams::default();
        let mut logs = Vec::new();
        for card in 0..4 {
            let card_id = format!("card-{card}");
            logs.push(log(&card_id, 3, 0.0));
            logs.push(log(&card_id, if card % 2 == 0 { 1 } else { 3 }, 2.0));
            logs.push(log(&card_id, 3, 4.0));
        }

        let optimized = optimize_weights(&params, &logs);
        assert_eq!(optimized.len(), DEFAULT_PARAMETERS.len());
        assert!(optimized.iter().all(|weight| weight.is_finite()));
    }

    #[test]
    fn test_optimize_weights_rejects_invalid_logs() {
        let params = FsrsParams::default();
        let logs = vec![log("card", 5, 2.0)];

        let optimized = optimize_weights(&params, &logs);
        assert_eq!(
            optimized,
            DEFAULT_PARAMETERS
                .iter()
                .map(|&weight| weight as f64)
                .collect::<Vec<_>>()
        );
    }
}
