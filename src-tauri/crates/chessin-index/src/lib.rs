//! Position index for Chessin's SQLite game databases (`<name>.db3`).
//!
//! The index is a sidecar file next to the database, `<name>.db3.cpi`, that
//! answers "which games reached this position, and what was played next" for
//! every position of the first [`DEFAULT_MAX_PLY`] plies of every game, plus
//! a per-game signature for approximate pawn-structure searches. It is built
//! from the `Games` table alone (`ID`, `Result`, `WhiteElo`, `BlackElo`,
//! `Date`, `FEN`, `Moves`), is safe to delete at any time, and is written
//! atomically (`.cpi.tmp` + rename).
//!
//! # On-disk format (`CPI1`, little-endian)
//!
//! ```text
//! header (64 bytes)             magic "CPI1", crc32, max_ply, segment count,
//!                               max game id, games, skipped, postings,
//!                               segment table offset, file length, built_at
//! segment 0 … segment n-1       each 8-byte aligned, see below
//! segment table                 96 bytes per segment + crc32
//! ```
//!
//! A **segment** covers a contiguous range of game ids `[first, last]`:
//!
//! * **meta**: `(last - first + 1)` records of 8 bytes indexed by game id:
//!   `result u8` (0 unknown, 1 white, 2 black, 3 draw, 4 other),
//!   `white_elo u16`, `black_elo u16`, `year u16` (0 = unknown) and a flags
//!   byte (bit 0 = the game is indexed; a skipped or missing id is all zero).
//! * **signatures**: the same count of 64-byte records: the material at the
//!   end of the game (6 piece counts per colour, the pawn-home bits of the
//!   second/seventh rank, the final ply, the weighted material of each side)
//!   and a 256-bit bloom filter of the pawn-structure hashes seen at plies
//!   10, 20, 30, 40, 50 and 60 (see [`hash::pawn_hash`]).
//! * **blocks**: the postings `(hash, game_id, ply, next_move)` sorted by
//!   `(hash, game_id, ply)` in blocks of up to 128. A block stores the byte
//!   widths it needs and a bitmap of the postings that start a new hash;
//!   a posting that shares the previous hash costs only a game-id delta plus
//!   two bytes, which is what makes shared opening positions cheap.
//! * **directory**: `(first hash u64, block offset u64)` per block, binary
//!   searched by [`Index::lookup`]. Only the touched pages are read, so a
//!   large index opens lazily through the memory map.
//!
//! [`update`] appends a segment with the games whose id is above the indexed
//! maximum and merges the segments once there are more than
//! [`MAX_SEGMENTS`]. Games deleted from the database are *not* removed in
//! this version: their postings stay until the next full [`build`], and
//! callers should tolerate ids that no longer exist.
//!
//! Positions are hashed with shakmaty's 64-bit Zobrist hash of the full
//! position (side to move, castling rights, and the en-passant square when
//! an en-passant capture is legal). The move codes are the database's own
//! one-byte scheme, re-implemented in [`moves`].

pub mod blocks;
pub mod build;
pub mod format;
pub mod games;
pub mod hash;
pub mod index;
pub mod moves;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

pub use build::{build, update, BuildOptions};
pub use games::{load_games, IndexGame, MAX_GAMES};
pub use index::{Index, Signature};

/// Plies indexed per game when the caller does not choose.
pub const DEFAULT_MAX_PLY: u16 = 40;

/// The largest `max_ply` the format can store (the ply is one byte).
pub const MAX_SUPPORTED_PLY: u16 = 255;

/// Segments are merged into one once an update would leave more than this.
pub const MAX_SEGMENTS: usize = 4;

/// Marker for "no move was played after this position" in
/// [`Posting::next_move`].
pub const NO_MOVE: u8 = 0xFF;

/// The sidecar path of a database: `<db>.cpi` appended to the full file name
/// (`games.db3` → `games.db3.cpi`).
pub fn sidecar_path(db_path: &Path) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push(".cpi");
    PathBuf::from(name)
}

