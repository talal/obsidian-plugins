use std::collections::{HashMap, HashSet};

use crate::fsrs::FsrsEngine;
pub use crate::types::FlashcardsStore;
use crate::types::{
    Card, DashboardStats, Direction, FileSyncState, FsrsParams, ParsedPrompt, Prompt, Rating,
    ReviewItem, ReviewLog, ReviewLogEntry, SchedulingCard, State, TagDeckStats,
};

const DAY_MS: i64 = 86_400_000;

const MAGIC_V1: &[u8; 4] = b"FCB\x01";

impl FlashcardsStore {
    pub fn new() -> Self {
        Self {
            prompts: HashMap::new(),
            cards: HashMap::new(),
            reviews: Vec::new(),
            file_sync: HashMap::new(),
            next_card_id: 1,
            next_review_id: 1,
        }
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, postcard::Error> {
        let payload = postcard::to_allocvec(self)?;
        let mut out = Vec::with_capacity(MAGIC_V1.len() + payload.len());
        out.extend_from_slice(MAGIC_V1);
        out.extend_from_slice(&payload);
        Ok(out)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, postcard::Error> {
        if bytes.starts_with(MAGIC_V1) {
            postcard::from_bytes(&bytes[MAGIC_V1.len()..])
        } else {
            // Backward-compatible fallback for unversioned v1 snapshots
            postcard::from_bytes(bytes)
        }
    }

    /// Deterministically merges another store into self (e.g. from mobile sync via Syncthing).
    /// Reviews are unioned, card states are resolved by latest review time, and file sync fingerprints are kept current.
    /// Returns true if any updates were merged into self.
    pub fn merge(&mut self, other: FlashcardsStore) -> bool {
        let mut modified = false;

        if other.next_card_id > self.next_card_id {
            self.next_card_id = other.next_card_id;
            modified = true;
        }
        if other.next_review_id > self.next_review_id {
            self.next_review_id = other.next_review_id;
            modified = true;
        }

        // 1. Merge prompts
        for (prompt_id, other_prompt) in other.prompts {
            match self.prompts.get_mut(&prompt_id) {
                Some(existing) => {
                    if other_prompt.updated_at > existing.updated_at {
                        *existing = other_prompt;
                        modified = true;
                    }
                }
                None => {
                    self.prompts.insert(prompt_id, other_prompt);
                    modified = true;
                }
            }
        }

        // 2. Merge cards: correlate semantically by (prompt_id, direction).
        // This prevents ID collisions if both devices independently created cards while offline.
        let mut card_id_remap: HashMap<u32, u32> = HashMap::new();

        for (other_id, mut other_card) in other.cards {
            let existing_id = self
                .cards
                .iter()
                .find(|(_, c)| {
                    c.prompt_id == other_card.prompt_id && c.direction == other_card.direction
                })
                .map(|(&id, _)| id);

            match existing_id {
                Some(matching_id) => {
                    card_id_remap.insert(other_id, matching_id);
                    let existing = self.cards.get_mut(&matching_id).unwrap();
                    let other_last = other_card.last_review.unwrap_or(0);
                    let self_last = existing.last_review.unwrap_or(0);

                    if other_last > self_last
                        || (other_last == self_last && other_card.reps > existing.reps)
                    {
                        other_card.id = matching_id;
                        *existing = other_card;
                        modified = true;
                    }
                }
                None => {
                    let target_id = if !self.cards.contains_key(&other_id) {
                        other_id
                    } else {
                        let new_id = self.next_card_id;
                        self.next_card_id += 1;
                        new_id
                    };
                    card_id_remap.insert(other_id, target_id);
                    other_card.id = target_id;
                    self.cards.insert(target_id, other_card);
                    if target_id >= self.next_card_id {
                        self.next_card_id = target_id + 1;
                    }
                    modified = true;
                }
            }
        }

        // 3. Merge reviews: remap card_id using card_id_remap, deduplicate by (card_id, review_time, rating)
        let mut existing_reviews: HashSet<(u32, i64, Rating)> = self
            .reviews
            .iter()
            .map(|r| (r.card_id, r.review_time, r.rating))
            .collect();

        for mut rev in other.reviews {
            if let Some(&remapped_id) = card_id_remap.get(&rev.card_id) {
                rev.card_id = remapped_id;
            }
            let key = (rev.card_id, rev.review_time, rev.rating);
            if !existing_reviews.contains(&key) {
                existing_reviews.insert(key);
                self.reviews.push(rev);
                modified = true;
            }
        }
        if modified {
            self.reviews.sort_by_key(|r| r.review_time);
            for (idx, r) in self.reviews.iter_mut().enumerate() {
                r.id = (idx + 1) as u32;
            }
            self.next_review_id = (self.reviews.len() + 1) as u32;
        }

        // 4. Merge file sync states
        for (path, other_sync) in other.file_sync {
            match self.file_sync.get_mut(&path) {
                Some(existing) => {
                    if other_sync.modified_at > existing.modified_at {
                        *existing = other_sync;
                        modified = true;
                    }
                }
                None => {
                    self.file_sync.insert(path, other_sync);
                    modified = true;
                }
            }
        }

        modified
    }

    pub fn is_file_unchanged(&self, file_path: &str, mtime: i64, size: u64) -> bool {
        if let Some(state) = self.file_sync.get(file_path) {
            state.modified_at == mtime && state.size == size
        } else {
            false
        }
    }

    pub fn sync_note_prompts(
        &mut self,
        file_path: &str,
        parsed_prompts: Vec<ParsedPrompt>,
        mtime: i64,
        size: u64,
    ) {
        let old_prompt_ids = self
            .file_sync
            .get(file_path)
            .map(|s| s.prompt_ids.clone())
            .unwrap_or_default();

        let new_prompt_ids: Vec<String> = parsed_prompts.iter().map(|p| p.id.clone()).collect();
        let new_ids_set: HashSet<&str> = new_prompt_ids.iter().map(|s| s.as_str()).collect();

        for parsed in parsed_prompts {
            if let Some(prompt) = self.prompts.get_mut(&parsed.id) {
                // Update prompt data
                prompt.file_path = file_path.to_string();
                prompt.card_type = parsed.card_type;
                prompt.front = parsed.front;
                prompt.back = parsed.back;
                prompt.tags = parsed.tags;
                prompt.line_start = parsed.line_start;
                prompt.line_end = parsed.line_end;
                prompt.updated_at = mtime;

                let was_reversible = prompt.reversible;
                prompt.reversible = parsed.reversible;

                // Adjust card materialization if reversibility changed
                let prompt_cards: Vec<u32> = self
                    .cards
                    .iter()
                    .filter(|(_, c)| c.prompt_id == parsed.id)
                    .map(|(&id, _)| id)
                    .collect();

                if parsed.reversible && !was_reversible {
                    // Became reversible: ensure forward card and add reverse card
                    let has_fwd = prompt_cards.iter().any(|&id| {
                        self.cards.get(&id).map(|c| c.direction) == Some(Some(Direction::Forward))
                    });
                    if !has_fwd
                        && let Some(&first_id) = prompt_cards.first()
                        && let Some(c) = self.cards.get_mut(&first_id)
                    {
                        c.direction = Some(Direction::Forward);
                    }

                    let has_rev = prompt_cards.iter().any(|&id| {
                        self.cards.get(&id).map(|c| c.direction) == Some(Some(Direction::Reverse))
                    });
                    if !has_rev {
                        let rev_id = self.next_card_id;
                        self.next_card_id += 1;
                        self.cards.insert(
                            rev_id,
                            Card {
                                id: rev_id,
                                prompt_id: parsed.id.clone(),
                                direction: Some(Direction::Reverse),
                                state: State::New,
                                due_at: 0,
                                stability: 0.0,
                                difficulty: 0.0,
                                reps: 0,
                                lapses: 0,
                                last_review: None,
                                learning_step: 0,
                                relearning_step: 0,
                            },
                        );
                    }
                } else if !parsed.reversible && was_reversible {
                    // Became non-reversible: keep forward/none, delete reverse card
                    for card_id in prompt_cards {
                        if let Some(c) = self.cards.get(&card_id) {
                            if c.direction == Some(Direction::Reverse) {
                                self.cards.remove(&card_id);
                            } else {
                                if let Some(c_mut) = self.cards.get_mut(&card_id) {
                                    c_mut.direction = None;
                                }
                            }
                        }
                    }
                }
            } else {
                // Fresh prompt: insert and materialize cards
                self.prompts.insert(
                    parsed.id.clone(),
                    Prompt {
                        id: parsed.id.clone(),
                        file_path: file_path.to_string(),
                        card_type: parsed.card_type,
                        reversible: parsed.reversible,
                        front: parsed.front,
                        back: parsed.back,
                        tags: parsed.tags,
                        line_start: parsed.line_start,
                        line_end: parsed.line_end,
                        updated_at: mtime,
                    },
                );

                if parsed.reversible {
                    let fwd_id = self.next_card_id;
                    self.next_card_id += 1;
                    self.cards.insert(
                        fwd_id,
                        Card {
                            id: fwd_id,
                            prompt_id: parsed.id.clone(),
                            direction: Some(Direction::Forward),
                            state: State::New,
                            due_at: 0,
                            stability: 0.0,
                            difficulty: 0.0,
                            reps: 0,
                            lapses: 0,
                            last_review: None,
                            learning_step: 0,
                            relearning_step: 0,
                        },
                    );

                    let rev_id = self.next_card_id;
                    self.next_card_id += 1;
                    self.cards.insert(
                        rev_id,
                        Card {
                            id: rev_id,
                            prompt_id: parsed.id.clone(),
                            direction: Some(Direction::Reverse),
                            state: State::New,
                            due_at: 0,
                            stability: 0.0,
                            difficulty: 0.0,
                            reps: 0,
                            lapses: 0,
                            last_review: None,
                            learning_step: 0,
                            relearning_step: 0,
                        },
                    );
                } else {
                    let card_id = self.next_card_id;
                    self.next_card_id += 1;
                    self.cards.insert(
                        card_id,
                        Card {
                            id: card_id,
                            prompt_id: parsed.id.clone(),
                            direction: None,
                            state: State::New,
                            due_at: 0,
                            stability: 0.0,
                            difficulty: 0.0,
                            reps: 0,
                            lapses: 0,
                            last_review: None,
                            learning_step: 0,
                            relearning_step: 0,
                        },
                    );
                }
            }
        }

        // Clean up prompts removed from this file
        for old_id in old_prompt_ids {
            if !new_ids_set.contains(old_id.as_str()) {
                self.prompts.remove(&old_id);
                let to_remove: Vec<u32> = self
                    .cards
                    .iter()
                    .filter(|(_, c)| c.prompt_id == old_id)
                    .map(|(&id, _)| id)
                    .collect();
                for cid in to_remove {
                    self.cards.remove(&cid);
                }
            }
        }

        self.file_sync.insert(
            file_path.to_string(),
            FileSyncState {
                file_path: file_path.to_string(),
                modified_at: mtime,
                size,
                prompt_ids: new_prompt_ids,
            },
        );
    }

    pub fn remove_file(&mut self, file_path: &str) {
        if let Some(state) = self.file_sync.remove(file_path) {
            for prompt_id in state.prompt_ids {
                self.prompts.remove(&prompt_id);
                let to_remove: Vec<u32> = self
                    .cards
                    .iter()
                    .filter(|(_, c)| c.prompt_id == prompt_id)
                    .map(|(&id, _)| id)
                    .collect();
                for cid in to_remove {
                    self.cards.remove(&cid);
                }
            }
        }
    }

    pub fn rename_file(&mut self, old_path: &str, new_path: &str) {
        if let Some(mut state) = self.file_sync.remove(old_path) {
            state.file_path = new_path.to_string();
            for prompt_id in &state.prompt_ids {
                if let Some(prompt) = self.prompts.get_mut(prompt_id) {
                    prompt.file_path = new_path.to_string();
                }
            }
            self.file_sync.insert(new_path.to_string(), state);
        }
    }

    pub fn prune_deleted_files(&mut self, valid_paths: &HashSet<String>) -> usize {
        let stale: Vec<String> = self
            .file_sync
            .keys()
            .filter(|p| !valid_paths.contains(*p))
            .cloned()
            .collect();
        let count = stale.len();
        for path in stale {
            self.remove_file(&path);
        }
        count
    }

    pub fn get_due_cards(
        &self,
        tag_filter: Option<&[String]>,
        now_ms: i64,
        due_cutoff_ms: i64,
    ) -> Vec<ReviewItem> {
        let mut candidates: Vec<(&Card, &Prompt)> = Vec::new();
        let mut seen_prompts: HashSet<String> = HashSet::new();

        for card in self.cards.values() {
            let Some(prompt) = self.prompts.get(&card.prompt_id) else {
                continue;
            };

            // Apply tag filter if specified (matches tag exactly or any sub-tags like tag/subtag)
            if let Some(tags) = tag_filter
                && !tags.is_empty()
            {
                let matches_tags = tags.iter().any(|filter_tag| {
                    let clean_filter = filter_tag.trim_start_matches('#');
                    prompt.tags.iter().any(|t| {
                        let clean_t = t.trim_start_matches('#');
                        clean_t.eq_ignore_ascii_case(clean_filter)
                            || (clean_t.len() > clean_filter.len()
                                && clean_t[..clean_filter.len()].eq_ignore_ascii_case(clean_filter)
                                && clean_t.as_bytes()[clean_filter.len()] == b'/')
                    })
                });
                if !matches_tags {
                    continue;
                }
            }

            // Check if card is due:
            // - New cards are always available
            // - Learning / Relearning cards are only due once their step timer has elapsed (due_at <= now_ms)
            // - Review cards are due if scheduled on or before cutoff (due_at <= due_cutoff_ms)
            let is_due = match card.state {
                State::New => true,
                State::Learning | State::Relearning => card.due_at <= now_ms,
                State::Review => card.due_at <= due_cutoff_ms,
            };
            if is_due {
                candidates.push((card, prompt));
            }
        }

        // Sort candidates:
        // 1. Learning / Relearning cards due earliest
        // 2. Review cards due earliest
        // 3. New cards
        candidates.sort_by(|(a_card, a_prompt), (b_card, b_prompt)| {
            let a_priority = match a_card.state {
                State::Learning | State::Relearning => 0,
                State::Review => 1,
                State::New => 2,
            };
            let b_priority = match b_card.state {
                State::Learning | State::Relearning => 0,
                State::Review => 1,
                State::New => 2,
            };

            if a_priority != b_priority {
                return a_priority.cmp(&b_priority);
            }

            match a_card.state {
                State::New => a_prompt
                    .line_start
                    .cmp(&b_prompt.line_start)
                    .then_with(|| a_card.id.cmp(&b_card.id)),
                _ => a_card.due_at.cmp(&b_card.due_at),
            }
        });

        // Anti-priming / sibling burying: only 1 card per prompt per study session
        let mut result = Vec::new();
        for (card, prompt) in candidates {
            if seen_prompts.insert(prompt.id.clone()) {
                result.push(to_review_item(card, prompt, now_ms));
            }
        }

        result
    }

    pub fn get_all_cards(&self, now_ms: i64) -> Vec<ReviewItem> {
        let mut result = Vec::with_capacity(self.cards.len());
        for card in self.cards.values() {
            if let Some(prompt) = self.prompts.get(&card.prompt_id) {
                result.push(to_review_item(card, prompt, now_ms));
            }
        }
        result
    }

    pub fn record_review(
        &mut self,
        card_id: u32,
        rating: Rating,
        now_ms: i64,
        params: &FsrsParams,
    ) -> Option<ReviewItem> {
        let card = self.cards.get(&card_id)?;
        let sched_card = SchedulingCard {
            stability: card.stability,
            difficulty: card.difficulty,
            reps: card.reps,
            lapses: card.lapses,
            learning_step: card.learning_step,
            relearning_step: card.relearning_step,
            state: card.state,
            last_review: card.last_review,
            due: card.due_at,
        };

        let engine = FsrsEngine::new(params.clone());
        let info = engine.schedule(&sched_card, now_ms);
        let candidate = info.next_states.into_iter().find(|c| c.rating == rating)?;

        let elapsed_days = if let Some(last) = card.last_review {
            ((now_ms - last).max(0) as f64) / DAY_MS as f64
        } else {
            0.0
        };

        // Record immutable review log
        let log_id = self.next_review_id;
        self.next_review_id += 1;
        self.reviews.push(ReviewLog {
            id: log_id,
            card_id,
            rating,
            review_time: now_ms,
            elapsed_days,
            scheduled_days: candidate.interval_days,
            state: card.state,
            due_at: card.due_at,
            stability: card.stability,
            difficulty: card.difficulty,
            learning_step: card.learning_step,
            relearning_step: card.relearning_step,
        });

        // Mutate card with new scheduling state
        let card_mut = self.cards.get_mut(&card_id)?;
        card_mut.stability = candidate.card.stability;
        card_mut.difficulty = candidate.card.difficulty;
        card_mut.reps = candidate.card.reps;
        card_mut.lapses = candidate.card.lapses;
        card_mut.learning_step = candidate.card.learning_step;
        card_mut.relearning_step = candidate.card.relearning_step;
        card_mut.state = candidate.card.state;
        card_mut.last_review = Some(now_ms);
        card_mut.due_at = candidate.card.due;

        let prompt = self.prompts.get(&card_mut.prompt_id)?;
        Some(to_review_item(card_mut, prompt, now_ms))
    }

    pub fn undo_last_review(&mut self, now_ms: i64) -> Option<ReviewItem> {
        let last_log = self.reviews.pop()?;
        let card = self.cards.get_mut(&last_log.card_id)?;

        card.state = last_log.state;
        card.stability = last_log.stability;
        card.difficulty = last_log.difficulty;
        card.due_at = last_log.due_at;
        card.learning_step = last_log.learning_step;
        card.relearning_step = last_log.relearning_step;
        card.reps = card.reps.saturating_sub(1);
        if last_log.rating == Rating::Again && last_log.state == State::Review {
            card.lapses = card.lapses.saturating_sub(1);
        }

        // Find previous review time for this card if any
        let prev_review = self
            .reviews
            .iter()
            .rfind(|r| r.card_id == last_log.card_id)
            .map(|r| r.review_time);
        card.last_review = prev_review;

        let prompt = self.prompts.get(&card.prompt_id)?;
        Some(to_review_item(card, prompt, now_ms))
    }

    pub fn get_dashboard_stats(&self, now_ms: i64, due_cutoff_ms: i64) -> DashboardStats {
        let total_cards = self.cards.len() as u32;
        let mut new_cards = 0u32;
        let mut due_today = 0u32;

        for card in self.cards.values() {
            if card.state == State::New {
                new_cards += 1;
            } else {
                let is_due = match card.state {
                    State::Learning | State::Relearning => card.due_at <= now_ms,
                    State::Review => card.due_at <= due_cutoff_ms,
                    State::New => unreachable!(),
                };
                if is_due {
                    due_today += 1;
                }
            }
        }

        let today_start = due_cutoff_ms - DAY_MS;
        let mut studied_today = 0u32;
        let mut remembered_today = 0u32;

        for log in &self.reviews {
            if log.review_time >= today_start && log.review_time <= due_cutoff_ms {
                studied_today += 1;
                if log.rating != Rating::Again {
                    remembered_today += 1;
                }
            }
        }

        let daily_retention = if studied_today > 0 {
            ((remembered_today as f64 / studied_today as f64) * 100.0).round() as u32
        } else {
            100
        };

        // Calculate study streak (consecutive days with at least 1 review)
        let mut study_days: HashSet<i64> = HashSet::new();
        for log in &self.reviews {
            let day = (log.review_time + DAY_MS - due_cutoff_ms % DAY_MS) / DAY_MS;
            study_days.insert(day);
        }

        let current_day = (now_ms + DAY_MS - due_cutoff_ms % DAY_MS) / DAY_MS;
        let mut streak = 0u32;
        let mut check_day = if study_days.contains(&current_day) {
            current_day
        } else {
            current_day - 1
        };

        while study_days.contains(&check_day) {
            streak += 1;
            check_day -= 1;
        }

        DashboardStats {
            studied_today,
            daily_retention,
            study_streak: streak,
            total_cards,
            due_today,
            new_cards,
        }
    }

    pub fn get_upcoming_due_counts(
        &self,
        days: usize,
        _now_ms: i64,
        due_cutoff_ms: i64,
    ) -> Vec<u32> {
        let mut counts = vec![0u32; days];
        for card in self.cards.values() {
            if card.state == State::New {
                continue;
            }
            if card.due_at <= due_cutoff_ms {
                if !counts.is_empty() {
                    counts[0] += 1;
                }
            } else {
                let diff = card.due_at - due_cutoff_ms;
                let day_offset = ((diff as f64) / DAY_MS as f64).ceil() as usize;
                if day_offset < days {
                    counts[day_offset] += 1;
                }
            }
        }
        counts
    }

    pub fn get_sibling_card(&self, card_id: u32, prompt_id: &str) -> Option<Card> {
        self.cards
            .values()
            .find(|c| c.prompt_id == prompt_id && c.id != card_id)
            .cloned()
    }
}

fn expand_hierarchical_tags(tags: &[String]) -> HashSet<String> {
    let mut expanded = HashSet::new();
    for tag in tags {
        let clean = tag.trim_start_matches('#');
        let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty()).collect();
        let mut current = String::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                current.push('/');
            }
            current.push_str(part);
            expanded.insert(current.clone());
        }
    }
    expanded
}

