//! The database's one-byte move encoding, re-implemented so the index does
//! not depend on the app crate.
//!
//! A ply is the index of the move in shakmaty's legal-move list for the
//! position it is played from (`src-tauri/src/db/encoding.rs`). The `Moves`
//! blob also carries variations, comments and NAGs behind the marker bytes
//! below; [`mainline_moves`] walks the main line only, exactly as the
//! upstream iterator does. The equivalence tests at the bottom run both
//! implementations over random games.

use shakmaty::{fen::Fen, CastlingMode, Chess, FromSetup, Move, Position, PositionError};

use crate::Error;

pub const VARIATION_START_MARKER: u8 = 255;
pub const VARIATION_END_MARKER: u8 = 254;
pub const COMMENT_MARKER: u8 = 253;
pub const NAG_MARKER: u8 = 252;

/// The code of `m` from `pos`; `None` when `m` is not legal there.
pub fn encode_move(m: &Move, pos: &Chess) -> Option<u8> {
    pos.legal_moves()
        .iter()
        .position(|x| x == m)
        .map(|i| i as u8)
}

/// The move with code `byte` from `pos`; `None` when the code is out of range.
pub fn decode_move(byte: u8, pos: &Chess) -> Option<Move> {
    pos.legal_moves().get(usize::from(byte)).cloned()
}

/// The main-line move bytes of a `Moves` blob, skipping variations, comments
/// and NAGs. A truncated comment or NAG length ends the iteration.
pub fn mainline_moves(bytes: &[u8]) -> MainlineMoves<'_> {
    MainlineMoves {
        bytes,
        cursor: 0,
        depth: 0,
    }
}

pub struct MainlineMoves<'a> {
    bytes: &'a [u8],
    cursor: usize,
    depth: usize,
}

impl Iterator for MainlineMoves<'_> {
    type Item = u8;

    fn next(&mut self) -> Option<u8> {
        while self.cursor < self.bytes.len() {
            let byte = self.bytes[self.cursor];
            self.cursor += 1;
            match byte {
                VARIATION_START_MARKER => self.depth = self.depth.saturating_add(1),
                VARIATION_END_MARKER => self.depth = self.depth.saturating_sub(1),
                COMMENT_MARKER | NAG_MARKER => {
                    if self.cursor + 2 > self.bytes.len() {
                        return None;
                    }
                    let len = usize::from(u16::from_le_bytes([
                        self.bytes[self.cursor],
                        self.bytes[self.cursor + 1],
                    ]));
                    self.cursor += 2;
                    self.cursor = self.cursor.saturating_add(len).min(self.bytes.len());
                }
                _ if self.depth == 0 => return Some(byte),
                _ => {}
            }
        }
        None
    }
}

/// The position a game starts from: the standard start when `fen` is `None`,
/// otherwise the FEN parsed as leniently as the app does (castling mode
/// detected, too much material allowed).
pub fn start_position(fen: Option<&str>) -> Result<Chess, Error> {
    match fen {
        None => Ok(Chess::default()),
        Some(fen) => parse_fen(fen),
    }
}

/// Parses a FEN into a position, as leniently as the app does.
pub fn parse_fen(fen: &str) -> Result<Chess, Error> {
    let fen = Fen::from_ascii(fen.trim().as_bytes()).map_err(|e| Error::Fen(e.to_string()))?;
    let setup = fen.into_setup();
    let mode = CastlingMode::detect(&setup);
    Chess::from_setup(setup, mode)
        .or_else(PositionError::ignore_too_much_material)
        .map_err(|e| Error::Fen(e.to_string()))
}

/// The main line of a `Moves` blob as SAN movetext — `1. e4 e5 2. Nf3`, or
/// `3... Nf6 4. e3` when the start position has Black to move — numbered
/// from the start position's move number. Variations, comments and NAGs
/// are left out. A byte that does not decode is an error.
pub fn mainline_movetext(fen: Option<&str>, blob: &[u8]) -> Result<String, Error> {
    use std::fmt::Write as _;
    let mut pos = start_position(fen)?;
    let mut number = pos.fullmoves().get();
    let mut white = pos.turn().is_white();
    let mut out = String::new();
    for (i, code) in mainline_moves(blob).enumerate() {
        let m = decode_move(code, &pos).ok_or_else(|| {
            Error::InvalidArgument(format!("move byte {code} at ply {i} does not decode"))
        })?;
        let san = shakmaty::san::SanPlus::from_move_and_play_unchecked(&mut pos, &m);
        if !out.is_empty() {
            out.push(' ');
        }
        if white {
            let _ = write!(out, "{number}. {san}");
        } else {
            if i == 0 {
                let _ = write!(out, "{number}... ");
            }
            let _ = write!(out, "{san}");
            number += 1;
        }
        white = !white;
    }
    Ok(out)
}