/// One occurrence of a position in a game.
///
/// The derived ordering, `(hash, game_id, ply, next_move)`, is the order the
/// postings are stored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Posting {
    /// Zobrist hash of the position after `ply` plies.
    pub hash: u64,
    pub game_id: u32,
    /// 0 is the game's start position.
    pub ply: u16,
    /// The one-byte code of the move played next, or [`NO_MOVE`].
    pub next_move: u8,
}

/// The result of a game as stored in the meta array.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(u8)]
pub enum GameResult {
    #[default]
    Unknown = 0,
    WhiteWin = 1,
    BlackWin = 2,
    Draw = 3,
    /// A `Result` column with text other than the three PGN results (`*`).
    Other = 4,
}

impl GameResult {
    /// `1-0`, `0-1`, `1/2-1/2` → the result; any other text → [`Other`];
    /// `None` → [`Unknown`].
    ///
    /// [`Other`]: GameResult::Other
    /// [`Unknown`]: GameResult::Unknown
    pub fn from_pgn(s: Option<&str>) -> GameResult {
        match s {
            Some("1-0") => GameResult::WhiteWin,
            Some("0-1") => GameResult::BlackWin,
            Some("1/2-1/2") => GameResult::Draw,
            Some(_) => GameResult::Other,
            None => GameResult::Unknown,
        }
    }

    pub fn from_code(code: u8) -> GameResult {
        match code {
            1 => GameResult::WhiteWin,
            2 => GameResult::BlackWin,
            3 => GameResult::Draw,
            4 => GameResult::Other,
            _ => GameResult::Unknown,
        }
    }

    pub fn code(self) -> u8 {
        self as u8
    }

    /// The PGN result token; `*` for [`Unknown`] and [`Other`], as the app's
    /// `Outcome` renders them.
    ///
    /// [`Other`]: GameResult::Other
    /// [`Unknown`]: GameResult::Unknown
    pub fn as_pgn(self) -> &'static str {
        match self {
            GameResult::WhiteWin => "1-0",
            GameResult::BlackWin => "0-1",
            GameResult::Draw => "1/2-1/2",
            GameResult::Unknown | GameResult::Other => "*",
        }
    }
}

/// What the index knows about a game besides its positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GameMeta {
    pub result: GameResult,
    /// 0 when unknown.
    pub white_elo: u16,
    /// 0 when unknown.
    pub black_elo: u16,
    /// 0 when unknown.
    pub year: u16,
}

/// Restricts the games counted by [`Index::tree`] and [`Index::sample_games`].
///
/// A bound on a value the index does not know (Elo 0, year 0) excludes the
/// game: with `min_elo` or `max_elo` set only games with both ratings known
/// are counted, and with a year bound only games with a known year.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Filter {
    /// Both players rated at least this.
    pub min_elo: Option<u16>,
    /// Both players rated at most this.
    pub max_elo: Option<u16>,
    pub result: Option<GameResult>,
    pub year_from: Option<u16>,
    pub year_to: Option<u16>,
}

impl Filter {
    pub fn accepts(&self, meta: &GameMeta) -> bool {
        if self.min_elo.is_some() || self.max_elo.is_some() {
            if meta.white_elo == 0 || meta.black_elo == 0 {
                return false;
            }
            let lo = meta.white_elo.min(meta.black_elo);
            let hi = meta.white_elo.max(meta.black_elo);
            if self.min_elo.is_some_and(|min| lo < min) || self.max_elo.is_some_and(|max| hi > max)
            {
                return false;
            }
        }
        if let Some(result) = self.result {
            if meta.result != result {
                return false;
            }
        }
        if self.year_from.is_some() || self.year_to.is_some() {
            if meta.year == 0 {
                return false;
            }
            if self.year_from.is_some_and(|from| meta.year < from)
                || self.year_to.is_some_and(|to| meta.year > to)
            {
                return false;
            }
        }
        true
    }
}

