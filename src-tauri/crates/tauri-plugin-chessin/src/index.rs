//! Plugin state and payload types of the position-index commands
//! (`index_build`, `index_status`, `index_delete`, `index_position`,
//! `index_pawn_candidates`), over [`chessin_index`].
//!
//! Open indexes are kept in a small LRU keyed by the database path; a build
//! or a delete evicts the entry first (the sidecar is replaced by a rename,
//! which Windows refuses while the old file is mapped).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use chessin_index::IndexGame;
use chessin_index::{
    hash, moves, BuildOptions, Filter, GameResult, Index, IndexStats, Order, DEFAULT_MAX_PLY,
    MAX_SUPPORTED_PLY, NO_MOVE,
};
use shakmaty::{san::SanPlus, Position};

/// The event `index_build` emits while it runs; the payload is
/// [`IndexProgress`].
pub const INDEX_PROGRESS_EVENT: &str = "chessin://index-progress";

/// Open indexes kept per plugin.
pub const LRU_CAPACITY: usize = 4;

/// Payload of the `chessin://index-progress` event.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexProgress {
    /// The database the index belongs to, as passed to `index_build`.
    pub db_path: String,
    /// `0.0` to `1.0`.
    pub progress: f64,
    /// `true` on the last event of a build, whether it succeeded or failed.
    pub finished: bool,
}

/// Which games `index_position` counts. A bound on a value the index does
/// not know (an unrated player, an undated game) excludes the game.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct IndexFilter {
    /// Both players rated at least this.
    pub min_elo: Option<u32>,
    /// Both players rated at most this.
    pub max_elo: Option<u32>,
    /// `1-0`, `0-1` or `1/2-1/2`.
    pub result: Option<String>,
    pub year_from: Option<u32>,
    pub year_to: Option<u32>,
}

impl IndexFilter {
    fn to_filter(&self) -> Result<Filter, String> {
        let elo = |v: Option<u32>| v.map(|v| v.min(u32::from(u16::MAX)) as u16);
        let year = |v: Option<u32>| v.map(|v| v.min(u32::from(u16::MAX)) as u16);
        let result = match self.result.as_deref() {
            None | Some("") => None,
            Some(s) => match GameResult::from_pgn(Some(s)) {
                r @ (GameResult::WhiteWin | GameResult::BlackWin | GameResult::Draw) => Some(r),
                _ => return Err(format!("unknown result filter {s:?}")),
            },
        };
        Ok(Filter {
            min_elo: elo(self.min_elo),
            max_elo: elo(self.max_elo),
            result,
            year_from: year(self.year_from),
            year_to: year(self.year_to),
        })
    }
}

/// One move played from the queried position.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexMoveStats {
    /// Empty for the games that ended in the position.
    pub uci: String,
    /// `*` for the games that ended in the position.
    pub san: String,
    pub white: u32,
    /// Draws plus games with an unknown result, as the fallback search counts them.
    pub draw: u32,
    pub black: u32,
    pub games: u32,
    /// Mean rating over the games with a known rating; 0 when none.
    pub avg_elo: u32,
    /// The latest known year; 0 when none.
    pub last_year: u32,
}

/// A game that reached the queried position, and at which ply.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexGameRef {
    pub id: u32,
    pub ply: u32,
}

/// What `index_position` returns.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexPositionResult {
    /// The ply the queried FEN describes (from its move number and side to
    /// move). Past the index depth the result is empty.
    pub ply: u32,
    /// Most played first.
    pub moves: Vec<IndexMoveStats>,
    /// Up to `limit` games, highest rated first.
    pub games: Vec<IndexGameRef>,
    /// Games that reached the position and pass the filter.
    pub total: u32,
}

#[derive(Default)]
struct Inner {
    /// Most recently used first.
    open: Vec<(String, Arc<Index>)>,
    /// Cancel flags of the builds in progress.
    building: HashMap<String, Arc<AtomicBool>>,
}

/// Managed by the plugin's `setup`; cheap to clone.
#[derive(Clone, Default)]
pub struct IndexState {
    inner: Arc<Mutex<Inner>>,
}

