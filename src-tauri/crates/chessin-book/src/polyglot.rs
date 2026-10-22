//! Polyglot (`.bin`) opening books.
//!
//! A book is a sorted array of 16-byte big-endian entries:
//!
//! ```text
//! key u64    Polyglot Zobrist key of the position
//! move u16   to_file:3 | to_rank:3 | from_file:3 | from_rank:3 | promotion:3 (0 none, 1 N, 2 B, 3 R, 4 Q)
//! weight u16 relative frequency / quality
//! learn u32  engine learning data, usually 0
//! ```
//!
//! Castling is encoded as the king moving onto its own rook (`e1h1`, `e1a1`,
//! `e8h8`, `e8a8`); some generators write `e1g1` instead, which is accepted
//! too. The key is the standard Polyglot Zobrist hash, which shakmaty's
//! `Zobrist64` reproduces: the en-passant file is hashed only when an enemy
//! pawn stands next to the pawn that just moved two squares, pins ignored
//! (`EnPassantMode::PseudoLegal`).

use std::fs::File;
use std::path::Path;

use memmap2::Mmap;
use shakmaty::{
    san::SanPlus,
    zobrist::{Zobrist64, ZobristHash},
    CastlingMode, Chess, EnPassantMode, File as BoardFile, Move, Position, Rank, Role, Square,
};

use crate::{parse_fen, Error};

/// Size of one book entry in bytes.
pub const ENTRY_SIZE: usize = 16;

/// One move of a position in the book.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct BookMove {
    /// Standard UCI (`e1g1` for castling).
    pub uci: String,
    /// SAN with check/mate suffix.
    pub san: String,
    /// The entry's weight as stored; the share of a move is its weight over
    /// the sum of the position's weights.
    pub weight: u16,
    /// The entry's learn field as stored (0 in most books).
    pub learn: u32,
}

/// What `book_info` tells about a file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct BookInfo {
    /// `"polyglot"` or `"ctg"`.
    pub format: String,
    /// Polyglot: the number of whole 16-byte entries. `None` for CTG, which
    /// is not read.
    pub entries: Option<u64>,
    /// File size.
    pub bytes: u64,
}

/// The Polyglot Zobrist key of a position.
pub fn key(pos: &Chess) -> u64 {
    pos.zobrist_hash::<Zobrist64>(EnPassantMode::PseudoLegal).0
}

/// `true` for ChessBase `.ctg` books (and their `.ctb`/`.cto` siblings).
pub fn is_ctg(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("ctg" | "ctb" | "cto")
    )
}

fn unsupported_ctg() -> Error {
    Error::Unsupported("CTG books are not supported yet; use a Polyglot .bin book".to_string())
}

/// An open Polyglot book: the file stays memory-mapped, only the entries of a
/// looked-up position are touched.
pub struct Book {
    /// `None` for an empty file (which cannot be mapped).
    map: Option<Mmap>,
    entries: usize,
}

impl Book {
    /// Maps the file. A `.ctg` is [`Error::Unsupported`]; a trailing partial
    /// entry is ignored.
    pub fn open(path: &Path) -> Result<Book, Error> {
        if is_ctg(path) {
            return Err(unsupported_ctg());
        }
        let file = File::open(path)?;
        let len = file.metadata()?.len() as usize;
        if len < ENTRY_SIZE {
            return Ok(Book {
                map: None,
                entries: 0,
            });
        }
        // SAFETY: the map is read-only and the book is a data file nothing
        // else in the process writes to; a concurrent external change could
        // at worst make a lookup return garbage moves, which `decode_move`
        // drops as illegal.
        let map = unsafe { Mmap::map(&file)? };
        let entries = map.len() / ENTRY_SIZE;
        Ok(Book {
            map: Some(map),
            entries,
        })
    }

    /// Number of whole entries in the file.
    pub fn len(&self) -> usize {
        self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries == 0
    }

    fn entry(&self, i: usize) -> (u64, u16, u16, u32) {
        let b =
            &self.map.as_ref().expect("entries > 0 implies a map")[i * ENTRY_SIZE..][..ENTRY_SIZE];
        (
            u64::from_be_bytes(b[0..8].try_into().expect("8 bytes")),
            u16::from_be_bytes([b[8], b[9]]),
            u16::from_be_bytes([b[10], b[11]]),
            u32::from_be_bytes(b[12..16].try_into().expect("4 bytes")),
        )
    }

