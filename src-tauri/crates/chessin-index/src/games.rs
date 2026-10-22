//! Game rows by id for the explorer's sample list: the `Games` row joined
//! to its players, event and site, with the main line rendered as SAN
//! movetext. Read straight from the database, so it costs one primary-key
//! lookup per game however large the file is.

use std::path::Path;
use std::time::Duration;

use rusqlite::types::ValueRef;

use crate::build::{open_db, text_of};
use crate::moves::mainline_movetext;
use crate::Result;

/// Ids [`load_games`] reads at most; the rest are ignored.
pub const MAX_GAMES: usize = 500;

/// How long to wait for a database lock held by the app.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// One game as [`load_games`] returns it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IndexGame {
    pub id: u32,
    /// Empty when the player has no name.
    pub white: String,
    pub black: String,
    pub white_elo: Option<u32>,
    pub black_elo: Option<u32>,
    /// `1-0`, `0-1`, `1/2-1/2` or `*` (also for an unknown or missing result).
    pub result: String,
    /// As stored (`YYYY.MM.DD`, possibly with `?` digits).
    pub date: Option<String>,
    pub event: String,
    pub site: String,
    pub eco: Option<String>,
    pub ply_count: Option<u32>,
    /// The start position; `None` for the standard one.
    pub fen: Option<String>,
    /// The main line as SAN movetext (`1. e4 e5 2. Nf3`), without the
    /// result token; empty when the moves do not decode.
    pub moves: String,
}

/// The rows of the games with these ids, in the requested order; ids that
/// do not exist are skipped and only the first [`MAX_GAMES`] are read. The
/// database is opened read-only.
pub fn load_games(db_path: &Path, ids: &[u32]) -> Result<Vec<IndexGame>> {
    let conn = open_db(db_path, BUSY_TIMEOUT)?;
    let mut stmt = conn.prepare(
        "SELECT g.ID, w.Name, b.Name, g.WhiteElo, g.BlackElo, g.Result, g.Date, e.Name, s.Name, \
         g.ECO, g.PlyCount, g.FEN, g.Moves \
         FROM Games g \
         LEFT JOIN Players w ON w.ID = g.WhiteID \
         LEFT JOIN Players b ON b.ID = g.BlackID \
         LEFT JOIN Events e ON e.ID = g.EventID \
         LEFT JOIN Sites s ON s.ID = g.SiteID \
         WHERE g.ID = ?1",
    )?;
    let mut out = Vec::with_capacity(ids.len().min(MAX_GAMES));
    for id in ids.iter().take(MAX_GAMES) {
        let mut rows = stmt.query([i64::from(*id)])?;
        let Some(row) = rows.next()? else {
            continue;
        };
        let fen = text_of(row.get_ref(11)?);
        let moves = match row.get_ref(12)? {
            ValueRef::Blob(blob) => mainline_movetext(fen.as_deref(), blob).unwrap_or_default(),
            _ => String::new(),
        };
        out.push(IndexGame {
            id: *id,
            white: text_of(row.get_ref(1)?).unwrap_or_default(),
            black: text_of(row.get_ref(2)?).unwrap_or_default(),
            white_elo: opt_u32(row.get_ref(3)?),
            black_elo: opt_u32(row.get_ref(4)?),
            result: outcome(text_of(row.get_ref(5)?).as_deref()),
            date: text_of(row.get_ref(6)?),
            event: text_of(row.get_ref(7)?).unwrap_or_default(),
            site: text_of(row.get_ref(8)?).unwrap_or_default(),
            eco: text_of(row.get_ref(9)?),
            ply_count: opt_u32(row.get_ref(10)?),
            fen,
            moves,
        });
    }
    Ok(out)
}

/// The app's `Outcome` mapping (`src-tauri/src/db/models.rs`): the three
/// PGN results pass through, anything else is `*`.
fn outcome(s: Option<&str>) -> String {
    let token = match s {
        Some("1-0") => "1-0",
        Some("0-1") => "0-1",
        Some("1/2-1/2") => "1/2-1/2",
        _ => "*",
    };
    token.to_string()
}

fn opt_u32(v: ValueRef<'_>) -> Option<u32> {
    match v {
        ValueRef::Integer(i) => u32::try_from(i).ok(),
        ValueRef::Real(f) if f >= 0.0 => Some(f as u32),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_follows_the_app_mapping() {
        assert_eq!(outcome(Some("1-0")), "1-0");
        assert_eq!(outcome(Some("0-1")), "0-1");
        assert_eq!(outcome(Some("1/2-1/2")), "1/2-1/2");
        assert_eq!(outcome(Some("*")), "*");
        assert_eq!(outcome(Some("2-0")), "*");
        assert_eq!(outcome(None), "*");
        assert_eq!(opt_u32(ValueRef::Integer(-5)), None);
        assert_eq!(opt_u32(ValueRef::Integer(2400)), Some(2400));
        assert_eq!(opt_u32(ValueRef::Text(b" 2500 ")), Some(2500));
        assert_eq!(opt_u32(ValueRef::Null), None);
    }
}