impl IndexState {
    pub fn new() -> IndexState {
        IndexState::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The index of `db_path`, from the LRU or freshly opened; `None` when
    /// the database has no sidecar, an error when it has a corrupt one.
    pub fn open(&self, db_path: &str) -> Result<Option<Arc<Index>>, String> {
        let mut inner = self.lock();
        if let Some(i) = inner.open.iter().position(|(k, _)| k == db_path) {
            let entry = inner.open.remove(i);
            let index = entry.1.clone();
            inner.open.insert(0, entry);
            return Ok(Some(index));
        }
        match Index::open(Path::new(db_path)) {
            Ok(index) => {
                let index = Arc::new(index);
                inner.open.insert(0, (db_path.to_string(), index.clone()));
                inner.open.truncate(LRU_CAPACITY);
                Ok(Some(index))
            }
            Err(chessin_index::Error::Missing) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Drops the cached index of `db_path`, if any.
    pub fn evict(&self, db_path: &str) {
        self.lock().open.retain(|(k, _)| k != db_path);
    }

    /// The database paths currently cached, most recently used first.
    pub fn cached(&self) -> Vec<String> {
        self.lock().open.iter().map(|(k, _)| k.clone()).collect()
    }

    pub fn is_building(&self, db_path: &str) -> bool {
        self.lock().building.contains_key(db_path)
    }

    /// Registers a build; an error when one is already running for the path.
    fn begin_build(&self, db_path: &str) -> Result<Arc<AtomicBool>, String> {
        let mut inner = self.lock();
        if inner.building.contains_key(db_path) {
            return Err(format!("an index build of {db_path} is already running"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.building.insert(db_path.to_string(), cancel.clone());
        Ok(cancel)
    }

    fn end_build(&self, db_path: &str) {
        self.lock().building.remove(db_path);
    }

    /// Asks a running build of `db_path` to stop; the build returns
    /// `cancelled` shortly after.
    pub fn cancel_build(&self, db_path: &str) {
        if let Some(flag) = self.lock().building.get(db_path) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Brings the sidecar of `db_path` up to date (a full build when there
    /// is none, or when `max_ply` differs); `progress` gets `0.0..=1.0`.
    pub fn build(
        &self,
        db_path: &str,
        max_ply: Option<u32>,
        mut progress: impl FnMut(f64),
    ) -> Result<IndexStats, String> {
        let max_ply = match max_ply {
            None => DEFAULT_MAX_PLY,
            Some(p) => u16::try_from(p)
                .ok()
                .filter(|p| *p <= MAX_SUPPORTED_PLY)
                .ok_or_else(|| format!("max_ply must be at most {MAX_SUPPORTED_PLY}"))?,
        };
        let cancel = self.begin_build(db_path)?;
        self.evict(db_path);
        let opts = BuildOptions::new(max_ply).with_progress(|done, total| {
            progress(done as f64 / total.max(1) as f64);
        });
        let result =
            chessin_index::update(Path::new(db_path), opts, &cancel).map_err(|e| e.to_string());
        self.end_build(db_path);
        result
    }

    /// The stats of the index of `db_path`; `None` without a usable index.
    pub fn status(&self, db_path: &str) -> Option<IndexStats> {
        self.open(db_path).ok().flatten().map(|i| i.status())
    }

    /// Cancels a running build, forgets the cached index and removes the
    /// sidecar and its scratch files; a missing sidecar is not an error.
    pub fn delete(&self, db_path: &str) -> Result<(), String> {
        self.cancel_build(db_path);
        self.evict(db_path);
        let sidecar = chessin_index::sidecar_path(Path::new(db_path));
        for suffix in ["", ".tmp", ".merge"] {
            let mut name = sidecar.as_os_str().to_owned();
            name.push(suffix);
            match std::fs::remove_file(&name) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", Path::new(&name).display())),
            }
        }
        Ok(())
    }

    fn index(&self, db_path: &str) -> Result<Arc<Index>, String> {
        self.open(db_path)?
            .ok_or_else(|| format!("{db_path} has no position index"))
    }

    /// The opening tree and sample games of `fen` in `db_path`.
    pub fn position(
        &self,
        db_path: &str,
        fen: &str,
        filter: &IndexFilter,
        limit: u32,
    ) -> Result<IndexPositionResult, String> {
        let index = self.index(db_path)?;
        let pos = moves::parse_fen(fen).map_err(|e| e.to_string())?;
        let ply = hash::fen_ply(fen).unwrap_or(0);
        let filter = filter.to_filter()?;
        if ply > u32::from(index.max_ply()) {
            return Ok(IndexPositionResult {
                ply,
                moves: Vec::new(),
                games: Vec::new(),
                total: 0,
            });
        }
        let h = hash::position_hash(&pos);
        let castling = pos.castles().mode();
        let mut total = 0u32;
        let moves = index
            .tree(h, &filter)
            .into_iter()
            .filter_map(|s| {
                total += s.games;
                let (uci, san) = if s.move_code == NO_MOVE {
                    (String::new(), "*".to_string())
                } else {
                    let m = moves::decode_move(s.move_code, &pos)?;
                    (
                        m.to_uci(castling).to_string(),
                        SanPlus::from_move(pos.clone(), &m).to_string(),
                    )
                };
                Some(IndexMoveStats {
                    uci,
                    san,
                    white: s.white,
                    draw: s.draw,
                    black: s.black,
                    games: s.games,
                    avg_elo: s.avg_elo(),
                    last_year: u32::from(s.last_year),
                })
            })
            .collect();
        let games = index
            .sample_games(h, &filter, limit as usize, Order::ByElo)
            .into_iter()
            .map(|p| IndexGameRef {
                id: p.game_id,
                ply: u32::from(p.ply),
            })
            .collect();
        Ok(IndexPositionResult {
            ply,
            moves,
            games,
            total,
        })
    }

    /// Up to `limit` ids of games whose pawn structure at ply 10, 20, …, 60
    /// may equal the one of `fen` (a bloom filter: false positives happen).
    pub fn pawn_candidates(
        &self,
        db_path: &str,
        fen: &str,
        limit: u32,
    ) -> Result<Vec<u32>, String> {
        let index = self.index(db_path)?;
        let h = hash::pawn_hash_of_fen(fen).map_err(|e| e.to_string())?;
        Ok(index.pawn_candidates(h).take(limit as usize).collect())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chessin_index::moves::encode_uci_line;
    use rusqlite::Connection;

    /// The `Games` table of `src-tauri/src/db/create.sql` (the columns the
    /// index reads, with the app's types).
    const SCHEMA: &str = "CREATE TABLE Games (
        ID INTEGER PRIMARY KEY AUTOINCREMENT, EventID INTEGER, SiteID INTEGER, Date TEXT,
        UTCTime TEXT, Round INTEGER, WhiteID INTEGER, WhiteElo INTEGER, BlackID INTEGER,
        BlackElo INTEGER, WhiteMaterial INTEGER, BlackMaterial INTEGER, Result INTEGER,
        TimeControl TEXT, ECO TEXT, PlyCount INTEGER, FEN TEXT, Moves BLOB, PawnHome BLOB);
        CREATE TABLE Players (ID INTEGER PRIMARY KEY, Name TEXT UNIQUE, Elo INTEGER);
        CREATE TABLE Events (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
        CREATE TABLE Sites (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
        INSERT INTO Players (ID, Name, Elo) VALUES (0, 'Unknown', NULL);
        INSERT INTO Events (ID, Name) VALUES (0, 'Unknown');
        INSERT INTO Sites (ID, Name) VALUES (0, 'Unknown');";

    pub(crate) struct Game {
        pub line: &'static [&'static str],
        pub result: Option<&'static str>,
        pub elo: (Option<i64>, Option<i64>),
        pub date: Option<&'static str>,
    }

    pub(crate) fn write_db(path: &Path, games: &[Game]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (i, g) in games.iter().enumerate() {
            let moves = encode_uci_line(None, g.line).unwrap();
            conn.execute(
                "INSERT INTO Games (ID, EventID, SiteID, Date, WhiteID, WhiteElo, BlackID, BlackElo, \
                 WhiteMaterial, BlackMaterial, Result, PlyCount, Moves, PawnHome) \
                 VALUES (?1, 0, 0, ?2, 0, ?3, 0, ?4, 39, 39, ?5, ?6, ?7, 0)",
                rusqlite::params![
                    i as i64 + 1,
                    g.date,
                    g.elo.0,
                    g.elo.1,
                    g.result,
                    g.line.len() as i64,
                    moves
                ],
            )
            .unwrap();
        }
    }

    pub(crate) fn sample_games() -> Vec<Game> {
        vec![
            Game {
                line: &[
                    "e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7",
                ],
                result: Some("1-0"),
                elo: (Some(2700), Some(2650)),
                date: Some("2021.05.01"),
            },
            Game {
                line: &["e2e4", "c7c5"],
                result: Some("0-1"),
                elo: (Some(2300), None),
                date: Some("1999.01.01"),
            },
            Game {
                line: &["d2d4", "d7d5"],
                result: Some("1/2-1/2"),
                elo: (None, None),
                date: None,
            },
            Game {
                line: &[],
                result: None,
                elo: (Some(1500), Some(1600)),
                date: Some("????.??.??"),
            },
        ]
    }

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const AFTER_E4: &str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

    fn db_with(dir: &Path, name: &str) -> String {
        let db = dir.join(format!("{name}.db3"));
        write_db(&db, &sample_games());
        db.to_string_lossy().into_owned()
    }

    #[test]
    fn status_build_position_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with(dir.path(), "games");
        let state = IndexState::new();
        assert_eq!(state.status(&db), None);
        assert!(state
            .position(&db, START, &IndexFilter::default(), 10)
            .unwrap_err()
            .contains("no position index"));

        let mut seen = Vec::new();
        let stats = state.build(&db, None, |p| seen.push(p)).unwrap();
        assert_eq!((stats.games, stats.max_ply, stats.skipped), (4, 40, 0));
        assert_eq!(seen.last().copied(), Some(1.0));
        assert_eq!(state.status(&db), Some(stats.clone()));
        assert_eq!(state.cached(), vec![db.clone()]);

        let r = state
            .position(&db, START, &IndexFilter::default(), 10)
            .unwrap();
        assert_eq!((r.ply, r.total), (0, 4));
        let summary: Vec<(&str, &str, u32)> = r
            .moves
            .iter()
            .map(|m| (m.uci.as_str(), m.san.as_str(), m.games))
            .collect();
        // Ties are broken by the move code, so the "game ended here" row (0xFF) comes last.
        assert_eq!(
            summary,
            vec![("e2e4", "e4", 2), ("d2d4", "d4", 1), ("", "*", 1)]
        );
        let e4 = &r.moves[0];
        assert_eq!((e4.white, e4.draw, e4.black), (1, 0, 1));
        assert_eq!((e4.avg_elo, e4.last_year), ((2675 + 2300) / 2, 2021));
        assert_eq!(
            r.games.iter().map(|g| g.id).collect::<Vec<_>>(),
            vec![1, 2, 4, 3],
            "highest rated first"
        );
        assert!(r.games.iter().all(|g| g.ply == 0));

        let after_e4 = state
            .position(&db, AFTER_E4, &IndexFilter::default(), 1)
            .unwrap();
        assert_eq!(after_e4.ply, 1);
        assert_eq!(
            after_e4
                .moves
                .iter()
                .map(|m| m.san.as_str())
                .collect::<Vec<_>>(),
            vec!["c5", "e5"]
        );
        assert_eq!(after_e4.games.len(), 1);

        let filtered = state
            .position(
                &db,
                START,
                &IndexFilter {
                    result: Some("1-0".into()),
                    ..IndexFilter::default()
                },
                10,
            )
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.moves[0].san, "e4");
        let rated = IndexFilter {
            min_elo: Some(2000),
            year_from: Some(2000),
            ..IndexFilter::default()
        };
        assert_eq!(
            state.position(&db, START, &rated, 10).unwrap().games,
            vec![IndexGameRef { id: 1, ply: 0 }]
        );

        // Past the index depth the result is empty but carries the ply.
        let deep = state
            .position(
                &db,
                "8/8/8/8/8/8/8/K6k w - - 0 30",
                &IndexFilter::default(),
                10,
            )
            .unwrap();
        assert_eq!((deep.ply, deep.total, deep.moves.len()), (58, 0, 0));
        assert!(state
            .position(&db, "not a fen", &IndexFilter::default(), 10)
            .is_err());
        let bad = IndexFilter {
            result: Some("win".into()),
            ..IndexFilter::default()
        };
        assert!(state
            .position(&db, START, &bad, 10)
            .unwrap_err()
            .contains("win"));

        // The pawn structure of game 1 at ply 10 (after ...a6).
        let fen10 = "r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 6";
        assert_eq!(state.pawn_candidates(&db, fen10, 10).unwrap(), vec![1]);
        assert_eq!(
            state.pawn_candidates(&db, fen10, 0).unwrap(),
            Vec::<u32>::new()
        );
        assert!(state.pawn_candidates(&db, "x", 10).is_err());

        state.delete(&db).unwrap();
        assert_eq!(state.status(&db), None);
        assert!(state.cached().is_empty());
        state.delete(&db).unwrap();
        assert!(state.build(&db, Some(300), |_| {}).is_err());
    }

    #[test]
    fn lru_keeps_four_indexes_and_evicts_on_build_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let state = IndexState::new();
        let dbs: Vec<String> = (0..5)
            .map(|i| db_with(dir.path(), &format!("db{i}")))
            .collect();
        for db in &dbs {
            state.build(db, Some(10), |_| {}).unwrap();
        }
        // A build evicts its own entry, so nothing is cached yet.
        assert!(state.cached().is_empty());
        for db in &dbs {
            assert!(state.status(db).is_some());
        }
        assert_eq!(
            state.cached(),
            vec![
                dbs[4].clone(),
                dbs[3].clone(),
                dbs[2].clone(),
                dbs[1].clone()
            ]
        );
        // A hit moves the entry to the front; a miss reopens and evicts the oldest.
        state.status(&dbs[2]);
        assert_eq!(state.cached()[0], dbs[2]);
        state.status(&dbs[0]);
        assert_eq!(
            state.cached(),
            vec![
                dbs[0].clone(),
                dbs[2].clone(),
                dbs[4].clone(),
                dbs[3].clone()
            ]
        );
        state.build(&dbs[2], Some(10), |_| {}).unwrap();
        assert_eq!(
            state.cached(),
            vec![dbs[0].clone(), dbs[4].clone(), dbs[3].clone()]
        );
        state.delete(&dbs[0]).unwrap();
        assert_eq!(state.cached(), vec![dbs[4].clone(), dbs[3].clone()]);
        // A corrupt sidecar is reported by `open` and read as "no index" by `status`.
        std::fs::write(
            chessin_index::sidecar_path(Path::new(&dbs[1])),
            b"CPI1 junk junk junk",
        )
        .unwrap();
        assert!(state.open(&dbs[1]).is_err());
        assert_eq!(state.status(&dbs[1]), None);
        // Building over it works and the index is usable again.
        state.build(&dbs[1], Some(10), |_| {}).unwrap();
        assert!(state.status(&dbs[1]).is_some());
    }

    #[test]
    fn index_games_reads_rows_by_id_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_with(dir.path(), "rows");
        let rows = chessin_index::load_games(Path::new(&db), &[2, 99, 1]).unwrap();
        assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(
            rows[0],
            IndexGame {
                id: 2,
                white: "Unknown".into(),
                black: "Unknown".into(),
                white_elo: Some(2300),
                black_elo: None,
                result: "0-1".into(),
                date: Some("1999.01.01".into()),
                event: "Unknown".into(),
                site: "Unknown".into(),
                eco: None,
                ply_count: Some(2),
                fen: None,
                moves: "1. e4 c5".into(),
            }
        );
        assert_eq!(
            rows[1].moves,
            "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7"
        );
        let empty = chessin_index::load_games(Path::new(&db), &[4]).unwrap();
        assert_eq!(
            (empty[0].moves.as_str(), empty[0].result.as_str()),
            ("", "*")
        );
        assert!(chessin_index::load_games(Path::new("/nonexistent/x.db3"), &[1]).is_err());
    }

    #[test]
    fn concurrent_builds_of_one_path_are_refused_and_cancel_is_honoured() {
        let state = IndexState::new();
        let cancel = state.begin_build("/x/games.db3").unwrap();
        assert!(state.is_building("/x/games.db3"));
        assert!(state
            .begin_build("/x/games.db3")
            .unwrap_err()
            .contains("already running"));
        state.cancel_build("/x/games.db3");
        assert!(cancel.load(Ordering::Relaxed));
        state.end_build("/x/games.db3");
        assert!(!state.is_building("/x/games.db3"));
        // A delete during a build cancels it.
        let cancel = state.begin_build("/x/other.db3").unwrap();
        state.delete("/x/other.db3").unwrap();
        assert!(cancel.load(Ordering::Relaxed));
        state.end_build("/x/other.db3");
        // Building a missing database is an error, not a panic.
        assert!(state.build("/nonexistent/games.db3", None, |_| {}).is_err());
        assert!(!state.is_building("/nonexistent/games.db3"));
    }
}
