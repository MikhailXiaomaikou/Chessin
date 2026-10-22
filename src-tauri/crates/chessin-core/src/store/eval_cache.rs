//! The `eval_cache` table: one engine evaluation per (position, engine), so a
//! game review can skip the engine for positions it has already seen.
//!
//! A cached row is only ever replaced by an evaluation of the same or a greater
//! depth (a put is depth-monotonic), and a get only returns rows that reach the
//! requested depth. What `engine` means (name + version) and from whose point of
//! view the score is are conventions of the frontend; the store compares
//! strings and depths only.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use super::{now_ms, Error, Library};

/// One row of `eval_cache` (without `created_at`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct CachedEval {
    /// The position as an EPD (FEN without the move counters).
    pub epd: String,
    /// Engine name and version, as the frontend forms it.
    pub engine: String,
    pub depth: u32,
    /// `cp` or `mate`.
    pub score_type: String,
    /// Centipawns, or moves to mate.
    pub score_value: i32,
    /// The best move, UCI.
    pub best_uci: String,
    /// The principal variation: UCI moves separated by spaces.
    pub pv: String,
}

impl Library {
    /// The cached evaluations of `epds` by `engine` that reach `min_depth`,
    /// each position at most once, in no particular order. Positions without a
    /// deep enough row are simply absent.
    pub fn eval_cache_get(
        &self,
        epds: &[String],
        engine: &str,
        min_depth: u32,
    ) -> Result<Vec<CachedEval>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT epd, engine, depth, score_type, score_value, best_uci, pv FROM eval_cache
             WHERE epd = ?1 AND engine = ?2 AND depth >= ?3",
        )?;
        let mut seen = HashSet::with_capacity(epds.len());
        let mut found = Vec::new();
        for epd in epds {
            if !seen.insert(epd.as_str()) {
                continue;
            }
            let row = stmt
                .query_row(params![epd, engine, min_depth], |r| {
                    Ok(CachedEval {
                        epd: r.get(0)?,
                        engine: r.get(1)?,
                        depth: r.get(2)?,
                        score_type: r.get(3)?,
                        score_value: r.get(4)?,
                        best_uci: r.get(5)?,
                        pv: r.get(6)?,
                    })
                })
                .optional()?;
            found.extend(row);
        }
        Ok(found)
    }

    /// Stores the evaluations in one transaction. An entry replaces the row of
    /// its (position, engine) only when its depth is at least the stored one;
    /// a shallower entry is ignored.
    pub fn eval_cache_put(&mut self, entries: &[CachedEval]) -> Result<(), Error> {
        self.eval_cache_put_at(entries, now_ms())
    }

    /// [`Library::eval_cache_put`] with an explicit clock for `created_at` (tests).
    pub fn eval_cache_put_at(&mut self, entries: &[CachedEval], now_ms: i64) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO eval_cache (epd, engine, depth, score_type, score_value, best_uci, pv,
                     created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (epd, engine) DO UPDATE SET depth = excluded.depth,
                     score_type = excluded.score_type, score_value = excluded.score_value,
                     best_uci = excluded.best_uci, pv = excluded.pv,
                     created_at = excluded.created_at
                 WHERE excluded.depth >= eval_cache.depth",
            )?;
            for e in entries {
                stmt.execute(params![
                    e.epd,
                    e.engine,
                    e.depth,
                    e.score_type,
                    e.score_value,
                    e.best_uci,
                    e.pv,
                    now_ms,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
    const AFTER_E4: &str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";

    fn eval(epd: &str, engine: &str, depth: u32, cp: i32) -> CachedEval {
        CachedEval {
            epd: epd.to_string(),
            engine: engine.to_string(),
            depth,
            score_type: "cp".to_string(),
            score_value: cp,
            best_uci: "e2e4".to_string(),
            pv: "e2e4 e7e5 g1f3".to_string(),
        }
    }

    fn epds(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn created_at(lib: &Library, epd: &str, engine: &str) -> i64 {
        lib.conn
            .query_row(
                "SELECT created_at FROM eval_cache WHERE epd = ?1 AND engine = ?2",
                [epd, engine],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn put_only_replaces_with_an_equal_or_deeper_evaluation() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.eval_cache_put_at(&[eval(START, "sf17", 20, 30)], 1_000)
            .unwrap();
        assert_eq!(
            lib.eval_cache_get(&epds(&[START]), "sf17", 0).unwrap(),
            vec![eval(START, "sf17", 20, 30)]
        );

        // Shallower: ignored, the row is untouched.
        lib.eval_cache_put_at(&[eval(START, "sf17", 12, 99)], 2_000)
            .unwrap();
        let got = lib.eval_cache_get(&epds(&[START]), "sf17", 0).unwrap();
        assert_eq!((got[0].depth, got[0].score_value), (20, 30));
        assert_eq!(created_at(&lib, START, "sf17"), 1_000);

        // Equal depth: replaced (a fresher run of the same depth wins).
        lib.eval_cache_put_at(&[eval(START, "sf17", 20, 31)], 3_000)
            .unwrap();
        let got = lib.eval_cache_get(&epds(&[START]), "sf17", 0).unwrap();
        assert_eq!((got[0].depth, got[0].score_value), (20, 31));
        assert_eq!(created_at(&lib, START, "sf17"), 3_000);

        // Deeper: replaced, every column.
        lib.eval_cache_put_at(
            &[CachedEval {
                score_type: "mate".to_string(),
                best_uci: "d2d4".to_string(),
                pv: "d2d4".to_string(),
                ..eval(START, "sf17", 30, 5)
            }],
            4_000,
        )
        .unwrap();
        let got = lib.eval_cache_get(&epds(&[START]), "sf17", 0).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            (
                got[0].depth,
                got[0].score_type.as_str(),
                got[0].score_value,
                got[0].best_uci.as_str(),
                got[0].pv.as_str()
            ),
            (30, "mate", 5, "d2d4", "d2d4")
        );

        // Another engine has its own row for the same position.
        lib.eval_cache_put_at(&[eval(START, "lc0", 8, -10)], 5_000)
            .unwrap();
        assert_eq!(
            lib.eval_cache_get(&epds(&[START]), "lc0", 0).unwrap(),
            vec![eval(START, "lc0", 8, -10)]
        );
        assert_eq!(
            lib.eval_cache_get(&epds(&[START]), "sf17", 0).unwrap()[0].depth,
            30
        );
    }

    #[test]
    fn get_filters_by_min_depth_and_returns_each_position_once() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.eval_cache_put(&[
            eval(START, "sf17", 20, 30),
            eval(AFTER_E4, "sf17", 15, -20),
            eval(START, "other", 40, 0),
        ])
        .unwrap();

        let both = epds(&[START, AFTER_E4, "unknown", START]);
        let mut got = lib.eval_cache_get(&both, "sf17", 15).unwrap();
        got.sort_by(|a, b| a.epd.cmp(&b.epd));
        assert_eq!(
            got,
            vec![eval(AFTER_E4, "sf17", 15, -20), eval(START, "sf17", 20, 30)],
            "min_depth is inclusive; the repeated and the unknown epd add nothing"
        );

        let got = lib.eval_cache_get(&both, "sf17", 16).unwrap();
        assert_eq!(got, vec![eval(START, "sf17", 20, 30)]);
        assert!(lib.eval_cache_get(&both, "sf17", 21).unwrap().is_empty());
        assert!(lib.eval_cache_get(&[], "sf17", 0).unwrap().is_empty());
        assert!(lib.eval_cache_get(&both, "sf16", 0).unwrap().is_empty());
        // An empty put is fine.
        lib.eval_cache_put(&[]).unwrap();
    }
}
