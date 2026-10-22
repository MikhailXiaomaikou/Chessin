//! The `cards` and `card_logs` tables: the training cards of the mistake
//! notebook (`src/chessin/notebook/cards.ts`) and their review log.
//!
//! The FSRS scheduling stays in TypeScript: the `fsrs` column holds the
//! ts-fsrs `Card` as opaque JSON and `due` mirrors its due date so that the
//! store can order and count without parsing it. A card is `new` when it has
//! never been graded, that is when it has no `card_logs` row (see
//! [`Library::card_stats`]).

use rusqlite::{params, OptionalExtension};

use super::{Error, Library};

/// Milliseconds in a day, the unit of [`Library::card_stats`]'s "today".
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// One row of `cards`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct CardRecord {
    /// `fm:<epd>` for a find-the-move card, `rp:<epd>` for a repertoire one.
    pub id: String,
    /// The position as an EPD (FEN without the move counters).
    pub epd: String,
    /// `find_move`, `repertoire`, …
    pub kind: String,
    /// The accepted answer(s), as the frontend encodes them (a JSON array of
    /// UCI moves).
    pub answer: String,
    /// JSON describing where the card came from (game, ply); `None` when
    /// unknown.
    pub source: Option<String>,
    /// Unix milliseconds: when the card is due for review.
    pub due: i64,
    /// JSON of the ts-fsrs `Card`, opaque to the store.
    pub fsrs: String,
    /// JSON (played move, player colour, explanation ids, …), opaque to the
    /// store.
    pub meta: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// What [`Library::card_stats`] counts, as of a given `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, specta::Type)]
pub struct CardStats {
    pub total: u32,
    /// Cards with `due <= now`, new ones included.
    pub due: u32,
    /// Cards that were never graded (no `card_logs` row).
    pub new: u32,
    /// Distinct cards graded during the UTC calendar day that contains `now`.
    pub reviewed_today: u32,
}

/// One row of `card_logs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardLog {
    pub id: i64,
    pub card_id: String,
    /// Unix milliseconds.
    pub reviewed_at: i64,
    /// The FSRS rating: 1 again, 2 hard, 3 good, 4 easy.
    pub rating: u32,
    /// JSON of the ts-fsrs `ReviewLog`, opaque to the store.
    pub log: String,
}

const COLUMNS: &str = "id, epd, kind, answer, source, due, fsrs, meta, created_at, updated_at";