    fn key_at(&self, i: usize) -> u64 {
        let b = &self.map.as_ref().expect("entries > 0 implies a map")[i * ENTRY_SIZE..][..8];
        u64::from_be_bytes(b.try_into().expect("8 bytes"))
    }

    /// Index of the first entry whose key is `>= key`.
    fn lower_bound(&self, key: u64) -> usize {
        let (mut lo, mut hi) = (0usize, self.entries);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if self.key_at(mid) < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    /// The book's moves for `pos`, heaviest first (ties by UCI). Entries whose
    /// move is not legal in the position are dropped.
    pub fn lookup(&self, pos: &Chess) -> Vec<BookMove> {
        if self.entries == 0 {
            return Vec::new();
        }
        let wanted = key(pos);
        let mut moves = Vec::new();
        let mut i = self.lower_bound(wanted);
        while i < self.entries {
            let (k, code, weight, learn) = self.entry(i);
            if k != wanted {
                break;
            }
            if let Some(m) = decode_move(code, pos) {
                moves.push(BookMove {
                    uci: m.to_uci(CastlingMode::Standard).to_string(),
                    san: SanPlus::from_move(pos.clone(), &m).to_string(),
                    weight,
                    learn,
                });
            }
            i += 1;
        }
        moves.sort_by(|a, b| b.weight.cmp(&a.weight).then_with(|| a.uci.cmp(&b.uci)));
        moves
    }

    /// [`Book::lookup`] of a FEN.
    pub fn lookup_fen(&self, fen: &str) -> Result<Vec<BookMove>, Error> {
        Ok(self.lookup(&parse_fen(fen)?))
    }
}

/// The book's moves for `fen`: opens the file, looks the position up, done.
/// Callers that query repeatedly should keep a [`Book`] instead.
pub fn lookup(path: &Path, fen: &str) -> Result<Vec<BookMove>, Error> {
    Book::open(path)?.lookup_fen(fen)
}

/// Format and size of a book file without reading its entries.
pub fn info(path: &Path) -> Result<BookInfo, Error> {
    let bytes = std::fs::metadata(path)?.len();
    Ok(if is_ctg(path) {
        BookInfo {
            format: "ctg".to_string(),
            entries: None,
            bytes,
        }
    } else {
        BookInfo {
            format: "polyglot".to_string(),
            entries: Some(bytes / ENTRY_SIZE as u64),
            bytes,
        }
    })
}

/// Decodes a Polyglot move code into the legal move of `pos` it names, if
/// there is one.
pub fn decode_move(code: u16, pos: &Chess) -> Option<Move> {
    let square = |file: u16, rank: u16| {
        Square::from_coords(BoardFile::new(u32::from(file)), Rank::new(u32::from(rank)))
    };
    let to = square(code & 7, (code >> 3) & 7);
    let from = square((code >> 6) & 7, (code >> 9) & 7);
    let promotion = match (code >> 12) & 7 {
        0 => None,
        1 => Some(Role::Knight),
        2 => Some(Role::Bishop),
        3 => Some(Role::Rook),
        4 => Some(Role::Queen),
        _ => return None,
    };
    let legal = pos.legal_moves();
    // A castle is `Move::Castle { king, rook }` with `from() == king` and
    // `to() == rook`, so the spec's king-takes-rook encoding matches here.
    if let Some(m) = legal
        .iter()
        .find(|m| m.from() == Some(from) && m.to() == to && m.promotion() == promotion)
    {
        return Some(m.clone());
    }
    // Books written with `e1g1`-style castling.
    if promotion.is_none() && from.rank() == to.rank() {
        let side = match (from.file().char(), to.file().char()) {
            ('e', 'g') => Some(true),
            ('e', 'c') => Some(false),
            _ => None,
        }?;
        return legal
            .iter()
            .find(|m| match m {
                Move::Castle { king, rook } => *king == from && (rook.file() > king.file()) == side,
                _ => false,
            })
            .cloned();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const AFTER_E4: &str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

    fn entry(key: u64, code: u16, weight: u16, learn: u32) -> [u8; 16] {
        let mut b = [0u8; 16];
        b[0..8].copy_from_slice(&key.to_be_bytes());
        b[8..10].copy_from_slice(&code.to_be_bytes());
        b[10..12].copy_from_slice(&weight.to_be_bytes());
        b[12..16].copy_from_slice(&learn.to_be_bytes());
        b
    }

    /// `from_sq`/`to_sq` as 0–63 with a1 = 0, plus the promotion nibble.
    fn code(from: &str, to: &str, promo: u16) -> u16 {
        let sq = |s: &str| {
            let b = s.as_bytes();
            (u16::from(b[1] - b'1') << 3) | u16::from(b[0] - b'a')
        };
        (promo << 12) | (sq(from) << 6) | sq(to)
    }

    fn write_book(entries: &[[u8; 16]], extra: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::Builder::new().suffix(".bin").tempfile().unwrap();
        for e in entries {
            f.write_all(e).unwrap();
        }
        f.write_all(extra).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn keys_match_the_polyglot_specification_examples() {
        // The example keys published with the Polyglot book format; the d6
        // and f6 cases cover the "en passant only when capturable" rule.
        let cases = [
            (START, 0x463b96181691fc9c_u64),
            (AFTER_E4, 0x823c9b50fd114196),
            (
                "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
                0x0756b94461c50fb0,
            ),
            (
                "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
                0x662fafb965db29d4,
            ),
            (
                "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
                0x22a48b5a8e47ff78,
            ),
            (
                "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR b kq - 0 3",
                0x652a607ca3f242c1,
            ),
            (
                "rnbq1bnr/ppp1pkpp/8/3pPp2/8/8/PPPPKPPP/RNBQ1BNR w - - 0 4",
                0x00fdd303c946bdd9,
            ),
            (
                "rnbqkbnr/p1pppppp/8/8/PpP4P/8/1P1PPPP1/RNBQKBNR b KQkq c3 0 3",
                0x3c8123ea7b067637,
            ),
            (
                "rnbqkbnr/p1pppppp/8/8/P6P/R1p5/1P1PPPP1/1NBQKBNR b Kkq - 0 4",
                0x5c3f9b829b279560,
            ),
        ];
        for (fen, expected) in cases {
            assert_eq!(key(&parse_fen(fen).unwrap()), expected, "{fen}");
        }
    }

    /// The reader the app uses for engine play computes the same keys
    /// (except where it hashes a decorative en-passant square, which the
    /// specification says not to).
    #[test]
    fn keys_match_polyglot_book_rs() {
        // `AFTER_E4` is left out: its decorative `e3` is hashed by that reader.
        for fen in [
            START,
            "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
            "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
            "8/P6k/8/8/8/8/8/K7 w - - 0 1",
        ] {
            assert_eq!(
                key(&parse_fen(fen).unwrap()),
                polyglot_book_rs::polyglot_hash_from_fen(fen).unwrap(),
                "{fen}"
            );
        }
    }

    #[test]
    fn lookup_reads_hand_written_entries() {
        let start = 0x463b96181691fc9c;
        let after_e4 = 0x823c9b50fd114196;
        let file = write_book(
            &[
                entry(start, code("d2", "d4", 0), 50, 0),
                entry(start, code("e2", "e4", 0), 100, 7),
                entry(start, code("g1", "f3", 0), 50, 0),
                entry(after_e4, code("e7", "e5", 0), 60, 1),
            ],
            &[],
        );
        let book = Book::open(file.path()).unwrap();
        assert_eq!(book.len(), 4);

        let moves = book.lookup_fen(START).unwrap();
        assert_eq!(
            moves,
            vec![
                BookMove {
                    uci: "e2e4".into(),
                    san: "e4".into(),
                    weight: 100,
                    learn: 7
                },
                BookMove {
                    uci: "d2d4".into(),
                    san: "d4".into(),
                    weight: 50,
                    learn: 0
                },
                BookMove {
                    uci: "g1f3".into(),
                    san: "Nf3".into(),
                    weight: 50,
                    learn: 0
                },
            ]
        );
        let reply = book.lookup_fen(AFTER_E4).unwrap();
        assert_eq!(reply.len(), 1);
        assert_eq!(
            (reply[0].uci.as_str(), reply[0].san.as_str()),
            ("e7e5", "e5")
        );

        // A position the book does not know.
        assert!(book
            .lookup_fen("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1")
            .unwrap()
            .is_empty());

        // The one-shot helper reads the same.
        assert_eq!(lookup(file.path(), START).unwrap().len(), 3);
    }

    #[test]
    fn castling_and_promotion_are_decoded() {
        let castle_fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
        let castle = parse_fen(castle_fen).unwrap();
        let promo_fen = "8/P6k/8/8/8/8/8/K7 w - - 0 1";
        let promo = parse_fen(promo_fen).unwrap();
        let (k1, k2) = (key(&castle), key(&promo));
        // Entries must be sorted by key in the file.
        let mut entries = vec![
            (k1, entry(k1, code("e1", "h1", 0), 90, 0)),
            (k1, entry(k1, code("e1", "a1", 0), 80, 0)),
            // A generator that writes the king's destination instead.
            (k1, entry(k1, code("e1", "g1", 0), 70, 0)),
            (k2, entry(k2, code("a7", "a8", 4), 10, 0)),
            (k2, entry(k2, code("a7", "a8", 1), 5, 0)),
        ];
        entries.sort_by_key(|(k, _)| *k);
        let file = write_book(
            &entries.into_iter().map(|(_, e)| e).collect::<Vec<_>>(),
            &[],
        );
        let book = Book::open(file.path()).unwrap();

        let castles = book.lookup(&castle);
        assert_eq!(
            castles
                .iter()
                .map(|m| (m.uci.as_str(), m.san.as_str(), m.weight))
                .collect::<Vec<_>>(),
            vec![
                ("e1g1", "O-O", 90),
                ("e1c1", "O-O-O", 80),
                ("e1g1", "O-O", 70)
            ]
        );

        let promos = book.lookup(&promo);
        assert_eq!(
            promos
                .iter()
                .map(|m| (m.uci.as_str(), m.san.as_str()))
                .collect::<Vec<_>>(),
            vec![("a7a8q", "a8=Q"), ("a7a8n", "a8=N")]
        );
    }

    #[test]
    fn illegal_entries_and_trailing_bytes_are_ignored() {
        let start = 0x463b96181691fc9c;
        let file = write_book(
            &[
                entry(start, code("e2", "e5", 0), 100, 0), // a pawn cannot jump three
                entry(start, code("e2", "e4", 5), 100, 0), // promotion code 5 is invalid
                entry(start, code("e2", "e4", 0), 1, 0),
            ],
            &[1, 2, 3],
        );
        let book = Book::open(file.path()).unwrap();
        assert_eq!(book.len(), 3);
        let moves = book.lookup_fen(START).unwrap();
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].uci, "e2e4");
    }

    #[test]
    fn info_reports_format_and_size_and_ctg_is_refused() {
        let file = write_book(&[entry(1, 0, 0, 0), entry(2, 0, 0, 0)], &[0; 5]);
        assert_eq!(
            info(file.path()).unwrap(),
            BookInfo {
                format: "polyglot".into(),
                entries: Some(2),
                bytes: 37
            }
        );

        let dir = tempfile::tempdir().unwrap();
        let ctg = dir.path().join("Book.CTG");
        std::fs::write(&ctg, [0u8; 100]).unwrap();
        assert_eq!(
            info(&ctg).unwrap(),
            BookInfo {
                format: "ctg".into(),
                entries: None,
                bytes: 100
            }
        );
        assert!(matches!(lookup(&ctg, START), Err(Error::Unsupported(_))));
        assert!(matches!(
            lookup(&dir.path().join("missing.bin"), START),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn empty_and_short_files_are_empty_books() {
        let file = write_book(&[], &[]);
        let book = Book::open(file.path()).unwrap();
        assert!(book.is_empty());
        assert!(book.lookup_fen(START).unwrap().is_empty());
        let short = write_book(&[], &[0; 15]);
        assert!(Book::open(short.path()).unwrap().is_empty());
    }

    #[test]
    fn lower_bound_finds_the_first_of_a_run_in_a_large_book() {
        // 1000 keys with several entries each, written in order.
        let mut entries = Vec::new();
        for k in 0..1000u64 {
            let key = 0x1000 + k * 3;
            for j in 0..3u16 {
                entries.push(entry(key, j, j, 0));
            }
        }
        let file = write_book(&entries, &[]);
        let book = Book::open(file.path()).unwrap();
        assert_eq!(book.lower_bound(0x1000), 0);
        assert_eq!(book.lower_bound(0x1000 + 3 * 500), 1500);
        assert_eq!(book.lower_bound(0x1000 + 3 * 500 + 1), 1503);
        assert_eq!(book.lower_bound(u64::MAX), 3000);
    }
}