impl FlashcardsStore {
    pub fn get_tag_deck_stats(&self, now_ms: i64, due_cutoff_ms: i64) -> Vec<TagDeckStats> {
        let mut tag_totals: HashMap<String, u32> = HashMap::new();
        let mut tag_dues: HashMap<String, u32> = HashMap::new();
        let mut tag_news: HashMap<String, u32> = HashMap::new();

        for card in self.cards.values() {
            let Some(prompt) = self.prompts.get(&card.prompt_id) else {
                continue;
            };
            let is_new = card.state == State::New;
            let is_due = match card.state {
                State::New => false,
                State::Learning | State::Relearning => card.due_at <= now_ms,
                State::Review => card.due_at <= due_cutoff_ms,
            };

            let expanded_tags = expand_hierarchical_tags(&prompt.tags);
            for norm in expanded_tags {
                *tag_totals.entry(norm.clone()).or_insert(0) += 1;
                if is_due {
                    *tag_dues.entry(norm.clone()).or_insert(0) += 1;
                }
                if is_new {
                    *tag_news.entry(norm).or_insert(0) += 1;
                }
            }
        }

        let mut stats: Vec<TagDeckStats> = tag_totals
            .into_iter()
            .map(|(tag, total_cards)| {
                let due_cards = tag_dues.get(&tag).copied().unwrap_or(0);
                let new_cards = tag_news.get(&tag).copied().unwrap_or(0);
                TagDeckStats {
                    tag,
                    total_cards,
                    due_cards,
                    new_cards,
                }
            })
            .collect();

        stats.sort_by(|a, b| a.tag.cmp(&b.tag));
        stats
    }