/// Encodes a line of UCI moves from `fen` (or the start position) into the
/// database's one-byte codes; a test helper for callers that write synthetic
/// databases.
pub fn encode_uci_line(fen: Option<&str>, ucis: &[&str]) -> Result<Vec<u8>, Error> {
    let mut pos = start_position(fen)?;
    let mut out = Vec::with_capacity(ucis.len());
    for uci in ucis {
        let m = uci
            .parse::<shakmaty::uci::UciMove>()
            .map_err(|e| Error::InvalidArgument(format!("{uci}: {e}")))?
            .to_move(&pos)
            .map_err(|e| Error::InvalidArgument(format!("{uci}: {e}")))?;
        let code = encode_move(&m, &pos)
            .ok_or_else(|| Error::InvalidArgument(format!("{uci}: illegal")))?;
        out.push(code);
        pos.play_unchecked(&m);
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod rng {
    /// SplitMix64: deterministic, dependency-free randomness for the tests.
    pub struct Rng(pub u64);

    impl Rng {
        pub fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        /// A number in `0..n` (`n > 0`).
        pub fn below(&mut self, n: usize) -> usize {
            (self.next_u64() % n as u64) as usize
        }
    }

    /// Plays random legal moves from `start` for up to `max_plies` plies and
    /// returns the position before each move together with the move.
    pub fn random_game(
        rng: &mut Rng,
        start: &shakmaty::Chess,
        max_plies: usize,
    ) -> Vec<(shakmaty::Chess, shakmaty::Move)> {
        use shakmaty::Position;
        let mut pos = start.clone();
        let mut out = Vec::new();
        for _ in 0..max_plies {
            let legal = pos.legal_moves();
            if legal.is_empty() {
                break;
            }
            let m = legal[rng.below(legal.len())].clone();
            out.push((pos.clone(), m.clone()));
            pos.play_unchecked(&m);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::rng::Rng;
    use super::*;

    // ----- vendored from src-tauri/src/db/encoding.rs (upstream En Croissant) -----
    // The three items below are copied verbatim from the app crate (only the
    // error type of `encode_move` is dropped) so the tests prove that this
    // crate's codec is byte-for-byte the database's.
    mod upstream {
        use shakmaty::{Chess, Move, Position};

        pub const VARIATION_START_MARKER: u8 = 255;
        pub const VARIATION_END_MARKER: u8 = 254;
        pub const COMMENT_MARKER: u8 = 253;
        pub const NAG_MARKER: u8 = 252;

        pub fn encode_move(m: &Move, chess: &Chess) -> u8 {
            let moves = chess.legal_moves();
            moves.iter().position(|x| x == m).unwrap() as u8
        }

        pub fn decode_move(byte: u8, chess: &Chess) -> Option<Move> {
            let legal_moves = chess.legal_moves();
            legal_moves.get(byte as usize).cloned()
        }

        pub struct MainlineMoveBytesIter<'a> {
            bytes: &'a [u8],
            cursor: usize,
            variation_depth: usize,
        }

        impl<'a> MainlineMoveBytesIter<'a> {
            pub fn new(bytes: &'a [u8]) -> Self {
                Self {
                    bytes,
                    cursor: 0,
                    variation_depth: 0,
                }
            }
        }

        impl Iterator for MainlineMoveBytesIter<'_> {
            type Item = u8;

            fn next(&mut self) -> Option<Self::Item> {
                while self.cursor < self.bytes.len() {
                    let byte = self.bytes[self.cursor];
                    self.cursor += 1;

                    match byte {
                        VARIATION_START_MARKER => {
                            self.variation_depth = self.variation_depth.saturating_add(1);
                        }
                        VARIATION_END_MARKER => {
                            self.variation_depth = self.variation_depth.saturating_sub(1);
                        }
                        COMMENT_MARKER => {
                            if self.cursor + 2 > self.bytes.len() {
                                return None;
                            }
                            let len = u16::from_le_bytes([
                                self.bytes[self.cursor],
                                self.bytes[self.cursor + 1],
                            ]) as usize;
                            self.cursor += 2;
                            self.cursor = self.cursor.saturating_add(len).min(self.bytes.len());
                        }
                        NAG_MARKER => {
                            if self.cursor + 2 > self.bytes.len() {
                                return None;
                            }
                            let len = u16::from_le_bytes([
                                self.bytes[self.cursor],
                                self.bytes[self.cursor + 1],
                            ]) as usize;
                            self.cursor += 2;
                            self.cursor = self.cursor.saturating_add(len).min(self.bytes.len());
                        }
                        _ if self.variation_depth == 0 => return Some(byte),
                        _ => {}
                    }
                }

                None
            }
        }
    }
    // ----- end of vendored code -----

    #[test]
    fn codec_matches_upstream_on_thousands_of_random_games() {
        let mut rng = Rng(0x5EED);
        let mut plies = 0usize;
        for _ in 0..2500 {
            for (pos, m) in super::rng::random_game(&mut rng, &Chess::default(), 120) {
                let ours = encode_move(&m, &pos).expect("legal move encodes");
                assert_eq!(ours, upstream::encode_move(&m, &pos));
                assert_eq!(decode_move(ours, &pos), upstream::decode_move(ours, &pos));
                assert_eq!(decode_move(ours, &pos).as_ref(), Some(&m));
                // Every code, in range or not, decodes identically.
                let count = pos.legal_moves().len();
                for byte in [0u8, (count - 1) as u8, count as u8, 200, 251, 255] {
                    assert_eq!(decode_move(byte, &pos), upstream::decode_move(byte, &pos));
                }
                plies += 1;
            }
        }
        assert!(plies > 100_000, "{plies} plies compared");
    }

    #[test]
    fn mainline_iterator_matches_upstream_on_random_blobs() {
        let mut rng = Rng(42);
        for _ in 0..3000 {
            let len = rng.below(64);
            let mut bytes = Vec::with_capacity(len + 8);
            for _ in 0..len {
                // Markers are frequent so nesting, lengths and truncation occur.
                bytes.push(match rng.below(10) {
                    0 => VARIATION_START_MARKER,
                    1 => VARIATION_END_MARKER,
                    2 => COMMENT_MARKER,
                    3 => NAG_MARKER,
                    _ => rng.below(252) as u8,
                });
            }
            let ours: Vec<u8> = mainline_moves(&bytes).collect();
            let theirs: Vec<u8> = upstream::MainlineMoveBytesIter::new(&bytes).collect();
            assert_eq!(ours, theirs, "{bytes:?}");
        }
    }

    #[test]
    fn mainline_iterator_skips_variations_comments_and_nags() {
        let bytes = vec![
            1,
            NAG_MARKER,
            2,
            0,
            b'!',
            b'!',
            VARIATION_START_MARKER,
            2,
            VARIATION_START_MARKER,
            3,
            VARIATION_END_MARKER,
            COMMENT_MARKER,
            3,
            0,
            b'f',
            b'o',
            b'o',
            4,
            VARIATION_END_MARKER,
            COMMENT_MARKER,
            3,
            0,
            b'b',
            b'a',
            b'r',
            5,
        ];
        assert_eq!(mainline_moves(&bytes).collect::<Vec<_>>(), vec![1, 5]);
        // A truncated length ends the main line.
        assert_eq!(
            mainline_moves(&[7, COMMENT_MARKER, 1]).collect::<Vec<_>>(),
            vec![7]
        );
    }

    #[test]
    fn start_position_and_uci_lines() {
        assert_eq!(start_position(None).unwrap(), Chess::default());
        let after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let pos = start_position(Some(after_e4)).unwrap();
        assert_eq!(pos.turn(), shakmaty::Color::Black);
        assert!(start_position(Some("not a fen")).is_err());
        // Too much material (ten queens) is tolerated, as in the app.
        assert!(start_position(Some("4k3/8/8/8/8/8/QQQ5/QQQQKQQQ w - - 0 1")).is_ok());

        let line = encode_uci_line(None, &["e2e4", "e7e5", "g1f3"]).unwrap();
        let mut pos = Chess::default();
        for (code, uci) in line.iter().zip(["e2e4", "e7e5", "g1f3"]) {
            let m = decode_move(*code, &pos).unwrap();
            assert_eq!(m.to_uci(CastlingMode::Standard).to_string(), uci);
            pos.play_unchecked(&m);
        }
        assert!(encode_uci_line(None, &["e2e5"]).is_err());
    }

    #[test]
    fn mainline_movetext_numbers_moves_and_skips_decorations() {
        let line = encode_uci_line(None, &["e2e4", "e7e5", "g1f3"]).unwrap();
        assert_eq!(mainline_movetext(None, &line).unwrap(), "1. e4 e5 2. Nf3");
        assert_eq!(mainline_movetext(None, &[]).unwrap(), "");

        // Decorations between the moves are not rendered.
        let mut decorated = vec![line[0], COMMENT_MARKER, 2, 0, b'h', b'i'];
        decorated.push(VARIATION_START_MARKER);
        decorated.push(0);
        decorated.push(VARIATION_END_MARKER);
        decorated.push(line[1]);
        decorated.push(NAG_MARKER);
        decorated.push(2);
        decorated.push(0);
        decorated.extend_from_slice(b"$1");
        decorated.push(line[2]);
        assert_eq!(
            mainline_movetext(None, &decorated).unwrap(),
            "1. e4 e5 2. Nf3"
        );

        // Black to move first, and a later move number from the FEN.
        let after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let reply = encode_uci_line(Some(after_e4), &["e7e5", "g1f3", "b8c6"]).unwrap();
        assert_eq!(
            mainline_movetext(Some(after_e4), &reply).unwrap(),
            "1... e5 2. Nf3 Nc6"
        );
        let later = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 10";
        let bishop = encode_uci_line(Some(later), &["f1b5", "a7a6"]).unwrap();
        assert_eq!(
            mainline_movetext(Some(later), &bishop).unwrap(),
            "10. Bb5 a6"
        );
        // Checks and mates get their suffixes; an undecodable byte is an error.
        let mate = encode_uci_line(None, &["f2f3", "e7e5", "g2g4", "d8h4"]).unwrap();
        assert_eq!(
            mainline_movetext(None, &mate).unwrap(),
            "1. f3 e5 2. g4 Qh4#"
        );
        assert!(mainline_movetext(None, &[12, 250]).is_err());
    }
}