/// Aggregate of the games that reached a position, per move played next.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MoveStats {
    /// The one-byte move code, or [`NO_MOVE`] for games that ended here.
    pub move_code: u8,
    pub white: u32,
    /// Draws, plus games with an unknown or other result (as upstream's
    /// brute-force search counts them).
    pub draw: u32,
    pub black: u32,
    pub games: u32,
    /// Sum of the games' average rating (the one known rating when only one
    /// is), over `elo_games` games.
    pub elo_sum: u64,
    pub elo_games: u32,
    /// The latest known year, 0 when none is known.
    pub last_year: u16,
}

impl MoveStats {
    /// The mean rating over the games with a known rating, 0 when none.
    pub fn avg_elo(&self) -> u32 {
        if self.elo_games == 0 {
            0
        } else {
            (self.elo_sum / u64::from(self.elo_games)) as u32
        }
    }
}

/// How [`Index::sample_games`] ranks the games it returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// Highest rated player first.
    ByElo,
    /// Most recent year first.
    ByYear,
}

/// What an index holds; also what [`build`] and [`update`] report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexStats {
    /// Games whose positions are indexed.
    pub games: u32,
    /// Position occurrences stored (at most `max_ply + 1` per game).
    pub postings: u64,
    /// Size of the sidecar file.
    pub bytes: u64,
    /// The largest game id the index covers; `update` indexes the ids above it.
    pub max_game_id: u32,
    /// Unix seconds of the last build or update.
    pub built_at: i64,
    /// Plies indexed per game.
    pub max_ply: u32,
    /// Games whose moves could not be decoded (not indexed).
    pub skipped: u32,
    /// Segments in the file (1 after a full build).
    pub segments: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("index file is corrupt: {0}")]
    Corrupt(String),
    #[error("no index")]
    Missing,
    #[error("cancelled")]
    Cancelled,
    #[error("invalid FEN: {0}")]
    Fen(String),
    #[error("{0}")]
    InvalidArgument(String),
}

impl Error {
    pub(crate) fn io(path: &Path, source: std::io::Error) -> Error {
        Error::Io {
            path: path.to_path_buf(),
            source,
        }
    }

    pub(crate) fn corrupt(msg: impl Into<String>) -> Error {
        Error::Corrupt(msg.into())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn sidecar_appends_to_the_full_file_name() {
        assert_eq!(
            sidecar_path(Path::new("/x/games.db3")),
            PathBuf::from("/x/games.db3.cpi")
        );
        assert_eq!(
            sidecar_path(Path::new("rel/a.b.db3")),
            PathBuf::from("rel/a.b.db3.cpi")
        );
    }

    #[test]
    fn filter_bounds_exclude_unknown_values() {
        let known = GameMeta {
            result: GameResult::Draw,
            white_elo: 2400,
            black_elo: 2500,
            year: 2020,
        };
        let unrated = GameMeta {
            white_elo: 0,
            ..known
        };
        let undated = GameMeta { year: 0, ..known };
        let min = Filter {
            min_elo: Some(2400),
            ..Filter::default()
        };
        assert!(min.accepts(&known));
        assert!(!min.accepts(&unrated));
        let max = Filter {
            max_elo: Some(2450),
            ..Filter::default()
        };
        assert!(!max.accepts(&known), "the higher rating is above the max");
        assert!(!max.accepts(&unrated));
        let years = Filter {
            year_from: Some(2019),
            year_to: Some(2020),
            ..Filter::default()
        };
        assert!(years.accepts(&known));
        assert!(!years.accepts(&undated));
        let result = Filter {
            result: Some(GameResult::WhiteWin),
            ..Filter::default()
        };
        assert!(!result.accepts(&known));
        assert!(Filter::default().accepts(&unrated));
    }

    #[test]
    fn results_round_trip_through_their_codes() {
        for s in [Some("1-0"), Some("0-1"), Some("1/2-1/2"), Some("*"), None] {
            let r = GameResult::from_pgn(s);
            assert_eq!(GameResult::from_code(r.code()), r);
        }
        assert_eq!(GameResult::from_code(200), GameResult::Unknown);
        assert_eq!(
            MoveStats {
                elo_sum: 5000,
                elo_games: 2,
                ..MoveStats::default()
            }
            .avg_elo(),
            2500
        );
        assert_eq!(MoveStats::default().avg_elo(), 0);
    }
}