    pub fn get_review_logs(&self) -> Vec<ReviewLogEntry> {
        self.reviews
            .iter()
            .map(|r| ReviewLogEntry {
                card_id: r.card_id.to_string(),
                rating: r.rating as u8,
                delta_t: r.elapsed_days,
            })
            .collect()
    }
}

fn to_review_item(card: &Card, prompt: &Prompt, now_ms: i64) -> ReviewItem {
    let note_title = std::path::Path::new(&prompt.file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&prompt.file_path)
        .to_string();

    let (front, back) = match card.direction {
        Some(Direction::Reverse) => (prompt.back.clone(), prompt.front.clone()),
        _ => (prompt.front.clone(), prompt.back.clone()),
    };

    let due_human = if card.state == State::New {
        "New".to_string()
    } else if card.due_at <= now_ms {
        let overdue_days = ((now_ms - card.due_at) as f64 / DAY_MS as f64).floor() as i64;
        if overdue_days <= 0 {
            "Due now".to_string()
        } else {
            format!("Overdue ({overdue_days}d)")
        }
    } else {
        let diff_ms = card.due_at - now_ms;
        if diff_ms < 60_000 {
            "In <1m".to_string()
        } else if diff_ms < 3_600_000 {
            let mins = (diff_ms as f64 / 60_000.0).round().max(1.0) as i64;
            format!("In {mins}m")
        } else if diff_ms < DAY_MS {
            let hours = (diff_ms as f64 / 3_600_000.0).round().max(1.0) as i64;
            if hours <= 1 {
                "In 1h".to_string()
            } else if hours < 24 {
                format!("In {hours}h")
            } else {
                "Tomorrow".to_string()
            }
        } else {
            let in_days = (diff_ms as f64 / DAY_MS as f64).round().max(1.0) as i64;
            if in_days <= 1 {
                "Tomorrow".to_string()
            } else {
                format!("In {in_days}d")
            }
        }
    };

    let last_practiced_human = if let Some(last) = card.last_review {
        let diff_ms = (now_ms - last).max(0);
        if diff_ms < 60_000 {
            "Just now".to_string()
        } else if diff_ms < 3_600_000 {
            let mins = (diff_ms as f64 / 60_000.0).round().max(1.0) as i64;
            format!("{mins}m ago")
        } else if diff_ms < DAY_MS {
            let hours = (diff_ms as f64 / 3_600_000.0).round().max(1.0) as i64;
            if hours <= 1 {
                "1h ago".to_string()
            } else if hours < 24 {
                format!("{hours}h ago")
            } else {
                "Yesterday".to_string()
            }
        } else {
            let diff_days = (diff_ms as f64 / DAY_MS as f64).round().max(1.0) as i64;
            if diff_days <= 1 {
                "Yesterday".to_string()
            } else {
                format!("{diff_days}d ago")
            }
        }
    } else {
        "Never".to_string()
    };

    ReviewItem {
        card_id: card.id,
        prompt_id: prompt.id.clone(),
        note_title,
        note_path: prompt.file_path.clone(),
        direction: card.direction,
        card_type: prompt.card_type,
        reversible: prompt.reversible,
        front,
        back,
        tags: prompt.tags.clone(),
        state: card.state,
        state_num: card.state.as_u8(),
        due_at: card.due_at,
        due_human,
        stability: card.stability,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
        learning_step: card.learning_step,
        relearning_step: card.relearning_step,
        last_review: card.last_review,
        last_practiced_human,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CardType;

    #[test]
    fn test_store_serialization_roundtrip() {
        let mut store = FlashcardsStore::new();
        store.sync_note_prompts(
            "Notes/Test.md",
            vec![
                ParsedPrompt {
                    id: "000001".to_string(),
                    card_type: CardType::Inline,
                    reversible: false,
                    front: "Capital of France".to_string(),
                    back: "Paris".to_string(),
                    tags: vec!["geography".to_string()],
                    line_start: 1,
                    line_end: 1,
                },
                ParsedPrompt {
                    id: "000002".to_string(),
                    card_type: CardType::Inline,
                    reversible: true,
                    front: "Bonjour".to_string(),
                    back: "Hello".to_string(),
                    tags: vec!["french".to_string()],
                    line_start: 3,
                    line_end: 3,
                },
            ],
            1700000000,
            120,
        );

        assert_eq!(store.prompts.len(), 2);
        assert_eq!(store.cards.len(), 3); // 1 for non-reversible, 2 for reversible

        let bytes = store.to_bytes().expect("Serialization should succeed");
        assert!(bytes.starts_with(b"FCB\x01"));

        // Roundtrip with magic header
        let restored = FlashcardsStore::from_bytes(&bytes).expect("Deserialization should succeed");
        assert_eq!(restored.prompts.len(), 2);
        assert_eq!(restored.cards.len(), 3);
        assert_eq!(restored.file_sync.len(), 1);

        // Backward-compatible fallback for unversioned bytes
        let raw_payload = &bytes[4..];
        let restored_legacy = FlashcardsStore::from_bytes(raw_payload)
            .expect("Legacy unversioned deserialization should succeed");
        assert_eq!(restored_legacy.prompts.len(), 2);
        assert_eq!(restored_legacy.cards.len(), 3);
    }

    #[test]
    fn test_store_reversibility_change() {
        let mut store = FlashcardsStore::new();
        store.sync_note_prompts(
            "Notes/Test.md",
            vec![ParsedPrompt {
                id: "000001".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Q".to_string(),
                back: "A".to_string(),
                tags: vec![],
                line_start: 1,
                line_end: 1,
            }],
            100,
            10,
        );
        assert_eq!(store.cards.len(), 1);

        // Turn into reversible
        store.sync_note_prompts(
            "Notes/Test.md",
            vec![ParsedPrompt {
                id: "000001".to_string(),
                card_type: CardType::Inline,
                reversible: true,
                front: "Q".to_string(),
                back: "A".to_string(),
                tags: vec![],
                line_start: 1,
                line_end: 1,
            }],
            200,
            12,
        );
        assert_eq!(store.cards.len(), 2);

        // Turn back into non-reversible
        store.sync_note_prompts(
            "Notes/Test.md",
            vec![ParsedPrompt {
                id: "000001".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Q".to_string(),
                back: "A".to_string(),
                tags: vec![],
                line_start: 1,
                line_end: 1,
            }],
            300,
            10,
        );
        assert_eq!(store.cards.len(), 1);
    }

    #[test]
    fn test_store_review_and_undo() {
        let mut store = FlashcardsStore::new();
        store.sync_note_prompts(
            "Notes/Test.md",
            vec![ParsedPrompt {
                id: "000001".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Question".to_string(),
                back: "Answer".to_string(),
                tags: vec![],
                line_start: 1,
                line_end: 1,
            }],
            100,
            10,
        );

        let card_id = *store.cards.keys().next().unwrap();
        let params = FsrsParams::default();

        let updated = store.record_review(card_id, Rating::Good, 1700000000000, &params);
        assert!(updated.is_some());
        assert_eq!(store.reviews.len(), 1);
        let card = store.cards.get(&card_id).unwrap();
        assert_eq!(card.reps, 1);
        assert_eq!(card.state, State::Review);

        let undone = store.undo_last_review(1700000000000);
        assert!(undone.is_some());
        assert_eq!(undone.unwrap().card_id, card_id);
        assert_eq!(store.reviews.len(), 0);
        let card = store.cards.get(&card_id).unwrap();
        assert_eq!(card.reps, 0);
        assert_eq!(card.state, State::New);
    }

    #[test]
    fn test_store_multi_device_merge() {
        let mut desktop_store = FlashcardsStore::new();
        desktop_store.sync_note_prompts(
            "Note.md",
            vec![ParsedPrompt {
                id: "k9x2mp".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Q1".to_string(),
                back: "A1".to_string(),
                tags: vec![],
                line_start: 0,
                line_end: 0,
            }],
            100,
            10,
        );

        // Mobile starts with copy of desktop
        let mut mobile_store = desktop_store.clone();

        // Mobile reviews card at t = 1000
        let card_id = *mobile_store.cards.keys().next().unwrap();
        let params = FsrsParams::default();
        mobile_store.record_review(card_id, Rating::Good, 1000, &params);
        assert_eq!(mobile_store.reviews.len(), 1);
        assert_eq!(desktop_store.reviews.len(), 0);

        // Desktop also has a different note added while mobile was away
        desktop_store.sync_note_prompts(
            "Note2.md",
            vec![ParsedPrompt {
                id: "w7n3rk".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Q2".to_string(),
                back: "A2".to_string(),
                tags: vec![],
                line_start: 0,
                line_end: 0,
            }],
            200,
            20,
        );

        // Syncthing merges mobile into desktop
        let merged = desktop_store.merge(mobile_store);
        assert!(merged);

        // Desktop now has the review and updated card state
        assert_eq!(desktop_store.reviews.len(), 1);
        assert_eq!(desktop_store.reviews[0].review_time, 1000);
        let card1 = desktop_store.cards.get(&card_id).unwrap();
        assert_eq!(card1.reps, 1);
        assert_eq!(card1.last_review, Some(1000));

        // Desktop also retained its Note2 prompt and card
        assert_eq!(desktop_store.prompts.len(), 2);
        assert_eq!(desktop_store.cards.len(), 2);
    }

    #[test]
    fn test_store_multi_device_concurrent_card_creation_no_collision() {
        // Desktop creates a fresh card while offline (gets card_id = 1)
        let mut desktop_store = FlashcardsStore::new();
        desktop_store.sync_note_prompts(
            "DesktopNote.md",
            vec![ParsedPrompt {
                id: "desk01".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Desktop Q".to_string(),
                back: "Desktop A".to_string(),
                tags: vec![],
                line_start: 0,
                line_end: 0,
            }],
            100,
            10,
        );
        assert_eq!(desktop_store.cards.len(), 1);
        assert!(desktop_store.cards.contains_key(&1));

        // Mobile also creates a fresh card independently while offline (also gets card_id = 1)
        let mut mobile_store = FlashcardsStore::new();
        mobile_store.sync_note_prompts(
            "MobileNote.md",
            vec![ParsedPrompt {
                id: "mobi01".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Mobile Q".to_string(),
                back: "Mobile A".to_string(),
                tags: vec![],
                line_start: 0,
                line_end: 0,
            }],
            100,
            10,
        );
        assert_eq!(mobile_store.cards.len(), 1);
        assert!(mobile_store.cards.contains_key(&1));

        // Mobile reviews its card
        let params = FsrsParams::default();
        mobile_store.record_review(1, Rating::Good, 5000, &params);
        assert_eq!(mobile_store.reviews.len(), 1);
        assert_eq!(mobile_store.reviews[0].card_id, 1);

        // Merge mobile into desktop
        let merged = desktop_store.merge(mobile_store);
        assert!(merged);

        // Both cards must exist with distinct IDs!
        assert_eq!(desktop_store.cards.len(), 2);
        assert_eq!(desktop_store.prompts.len(), 2);

        let desk_card = desktop_store
            .cards
            .values()
            .find(|c| c.prompt_id == "desk01")
            .expect("Desktop card must be preserved");
        let mobi_card = desktop_store
            .cards
            .values()
            .find(|c| c.prompt_id == "mobi01")
            .expect("Mobile card must be preserved");

        assert_ne!(desk_card.id, mobi_card.id);
        assert_eq!(mobi_card.reps, 1);
        assert_eq!(mobi_card.last_review, Some(5000));

        // Review log must have been remapped to mobi_card's new ID!
        assert_eq!(desktop_store.reviews.len(), 1);
        assert_eq!(desktop_store.reviews[0].card_id, mobi_card.id);
    }

    #[test]
    fn test_hierarchical_tag_deck_stats_and_filtering() {
        let mut store = FlashcardsStore::default();
        store.sync_note_prompts(
            "German.md",
            vec![ParsedPrompt {
                id: "p_de".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Hund".to_string(),
                back: "Dog".to_string(),
                tags: vec!["#language/german".to_string()],
                line_start: 0,
                line_end: 0,
            }],
            100,
            10,
        );
        store.sync_note_prompts(
            "French.md",
            vec![ParsedPrompt {
                id: "p_fr".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Chien".to_string(),
                back: "Dog".to_string(),
                tags: vec!["#language/french".to_string(), "#language".to_string()],
                line_start: 0,
                line_end: 0,
            }],
            200,
            10,
        );
        store.sync_note_prompts(
            "Math.md",
            vec![ParsedPrompt {
                id: "p_ma".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "2+2".to_string(),
                back: "4".to_string(),
                tags: vec!["#math".to_string()],
                line_start: 0,
                line_end: 0,
            }],
            300,
            10,
        );

        // All 3 cards are New
        let stats = store.get_tag_deck_stats(1000, 1000);
        let tag_map: HashMap<String, TagDeckStats> =
            stats.into_iter().map(|s| (s.tag.clone(), s)).collect();

        // language parent deck must aggregate german + french (2 cards total, french only counted once even with duplicate #language)
        let lang = tag_map.get("language").expect("language parent must exist");
        assert_eq!(lang.total_cards, 2);
        assert_eq!(lang.new_cards, 2);

        let de = tag_map
            .get("language/german")
            .expect("language/german must exist");
        assert_eq!(de.total_cards, 1);

        let fr = tag_map
            .get("language/french")
            .expect("language/french must exist");
        assert_eq!(fr.total_cards, 1);

        let math = tag_map.get("math").expect("math must exist");
        assert_eq!(math.total_cards, 1);

        // Test tag filtering: selecting "language" returns both German and French cards
        let lang_due = store.get_due_cards(Some(&["language".to_string()]), 1000, 1000);
        assert_eq!(lang_due.len(), 2);

        // Selecting "language/german" returns only German card
        let de_due = store.get_due_cards(Some(&["language/german".to_string()]), 1000, 1000);
        assert_eq!(de_due.len(), 1);
        assert_eq!(de_due[0].front, "Hund");

        // Selecting "math" returns only Math card
        let math_due = store.get_due_cards(Some(&["math".to_string()]), 1000, 1000);
        assert_eq!(math_due.len(), 1);
        assert_eq!(math_due[0].front, "2+2");
    }

    #[test]
    fn test_due_human_formatting() {
        let now_ms = 1_000_000_000;
        let prompt = Prompt {
            id: "p1".to_string(),
            file_path: "Note.md".to_string(),
            card_type: CardType::Inline,
            reversible: false,
            front: "Q".to_string(),
            back: "A".to_string(),
            tags: vec![],
            line_start: 0,
            line_end: 0,
            updated_at: now_ms,
        };

        let make_card = |state: State, due_at: i64, last_review: Option<i64>| Card {
            id: 1,
            prompt_id: "p1".to_string(),
            direction: None,
            stability: 2.0,
            difficulty: 5.0,
            reps: 1,
            lapses: 0,
            learning_step: 0,
            relearning_step: 0,
            state,
            last_review,
            due_at,
        };

        // 1. New card
        let card_new = make_card(State::New, 0, None);
        assert_eq!(to_review_item(&card_new, &prompt, now_ms).due_human, "New");

        // 2. Due now (due 5 minutes ago)
        let card_due_now = make_card(State::Review, now_ms - 300_000, Some(now_ms - 86_400_000));
        assert_eq!(to_review_item(&card_due_now, &prompt, now_ms).due_human, "Due now");

        // 3. Overdue (2 days ago)
        let card_overdue = make_card(State::Review, now_ms - 2 * DAY_MS, Some(now_ms - 3 * DAY_MS));
        assert_eq!(to_review_item(&card_overdue, &prompt, now_ms).due_human, "Overdue (2d)");

        // 4. In 30 seconds (<1m)
        let card_under_1m = make_card(State::Learning, now_ms + 30_000, Some(now_ms));
        assert_eq!(to_review_item(&card_under_1m, &prompt, now_ms).due_human, "In <1m");

        // 5. In 10 minutes
        let card_10m = make_card(State::Learning, now_ms + 600_000, Some(now_ms));
        assert_eq!(to_review_item(&card_10m, &prompt, now_ms).due_human, "In 10m");

        // 6. In 2 hours
        let card_2h = make_card(State::Learning, now_ms + 7_200_000, Some(now_ms));
        assert_eq!(to_review_item(&card_2h, &prompt, now_ms).due_human, "In 2h");

        // 7. In 1 day (Tomorrow)
        let card_tomorrow = make_card(State::Review, now_ms + DAY_MS, Some(now_ms));
        assert_eq!(to_review_item(&card_tomorrow, &prompt, now_ms).due_human, "Tomorrow");

        // 8. In 5 days
        let card_5d = make_card(State::Review, now_ms + 5 * DAY_MS, Some(now_ms));
        assert_eq!(to_review_item(&card_5d, &prompt, now_ms).due_human, "In 5d");
    }

    #[test]
    fn test_learning_card_queue_and_stats() {
        let mut store = FlashcardsStore::default();
        store.sync_note_prompts(
            "Test.md",
            vec![ParsedPrompt {
                id: "p_test".to_string(),
                card_type: CardType::Inline,
                reversible: false,
                front: "Q".to_string(),
                back: "A".to_string(),
                tags: vec!["#testing".to_string()],
                line_start: 0,
                line_end: 0,
            }],
            100,
            10,
        );

        let now_ms = 1_000_000_000;
        let due_cutoff_ms = now_ms + 14 * 3_600_000; // 14 hours in future (e.g. 4am tomorrow)
        let card_id = *store.cards.keys().next().unwrap();

        // 1. Initial state: card is New, due in get_due_cards
        let initial_due = store.get_due_cards(None, now_ms, due_cutoff_ms);
        assert_eq!(initial_due.len(), 1);
        assert_eq!(initial_due[0].due_human, "New");

        // 2. User reviews and marks "Forgot" (Again)
        let params = FsrsParams::default();
        let reviewed = store.record_review(card_id, Rating::Again, now_ms, &params).unwrap();
        assert_eq!(reviewed.state, State::Learning);
        // Due in 10 minutes (600,000 ms)
        assert_eq!(reviewed.due_human, "In 10m");

        // 3. Immediately after rating: step has NOT elapsed!
        // It must NOT appear in get_due_cards, even though due_at <= due_cutoff_ms!
        let due_immediate = store.get_due_cards(None, now_ms, due_cutoff_ms);
        assert_eq!(due_immediate.len(), 0);

        let stats_immediate = store.get_dashboard_stats(now_ms, due_cutoff_ms);
        assert_eq!(stats_immediate.due_today, 0);

        let tag_stats_immediate = store.get_tag_deck_stats(now_ms, due_cutoff_ms);
        assert_eq!(tag_stats_immediate[0].due_cards, 0);

        // 4. 5 minutes later: still not due
        let five_mins_later = now_ms + 300_000;
        let due_5m = store.get_due_cards(None, five_mins_later, due_cutoff_ms);
        assert_eq!(due_5m.len(), 0);

        // 5. 10 minutes later (step elapsed): card is now due!
        let ten_mins_later = now_ms + 600_000;
        let due_10m = store.get_due_cards(None, ten_mins_later, due_cutoff_ms);
        assert_eq!(due_10m.len(), 1);
        assert_eq!(due_10m[0].due_human, "Due now");

        let stats_10m = store.get_dashboard_stats(ten_mins_later, due_cutoff_ms);
        assert_eq!(stats_10m.due_today, 1);

        let tag_stats_10m = store.get_tag_deck_stats(ten_mins_later, due_cutoff_ms);
        assert_eq!(tag_stats_10m[0].due_cards, 1);
    }
}