fn read_card(r: &rusqlite::Row<'_>) -> rusqlite::Result<CardRecord> {
    Ok(CardRecord {
        id: r.get(0)?,
        epd: r.get(1)?,
        kind: r.get(2)?,
        answer: r.get(3)?,
        source: r.get(4)?,
        due: r.get(5)?,
        fsrs: r.get(6)?,
        meta: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

/// Start of the UTC calendar day that contains `now_ms`.
///
/// The local day would need the user's time zone, which the store does not
/// know; UTC keeps the count deterministic. For a user east of UTC the count
/// therefore rolls over at `00:00 UTC` (08:00 in China) rather than at local
/// midnight.
fn utc_day_start(now_ms: i64) -> i64 {
    now_ms - now_ms.rem_euclid(DAY_MS)
}

impl Library {
    /// Inserts or replaces the cards in one transaction, every column included
    /// (the frontend merges an existing card before writing it back). The
    /// review log of an existing card is kept.
    pub fn card_upsert(&mut self, cards: &[CardRecord]) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO cards (id, epd, kind, answer, source, due, fsrs, meta, created_at,
                     updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (id) DO UPDATE SET epd = excluded.epd, kind = excluded.kind,
                     answer = excluded.answer, source = excluded.source, due = excluded.due,
                     fsrs = excluded.fsrs, meta = excluded.meta,
                     created_at = excluded.created_at, updated_at = excluded.updated_at",
            )?;
            for c in cards {
                stmt.execute(params![
                    c.id,
                    c.epd,
                    c.kind,
                    c.answer,
                    c.source,
                    c.due,
                    c.fsrs,
                    c.meta,
                    c.created_at,
                    c.updated_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Up to `limit` cards due at or before `due_before` (every card when
    /// `None`), soonest due first (ties: oldest created, then id). A `limit`
    /// of 0 returns nothing.
    pub fn card_list(&self, due_before: Option<i64>, limit: u32) -> Result<Vec<CardRecord>, Error> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM cards WHERE ?1 IS NULL OR due <= ?1
             ORDER BY due, created_at, id LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![due_before, i64::from(limit)], read_card)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn card_get(&self, id: &str) -> Result<Option<CardRecord>, Error> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM cards WHERE id = ?1"),
                [id],
                read_card,
            )
            .optional()?)
    }

    /// Deletes the card and its review log; a missing card is not an error.
    pub fn card_delete(&mut self, id: &str) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM card_logs WHERE card_id = ?1", [id])?;
        tx.execute("DELETE FROM cards WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Appends a review of `card_id` (`log` is the ts-fsrs `ReviewLog` as JSON)
    /// and returns the row id. The card must exist.
    pub fn card_log(
        &self,
        card_id: &str,
        reviewed_at: i64,
        rating: u32,
        log: &str,
    ) -> Result<i64, Error> {
        let exists: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM cards WHERE id = ?1", [card_id], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(Error::NoSuchCard {
                id: card_id.to_string(),
            });
        }
        self.conn.execute(
            "INSERT INTO card_logs (card_id, reviewed_at, rating, log) VALUES (?1, ?2, ?3, ?4)",
            params![card_id, reviewed_at, rating, log],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The reviews of a card, newest first.
    pub fn card_logs(&self, card_id: &str) -> Result<Vec<CardLog>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, card_id, reviewed_at, rating, log FROM card_logs
             WHERE card_id = ?1 ORDER BY reviewed_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([card_id], |r| {
            Ok(CardLog {
                id: r.get(0)?,
                card_id: r.get(1)?,
                reviewed_at: r.get(2)?,
                rating: r.get(3)?,
                log: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Counts the cards as of `now` (Unix milliseconds): all of them, the due
    /// ones (`due <= now`), the new ones (never graded: no `card_logs` row; the
    /// FSRS JSON is not consulted) and the distinct cards graded "today", the
    /// UTC calendar day containing `now` (see `utc_day_start`).
    pub fn card_stats(&self, now: i64) -> Result<CardStats, Error> {
        let (total, due, new): (u32, u32, u32) = self.conn.query_row(
            "SELECT COUNT(*), COUNT(CASE WHEN due <= ?1 THEN 1 END),
                 COUNT(CASE WHEN NOT EXISTS (
                     SELECT 1 FROM card_logs WHERE card_logs.card_id = cards.id) THEN 1 END)
             FROM cards",
            [now],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let day_start = utc_day_start(now);
        let reviewed_today: u32 = self.conn.query_row(
            "SELECT COUNT(DISTINCT card_id) FROM card_logs
             WHERE reviewed_at >= ?1 AND reviewed_at < ?2",
            [day_start, day_start.saturating_add(DAY_MS)],
            |r| r.get(0),
        )?;
        Ok(CardStats {
            total,
            due,
            new,
            reviewed_today,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, due: i64) -> CardRecord {
        CardRecord {
            id: id.to_string(),
            epd: format!("epd of {id}"),
            kind: "find_move".to_string(),
            answer: "[\"e2e4\"]".to_string(),
            source: Some("{\"gameKey\":\"file:/a.pgn#1\",\"ply\":12}".to_string()),
            due,
            fsrs: "{\"state\":0,\"reps\":0}".to_string(),
            meta: "{}".to_string(),
            created_at: due,
            updated_at: due,
        }
    }

    fn ids(cards: &[CardRecord]) -> Vec<&str> {
        cards.iter().map(|c| c.id.as_str()).collect()
    }

    fn stats(total: u32, due: u32, new: u32, reviewed_today: u32) -> CardStats {
        CardStats {
            total,
            due,
            new,
            reviewed_today,
        }
    }

    #[test]
    fn upsert_get_and_delete_round_trip_every_column() {
        let mut lib = Library::open_in_memory().unwrap();
        assert_eq!(lib.card_get("fm:x").unwrap(), None);

        let first = card("fm:x", 1_000);
        lib.card_upsert(std::slice::from_ref(&first)).unwrap();
        assert_eq!(lib.card_get("fm:x").unwrap(), Some(first.clone()));

        // A second upsert replaces every column and keeps the review log.
        lib.card_log("fm:x", 1_500, 3, "{\"rating\":3}").unwrap();
        let updated = CardRecord {
            kind: "repertoire".to_string(),
            answer: "[\"d2d4\",\"c2c4\"]".to_string(),
            source: None,
            due: 9_000,
            fsrs: "{\"state\":2,\"reps\":1}".to_string(),
            meta: "{\"san\":\"d4\"}".to_string(),
            updated_at: 1_500,
            ..first
        };
        lib.card_upsert(std::slice::from_ref(&updated)).unwrap();
        assert_eq!(lib.card_get("fm:x").unwrap(), Some(updated));
        assert_eq!(lib.card_logs("fm:x").unwrap().len(), 1);
        assert_eq!(lib.card_list(None, 10).unwrap().len(), 1);

        lib.card_delete("fm:x").unwrap();
        assert_eq!(lib.card_get("fm:x").unwrap(), None);
        assert!(
            lib.card_logs("fm:x").unwrap().is_empty(),
            "logs go with the card"
        );
        // Deleting a missing card is fine; an empty upsert too.
        lib.card_delete("fm:x").unwrap();
        lib.card_upsert(&[]).unwrap();
    }

    #[test]
    fn list_orders_by_due_and_filters_with_due_before_and_limit() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.card_upsert(&[
            card("c", 3_000),
            card("a", 1_000),
            // Same due as "a" but created later: after it.
            CardRecord {
                created_at: 2_000,
                ..card("a2", 1_000)
            },
            card("b", 2_000),
            card("d", 4_000),
        ])
        .unwrap();

        assert_eq!(
            ids(&lib.card_list(None, 100).unwrap()),
            ["a", "a2", "b", "c", "d"]
        );
        assert_eq!(ids(&lib.card_list(None, 2).unwrap()), ["a", "a2"]);
        assert!(lib.card_list(None, 0).unwrap().is_empty());
        assert_eq!(
            ids(&lib.card_list(Some(2_000), 100).unwrap()),
            ["a", "a2", "b"],
            "due_before is inclusive"
        );
        assert_eq!(ids(&lib.card_list(Some(1_999), 100).unwrap()), ["a", "a2"]);
        assert_eq!(ids(&lib.card_list(Some(3_000), 1).unwrap()), ["a"]);
        assert!(lib.card_list(Some(999), 100).unwrap().is_empty());
    }

    #[test]
    fn log_appends_reviews_newest_first_and_needs_the_card() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.card_upsert(&[card("fm:x", 0), card("fm:y", 0)])
            .unwrap();
        let first = lib.card_log("fm:x", 1_000, 1, "{\"r\":1}").unwrap();
        let second = lib.card_log("fm:x", 2_000, 4, "{\"r\":4}").unwrap();
        lib.card_log("fm:y", 1_500, 3, "{}").unwrap();
        assert!(second > first);

        let logs = lib.card_logs("fm:x").unwrap();
        assert_eq!(
            logs,
            vec![
                CardLog {
                    id: second,
                    card_id: "fm:x".to_string(),
                    reviewed_at: 2_000,
                    rating: 4,
                    log: "{\"r\":4}".to_string(),
                },
                CardLog {
                    id: first,
                    card_id: "fm:x".to_string(),
                    reviewed_at: 1_000,
                    rating: 1,
                    log: "{\"r\":1}".to_string(),
                },
            ]
        );
        assert!(lib.card_logs("fm:none").unwrap().is_empty());

        let err = lib.card_log("fm:none", 0, 3, "{}").unwrap_err();
        assert!(
            matches!(&err, Error::NoSuchCard { id } if id == "fm:none"),
            "{err}"
        );
    }

    #[test]
    fn stats_count_total_due_new_and_reviewed_today() {
        let mut lib = Library::open_in_memory().unwrap();
        assert_eq!(lib.card_stats(0).unwrap(), CardStats::default());

        let now = 3 * DAY_MS + 10 * 60 * 60 * 1000; // day 3, 10:00 UTC
        lib.card_upsert(&[
            card("due-new", now - 1),
            card("due-exactly-now", now),
            card("later", now + 1),
            card("reviewed", now + DAY_MS),
            card("reviewed-yesterday", now + DAY_MS),
        ])
        .unwrap();
        assert_eq!(lib.card_stats(now).unwrap(), stats(5, 2, 5, 0));

        // Graded twice today: one distinct card; graded at 23:59 UTC yesterday: not today.
        lib.card_log("reviewed", now - 60_000, 1, "{}").unwrap();
        lib.card_log("reviewed", now, 3, "{}").unwrap();
        lib.card_log("reviewed-yesterday", 3 * DAY_MS - 60_000, 3, "{}")
            .unwrap();
        assert_eq!(lib.card_stats(now).unwrap(), stats(5, 2, 3, 1));

        // Later the same UTC day the review still counts; the next day it does not.
        assert_eq!(lib.card_stats(4 * DAY_MS - 1).unwrap().reviewed_today, 1);
        assert_eq!(lib.card_stats(4 * DAY_MS).unwrap().reviewed_today, 0);
        // Earlier the same day (a clock that went back) it counts as well: the
        // whole calendar day is looked at, not only up to `now`.
        assert_eq!(lib.card_stats(3 * DAY_MS).unwrap().reviewed_today, 1);
        // One millisecond before midnight it is the previous day, where only
        // the other card was graded (anywhere in that day); the day before
        // that has no review at all.
        assert_eq!(lib.card_stats(3 * DAY_MS - 1).unwrap().reviewed_today, 1);
        assert_eq!(lib.card_stats(2 * DAY_MS).unwrap().reviewed_today, 1);
        assert_eq!(lib.card_stats(2 * DAY_MS - 1).unwrap().reviewed_today, 0);
        // "due" follows now; "new" ignores the FSRS JSON and only looks at the log.
        assert_eq!(lib.card_stats(now + DAY_MS).unwrap(), stats(5, 5, 3, 0));

        // Deleting a reviewed card drops its log from the counts.
        lib.card_delete("reviewed").unwrap();
        assert_eq!(lib.card_stats(now).unwrap(), stats(4, 2, 3, 0));
    }

    #[test]
    fn utc_day_start_floors_to_midnight_utc() {
        assert_eq!(utc_day_start(0), 0);
        assert_eq!(utc_day_start(DAY_MS - 1), 0);
        assert_eq!(utc_day_start(DAY_MS), DAY_MS);
        assert_eq!(utc_day_start(5 * DAY_MS + 12_345), 5 * DAY_MS);
        // 2026-10-22T08:30:00Z lies in the day starting 2026-10-22T00:00:00Z.
        assert_eq!(utc_day_start(1_792_657_800_000), 1_792_627_200_000);
        // Before 1970 the floor still goes down, not toward zero.
        assert_eq!(utc_day_start(-1), -DAY_MS);
    }
}
