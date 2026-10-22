//! Position and pawn-structure hashes, and the per-game bloom filter.

use shakmaty::{
    zobrist::{Zobrist64, ZobristHash},
    Board, Chess, EnPassantMode, Position,
};

use crate::moves::parse_fen;
use crate::Error;

/// The 64-bit Zobrist hash of a position: board, side to move, castling
/// rights, and the en-passant square only when an en-passant capture is
/// legal (`EnPassantMode::Legal`), so a FEN with or without a decorative
/// en-passant square hashes the same.
pub fn position_hash(pos: &Chess) -> u64 {
    pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0
}

/// [`position_hash`] of a FEN.
pub fn position_hash_of_fen(fen: &str) -> Result<u64, Error> {
    Ok(position_hash(&parse_fen(fen)?))
}

/// A hash of the pawn structure only: the white and black pawn bitboards.
pub fn pawn_hash(board: &Board) -> u64 {
    let white = (board.white() & board.pawns()).0;
    let black = (board.black() & board.pawns()).0;
    mix64(white.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ black.rotate_left(29) ^ 0x5851_F42D_4C95_7F2D)
}

/// [`pawn_hash`] of the board of a FEN.
pub fn pawn_hash_of_fen(fen: &str) -> Result<u64, Error> {
    Ok(pawn_hash(parse_fen(fen)?.board()))
}

/// The ply a FEN describes: `(fullmove - 1) * 2`, plus one with Black to move.
pub fn fen_ply(fen: &str) -> Option<u32> {
    let mut fields = fen.split_whitespace();
    let _board = fields.next()?;
    let turn = fields.next().unwrap_or("w");
    let fullmove: u32 = fields.nth(3).and_then(|f| f.parse().ok()).unwrap_or(1);
    Some(fullmove.saturating_sub(1) * 2 + u32::from(turn == "b"))
}

fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The plies at which a game's pawn structure goes into its bloom filter.
pub const BLOOM_PLIES: [u16; 6] = [10, 20, 30, 40, 50, 60];

/// A 256-bit bloom filter with three probes per key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Bloom256(pub [u8; 32]);

impl Bloom256 {
    fn probes(key: u64) -> [u8; 3] {
        [key as u8, (key >> 8) as u8, (key >> 16) as u8]
    }

    pub fn insert(&mut self, key: u64) {
        for bit in Self::probes(key) {
            self.0[usize::from(bit >> 3)] |= 1 << (bit & 7);
        }
    }

    /// False positives are possible; false negatives are not for inserted keys.
    pub fn may_contain(&self, key: u64) -> bool {
        Self::probes(key)
            .iter()
            .all(|bit| self.0[usize::from(bit >> 3)] & (1 << (bit & 7)) != 0)
    }

    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|b| *b == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shakmaty::{fen::Fen, Chess};

    fn pos(fen: &str) -> Chess {
        parse_fen(fen).unwrap()
    }

    #[test]
    fn position_hash_is_the_known_zobrist_of_the_start_position() {
        // The polyglot/shakmaty reference value of the start position.
        assert_eq!(position_hash(&Chess::default()), 0x463b96181691fc9c);
        assert_eq!(
            position_hash_of_fen(&Fen::default().to_string()).unwrap(),
            0x463b96181691fc9c
        );
    }

    #[test]
    fn position_hash_sees_turn_castling_and_legal_en_passant_only() {
        let a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
        let c = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Qkq - 0 1";
        assert_ne!(position_hash(&pos(a)), position_hash(&pos(b)));
        assert_ne!(position_hash(&pos(a)), position_hash(&pos(c)));
        // A decorative ep square (no capture possible) does not change the hash.
        let with_ep = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        let without = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        assert_eq!(position_hash(&pos(with_ep)), position_hash(&pos(without)));
        // A legal ep capture does.
        let legal_ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
        let no_ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";
        assert_ne!(position_hash(&pos(legal_ep)), position_hash(&pos(no_ep)));
    }

    #[test]
    fn pawn_hash_ignores_pieces_and_sees_colour() {
        let a = pos("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        let b = pos("r1bqkbnr/pppppppp/2n5/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2");
        assert_eq!(pawn_hash(a.board()), pawn_hash(b.board()));
        let c = pos("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
        assert_ne!(pawn_hash(a.board()), pawn_hash(c.board()));
        // Swapping the colours of the pawns changes the hash.
        let d = pos("4k3/8/8/8/8/8/4p3/4K3 w - - 0 1");
        let e = pos("4k3/4P3/8/8/8/8/8/4K3 w - - 0 1");
        assert_ne!(pawn_hash(d.board()), pawn_hash(e.board()));
        assert_eq!(
            pawn_hash_of_fen("4k3/8/8/8/8/8/4p3/4K3 w - - 0 1").unwrap(),
            pawn_hash(d.board())
        );
        assert!(pawn_hash_of_fen("garbage").is_err());
    }

    #[test]
    fn fen_ply_counts_half_moves() {
        assert_eq!(fen_ply(&Fen::default().to_string()), Some(0));
        assert_eq!(
            fen_ply("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"),
            Some(1)
        );
        assert_eq!(fen_ply("8/8/8/8/8/8/8/8 w - - 5 21"), Some(40));
        assert_eq!(fen_ply("8/8/8/8/8/8/8/8 b - - 5 21"), Some(41));
        assert_eq!(fen_ply("8/8/8/8/8/8/8/8"), Some(0));
        assert_eq!(fen_ply(""), None);
    }

    #[test]
    fn bloom_has_no_false_negatives() {
        let mut bloom = Bloom256::default();
        assert!(bloom.is_empty());
        let keys: Vec<u64> = (0..6u64).map(|i| mix64(i * 7919 + 13)).collect();
        for k in &keys {
            bloom.insert(*k);
        }
        for k in &keys {
            assert!(bloom.may_contain(*k));
        }
        assert!(!bloom.is_empty());
        let misses = (100..10_100u64)
            .map(mix64)
            .filter(|k| bloom.may_contain(*k))
            .count();
        // 18 bits set at most → (18/256)^3 ≈ 0.03% false positives.
        assert!(misses < 100, "{misses} false positives of 10000");
    }
}
