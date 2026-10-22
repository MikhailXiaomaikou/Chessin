//! Opening books and endgame tablebases as position sources (S4-4), with no
//! Tauri in sight.
//!
//! * [`polyglot`]: lookups in Polyglot (`.bin`) opening books. The file is
//!   memory-mapped and binary-searched by the Polyglot Zobrist key, which is
//!   shakmaty's [`Zobrist64`](shakmaty::zobrist::Zobrist64) (the two are the
//!   same table; the start position hashes to `0x463b96181691fc9c`). Every
//!   entry of a position comes back with its `weight` and `learn` fields, the
//!   move decoded into UCI and SAN; entries whose move is not legal in the
//!   position (hash collisions, corrupt files) are dropped.
//!
//!   CTG (ChessBase) books are recognised by extension so the UI can say what
//!   the file is, but they are **not read**: a clean-room reader needs the
//!   position bit-packing, the page hash and the move-encoding table of the
//!   format, and none of those is known here well enough to get right. A
//!   `.ctg` lookup is [`Error::Unsupported`].
//!
//! * [`syzygy`]: WDL/DTZ probing of Syzygy tables (up to 7 pieces) through
//!   `shakmaty-syzygy`. The tables of a directory are listed once and opened
//!   lazily on the first probe that needs them; the caller keeps the
//!   [`syzygy::Tables`] value alive to keep that cache. The move list of a
//!   probe is ordered best-first for the side to move (see
//!   [`syzygy::order_moves`]), through the [`syzygy::Prober`] trait so the
//!   ordering is testable without table files.

pub mod polyglot;
pub mod syzygy;

use shakmaty::{fen::Fen, CastlingMode, Chess};

pub use polyglot::{BookInfo, BookMove};
pub use syzygy::{Prober, TablebaseMove, TablebaseProbe, TablebaseStatus, Tables};

/// What can go wrong when reading a book or probing tables.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// The FEN could not be parsed or is not a legal standard-chess position.
    #[error("invalid FEN: {0}")]
    Fen(String),
    /// A book format this crate does not read (CTG).
    #[error("{0}")]
    Unsupported(String),
    /// A table file is corrupt or could not be read.
    #[error("tablebase probe failed: {0}")]
    Syzygy(String),
}

/// Parses a FEN into a standard-chess position (Chess960 castling rights are
/// accepted too, so a book or table lookup never fails on a 960 FEN).
pub fn parse_fen(fen: &str) -> Result<Chess, Error> {
    let setup = Fen::from_ascii(fen.trim().as_bytes()).map_err(|e| Error::Fen(e.to_string()))?;
    match setup.clone().into_position::<Chess>(CastlingMode::Standard) {
        Ok(pos) => Ok(pos),
        Err(standard) => {
            let standard = standard.to_string();
            setup
                .into_position::<Chess>(CastlingMode::Chess960)
                .map_err(|_| Error::Fen(standard))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fen_accepts_standard_and_rejects_garbage() {
        assert!(parse_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").is_ok());
        assert!(parse_fen(" 8/8/8/8/8/4k3/8/4K2Q w - - 0 1 ").is_ok());
        assert!(matches!(parse_fen("not a fen"), Err(Error::Fen(_))));
        // Two white kings: a setup that is not a legal position.
        assert!(matches!(
            parse_fen("k7/8/8/8/8/8/8/KK6 w - - 0 1"),
            Err(Error::Fen(_))
        ));
    }
}
