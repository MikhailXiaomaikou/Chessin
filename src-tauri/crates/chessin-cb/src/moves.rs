//! `.cbg`: the moves of a game.
//!
//! A record is a flags byte, a 24-bit size, an optional 28-byte start position
//! and a byte stream. Every byte of the stream is first translated through a
//! per-mode permutation table together with a running move counter; the result
//! is either a compact one-byte move code ("second rook, two squares up"), a
//! two-byte escape (code 235), a variation marker (254 push, 255 pop) or, in the
//! simple encoder, half of a two-byte from/to word.
//!
//! Supported encoding modes: 0 (compact, pre, the mode almost every game uses),
//! 4 (compact, post), 5 (simple, post) and 10 (compact, post, Chess960). The
//! translation tables of the other modes are not public.

use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::{
    Bitboard, Board, CastlingMode, CastlingSide, Chess, Color, EnPassantMode, File, FromSetup,
    Move, Position, PositionError, Rank, Role, Setup, Square,
};

use crate::bytes::Reader;
use crate::tables;
use crate::Node;

/// Flag bit: the record starts from an explicit position.
pub const FLAG_SETUP: u8 = 0x40;
/// Size of the start position block.
pub const SETUP_SIZE: usize = 28;
/// Size of the extra Chess960 block that follows the start position.
pub const CHESS960_EXTRA_SIZE: usize = 8;

/// Move code: the next two bytes describe the move.
pub const CODE_TWO_BYTE: u8 = 235;
/// Move code: ignored.
pub const CODE_IGNORED: u8 = 236;
/// Move code: a variation starts (remember this position).
pub const CODE_VARIATION_START: u8 = 254;
/// Move code: a line ends (return to the last remembered position).
pub const CODE_VARIATION_END: u8 = 255;

/// The decoded moves of a game.
#[derive(Debug, Clone)]
pub struct DecodedMoves {
    /// `nodes[0]` is the root (the position before the first move); every
    /// other node is one move, in stream order, so node `i` is the move at
    /// annotation position `i - 1`.
    pub nodes: Vec<Node>,
    /// FEN of the start position when the game does not begin from the
    /// standard one.
    pub setup_fen: Option<String>,
    pub chess960: bool,
}

/// Which family of encoder a mode uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoder {
    Compact,
    Simple,
}

fn encoder_for_mode(mode: u8) -> Result<Encoder, String> {
    match mode {
        0 | 4 | 10 => Ok(Encoder::Compact),
        5 => Ok(Encoder::Simple),
        1..=3 | 6..=9 | 11 => Err(format!(
            "move encoding mode {mode} is not supported (its translation table is not public)"
        )),
        _ => Err(format!("unknown move encoding mode {mode}")),
    }
}

/// Translates one byte of the stream into a code, given the number of moves
/// decoded so far.
///
/// - modes with the *pre* modifier (0): `table[(byte - n) mod 256]`
/// - modes with the *post* modifier (4, 5, 10): `(table[byte] - n) mod 256`
pub fn translate(mode: u8, byte: u8, n: u32) -> Result<u8, String> {
    let n = (n & 0xff) as u8;
    match mode {
        0 => Ok(tables::MODE_0[byte.wrapping_sub(n) as usize]),
        4 => Ok(tables::MODE_4[byte as usize].wrapping_sub(n)),
        5 => Ok(tables::MODE_5[byte as usize].wrapping_sub(n)),
        10 => Ok(tables::MODE_10[byte as usize].wrapping_sub(n)),
        m => Err(format!("move encoding mode {m} is not supported")),
    }
}

/// Square from the format's numbering: `a1` = 0, `a2` = 1, …, `b1` = 8, `h8` = 63.
pub fn square_from_index(i: u8) -> Option<Square> {
    if i >= 64 {
        return None;
    }
    Some(Square::from_coords(
        File::new(u32::from(i / 8)),
        Rank::new(u32::from(i % 8)),
    ))
}

/// The format's numbering of a square (see [`square_from_index`]).
pub fn square_to_index(sq: Square) -> u8 {
    (u32::from(sq.file()) * 8 + u32::from(sq.rank())) as u8
}

/// Squares in the order pieces are numbered: `a1`, `a2`, … `a8`, `b1`, … `h8`.
pub fn scan_order() -> impl Iterator<Item = Square> {
    (0..64u8).filter_map(square_from_index)
}

fn piece_role(bits: u8) -> Option<Role> {
    match bits {
        1 => Some(Role::King),
        2 => Some(Role::Queen),
        3 => Some(Role::Knight),
        4 => Some(Role::Bishop),
        5 => Some(Role::Rook),
        6 => Some(Role::Pawn),
        _ => None,
    }
}

/// Role to piece bits, the inverse of [`piece_role`].
pub fn role_bits(role: Role) -> u8 {
    match role {
        Role::King => 1,
        Role::Queen => 2,
        Role::Knight => 3,
        Role::Bishop => 4,
        Role::Rook => 5,
        Role::Pawn => 6,
    }
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl BitReader<'_> {
    fn next_bit(&mut self) -> Option<u8> {
        let byte = *self.data.get(self.bit / 8)?;
        let b = (byte >> (7 - (self.bit % 8))) & 1;
        self.bit += 1;
        Some(b)
    }

    fn bits(&mut self, n: usize) -> Option<u8> {
        let mut v = 0u8;
        for _ in 0..n {
            v = (v << 1) | self.next_bit()?;
        }
        Some(v)
    }
}

/// Decodes the 24-byte board stream: for each square in scan order, a 0 bit for
/// an empty square, or 1, a colour bit (0 white) and 3 piece bits.
pub fn decode_board(bytes: &[u8]) -> Result<Board, String> {
    let mut reader = BitReader {
        data: bytes,
        bit: 0,
    };
    let mut board = Board::empty();
    for sq in scan_order() {
        let occupied = reader
            .next_bit()
            .ok_or_else(|| "start position board stream is truncated".to_string())?;
        if occupied == 0 {
            continue;
        }
        let color = if reader.next_bit().ok_or("truncated board stream")? == 0 {
            Color::White
        } else {
            Color::Black
        };
        let role = piece_role(reader.bits(3).ok_or("truncated board stream")?)
            .ok_or_else(|| format!("invalid piece code on {sq}"))?;
        board.set_piece_at(sq, shakmaty::Piece { color, role });
    }
    Ok(board)
}

/// The rook squares named in the Chess960 block, in file order: white king,
/// black king, white king-side rook, white queen-side rook, black king-side
/// rook, black queen-side rook, then the start position number.
#[derive(Debug, Clone, Copy)]
struct Chess960Block {
    white_rook_k: Option<Square>,
    white_rook_q: Option<Square>,
    black_rook_k: Option<Square>,
    black_rook_q: Option<Square>,
}

fn parse_chess960_block(bytes: &[u8]) -> Chess960Block {
    Chess960Block {
        white_rook_k: bytes.get(2).copied().and_then(square_from_index),
        white_rook_q: bytes.get(3).copied().and_then(square_from_index),
        black_rook_k: bytes.get(4).copied().and_then(square_from_index),
        black_rook_q: bytes.get(5).copied().and_then(square_from_index),
    }
}

/// Decodes the 28-byte start position into a [`Setup`].
pub fn decode_setup(bytes: &[u8], chess960: Option<&[u8]>) -> Result<Setup, String> {
    if bytes.len() < SETUP_SIZE {
        return Err("start position block is truncated".to_string());
    }
    let ep_and_turn = bytes[1];
    let castling = bytes[2];
    let move_number = bytes[3];
    let board = decode_board(&bytes[4..28])?;
    let turn = if ep_and_turn & 0x10 != 0 {
        Color::Black
    } else {
        Color::White
    };
    let ep_file = ep_and_turn & 0x0f;
    let ep_square = if (1..=8).contains(&ep_file) {
        let rank = if turn.is_white() {
            Rank::Sixth
        } else {
            Rank::Third
        };
        Some(Square::from_coords(File::new(u32::from(ep_file - 1)), rank))
    } else {
        None
    };
    let block = chess960.map(parse_chess960_block);
    let mut rights = Bitboard::EMPTY;
    let rook = |bit: u8, standard: Square, c960: Option<Square>| -> Option<Square> {
        if castling & bit == 0 {
            return None;
        }
        match block {
            Some(_) => c960.or(Some(standard)),
            None => Some(standard),
        }
    };
    for sq in [
        rook(0x01, Square::A1, block.and_then(|b| b.white_rook_q)),
        rook(0x02, Square::H1, block.and_then(|b| b.white_rook_k)),
        rook(0x04, Square::A8, block.and_then(|b| b.black_rook_q)),
        rook(0x08, Square::H8, block.and_then(|b| b.black_rook_k)),
    ]
    .into_iter()
    .flatten()
    {
        rights.add(sq);
    }
    Ok(Setup {
        board,
        turn,
        castling_rights: rights,
        ep_square,
        fullmoves: std::num::NonZeroU32::new(u32::from(move_number.max(1))).unwrap(),
        ..Setup::default()
    })
}

/// One of the `PositionError::ignore_*` methods.
type IgnoreFn = fn(PositionError<Chess>) -> Result<Chess, PositionError<Chess>>;

/// Builds a position, tolerating the kinds of oddity a database may hold
/// (too much material, impossible checks, stale castling rights).
pub fn position_from_setup(setup: Setup, mode: CastlingMode) -> Result<Chess, String> {
    let mut err = match Chess::from_setup(setup, mode) {
        Ok(pos) => return Ok(pos),
        Err(e) => e,
    };
    let ignores: [IgnoreFn; 4] = [
        PositionError::ignore_too_much_material,
        PositionError::ignore_impossible_check,
        PositionError::ignore_invalid_castling_rights,
        PositionError::ignore_invalid_ep_square,
    ];
    for ignore in ignores {
        err = match ignore(err) {
            Ok(pos) => return Ok(pos),
            Err(e) => e,
        };
    }
    Err(format!("invalid start position: {err}"))
}

/// Which piece of a kind a one-byte code names.
///
/// Pieces of a kind are numbered in the order they are found when the start
/// position is scanned `a1`, `a2`, … `h8`. A captured piece drops out and the
/// ones after it move down; a pawn keeps its number for the whole game; a
/// promoted piece is appended to its new kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Tracker {
    queens: Vec<Square>,
    rooks: Vec<Square>,
    bishops: Vec<Square>,
    knights: Vec<Square>,
    pawns: Vec<Option<Square>>,
}

impl Tracker {
    pub(crate) fn from_board(board: &Board, color: Color) -> Tracker {
        let mut t = Tracker::default();
        for sq in scan_order() {
            let Some(piece) = board.piece_at(sq) else {
                continue;
            };
            if piece.color != color {
                continue;
            }
            match piece.role {
                Role::Pawn => t.pawns.push(Some(sq)),
                Role::King => {}
                role => t.list_mut(role).push(sq),
            }
        }
        t
    }

    fn list(&self, role: Role) -> &[Square] {
        match role {
            Role::Queen => &self.queens,
            Role::Rook => &self.rooks,
            Role::Bishop => &self.bishops,
            Role::Knight => &self.knights,
            Role::Pawn | Role::King => &[],
        }
    }

    fn list_mut(&mut self, role: Role) -> &mut Vec<Square> {
        match role {
            Role::Queen => &mut self.queens,
            Role::Rook => &mut self.rooks,
            Role::Bishop => &mut self.bishops,
            Role::Knight => &mut self.knights,
            Role::Pawn | Role::King => unreachable!("pawns and kings are not listed"),
        }
    }

    /// The square of the `index`-th piece of `role` (0-based).
    pub(crate) fn square_of(&self, role: Role, index: usize) -> Option<Square> {
        match role {
            Role::Pawn => self.pawns.get(index).copied().flatten(),
            Role::King => None,
            role => self.list(role).get(index).copied(),
        }
    }

    /// The number (0-based) of the piece of `role` standing on `sq`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn index_of(&self, role: Role, sq: Square) -> Option<usize> {
        match role {
            Role::Pawn => self.pawns.iter().position(|p| *p == Some(sq)),
            Role::King => None,
            role => self.list(role).iter().position(|s| *s == sq),
        }
    }

    pub(crate) fn moved(&mut self, role: Role, from: Square, to: Square) {
        match role {
            Role::Pawn => {
                if let Some(slot) = self.pawns.iter_mut().find(|p| **p == Some(from)) {
                    *slot = Some(to);
                }
            }
            Role::King => {}
            role => {
                if let Some(slot) = self.list_mut(role).iter_mut().find(|s| **s == from) {
                    *slot = to;
                }
            }
        }
    }

    pub(crate) fn captured(&mut self, role: Role, sq: Square) {
        match role {
            Role::Pawn => {
                if let Some(slot) = self.pawns.iter_mut().find(|p| **p == Some(sq)) {
                    *slot = None;
                }
            }
            Role::King => {}
            role => {
                let list = self.list_mut(role);
                if let Some(i) = list.iter().position(|s| *s == sq) {
                    list.remove(i);
                }
            }
        }
    }

    pub(crate) fn promoted(&mut self, from: Square, to: Square, role: Role) {
        if let Some(slot) = self.pawns.iter_mut().find(|p| **p == Some(from)) {
            *slot = None;
        }
        if !matches!(role, Role::Pawn | Role::King) {
            self.list_mut(role).push(to);
        }
    }

    /// Applies a legal move of `color` (and the capture it makes to `other`).
    pub(crate) fn apply(me: &mut Tracker, other: &mut Tracker, color: Color, m: &Move) {
        match *m {
            Move::Normal {
                role,
                from,
                capture,
                to,
                promotion,
            } => {
                if let Some(c) = capture {
                    other.captured(c, to);
                }
                match promotion {
                    Some(p) => me.promoted(from, to, p),
                    None => me.moved(role, from, to),
                }
            }
            Move::EnPassant { from, to } => {
                me.moved(Role::Pawn, from, to);
                other.captured(Role::Pawn, Square::from_coords(to.file(), from.rank()));
            }
            Move::Castle { king, rook } => {
                let side = CastlingSide::from_king_side(rook.file() > king.file());
                me.moved(Role::Rook, rook, side.rook_to(color));
            }
            Move::Put { .. } => {}
        }
    }
}

pub(crate) const KING_DELTAS: [(i32, i32); 8] = [
    (0, 1),
    (1, 1),
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, -1),
    (-1, 0),
    (-1, 1),
];

pub(crate) const KNIGHT_DELTAS: [(i32, i32); 8] = [
    (2, 1),
    (1, 2),
    (-1, 2),
    (-2, 1),
    (-2, -1),
    (-1, -2),
    (1, -2),
    (2, -1),
];

/// Queen movement for codes 0-27 of a queen's block.
pub(crate) fn queen_delta(i: u8) -> (i32, i32) {
    let i = i32::from(i);
    match i {
        0..=6 => (0, i + 1),
        7..=13 => (i - 6, 0),
        14..=20 => (i - 13, i - 13),
        _ => (i - 20, -(i - 20)),
    }
}

/// Rook movement for codes 0-13 of a rook's block.
pub(crate) fn rook_delta(i: u8) -> (i32, i32) {
    let i = i32::from(i);
    if i <= 6 {
        (0, i + 1)
    } else {
        (i - 6, 0)
    }
}

/// Bishop movement for codes 0-13 of a bishop's block.
pub(crate) fn bishop_delta(i: u8) -> (i32, i32) {
    let i = i32::from(i);
    if i <= 6 {
        (i + 1, i + 1)
    } else {
        (i - 6, -(i - 6))
    }
}

/// Pawn movement for the four codes of a pawn: forward one, forward two,
/// capture towards the player's right, capture towards the left.
pub(crate) fn pawn_delta(kind: u8, color: Color) -> (i32, i32) {
    let dir = if color.is_white() { 1 } else { -1 };
    match kind {
        0 => (0, dir),
        1 => (0, 2 * dir),
        2 => (dir, dir),
        _ => (-dir, dir),
    }
}

/// Moves `from` by `(dx, dy)`, each coordinate taken modulo 8.
pub(crate) fn offset_mod8(from: Square, (dx, dy): (i32, i32)) -> Square {
    let f = (u32::from(from.file()) as i32 + dx).rem_euclid(8);
    let r = (u32::from(from.rank()) as i32 + dy).rem_euclid(8);
    Square::from_coords(File::new(f as u32), Rank::new(r as u32))
}

/// A piece block of the compact encoder: `(role, index, first code, codes)`.
pub(crate) const PIECE_BLOCKS: [(Role, usize, u8, u8); 14] = [
    (Role::Queen, 0, 11, 28),
    (Role::Rook, 0, 39, 14),
    (Role::Rook, 1, 53, 14),
    (Role::Bishop, 0, 67, 14),
    (Role::Bishop, 1, 81, 14),
    (Role::Knight, 0, 95, 8),
    (Role::Knight, 1, 103, 8),
    (Role::Queen, 1, 143, 28),
    (Role::Queen, 2, 171, 28),
    (Role::Rook, 2, 199, 14),
    (Role::Bishop, 2, 213, 14),
    (Role::Knight, 2, 227, 8),
    // The two pawn entries are placeholders so the table is exhaustive; pawns
    // are handled by `PAWN_FIRST_CODE`.
    (Role::Pawn, 0, 111, 32),
    (Role::Pawn, 0, 111, 0),
];

pub(crate) const PAWN_FIRST_CODE: u8 = 111;

/// A decoded stream item that moves (or passes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decoded {
    Null,
    Move(Move),
}

/// Completes a move from its squares using the board: the role, what it
/// captures, en passant, castling written as a king move, promotion.
pub(crate) fn build_move(
    pos: &Chess,
    from: Square,
    to: Square,
    promotion: Option<Role>,
) -> Result<Move, String> {
    let board = pos.board();
    let color = pos.turn();
    let role = board
        .role_at(from)
        .ok_or_else(|| format!("no piece on {from} to move to {to}"))?;
    if board.color_at(from) != Some(color) {
        return Err(format!("the piece on {from} is not {color}'s"));
    }
    if role == Role::King
        && from.rank() == to.rank()
        && u32::from(from.file()).abs_diff(u32::from(to.file())) == 2
    {
        let side = CastlingSide::from_king_side(to.file() > from.file());
        let rook = pos
            .castles()
            .rook(color, side)
            .ok_or_else(|| format!("{color} cannot castle {side:?} here"))?;
        return Ok(Move::Castle { king: from, rook });
    }
    let capture = board.role_at(to);
    if role == Role::Pawn {
        if from.file() != to.file() && capture.is_none() {
            return Ok(Move::EnPassant { from, to });
        }
        let promotion = if matches!(to.rank(), Rank::First | Rank::Eighth) {
            Some(promotion.unwrap_or(Role::Queen))
        } else {
            None
        };
        return Ok(Move::Normal {
            role,
            from,
            capture,
            to,
            promotion,
        });
    }
    Ok(Move::Normal {
        role,
        from,
        capture,
        to,
        promotion: None,
    })
}

/// Decodes a one-byte move code against the position and the piece numbering.
pub(crate) fn compact_move(code: u8, pos: &Chess, tracker: &Tracker) -> Result<Decoded, String> {
    let color = pos.turn();
    if code == 0 {
        return Ok(Decoded::Null);
    }
    if (1..=8).contains(&code) {
        let from = pos
            .board()
            .king_of(color)
            .ok_or_else(|| format!("{color} has no king"))?;
        let to = offset_mod8(from, KING_DELTAS[usize::from(code - 1)]);
        return build_move(pos, from, to, None).map(Decoded::Move);
    }
    if code == 9 || code == 10 {
        let side = CastlingSide::from_king_side(code == 9);
        let king = pos
            .board()
            .king_of(color)
            .ok_or_else(|| format!("{color} has no king"))?;
        let rook = pos
            .castles()
            .rook(color, side)
            .ok_or_else(|| format!("{color} cannot castle {side:?} here"))?;
        return Ok(Decoded::Move(Move::Castle { king, rook }));
    }
    if (PAWN_FIRST_CODE..PAWN_FIRST_CODE + 32).contains(&code) {
        let rel = code - PAWN_FIRST_CODE;
        let index = usize::from(rel / 4);
        let kind = rel % 4;
        let from = tracker
            .square_of(Role::Pawn, index)
            .ok_or_else(|| format!("{color} has no pawn number {}", index + 1))?;
        let to = offset_mod8(from, pawn_delta(kind, color));
        return build_move(pos, from, to, None).map(Decoded::Move);
    }
    for &(role, index, first, count) in PIECE_BLOCKS.iter().take(12) {
        if code >= first && code < first + count {
            let rel = code - first;
            let from = tracker.square_of(role, index).ok_or_else(|| {
                format!("{color} has no {} number {}", role_name(role), index + 1)
            })?;
            let delta = match role {
                Role::Queen => queen_delta(rel),
                Role::Rook => rook_delta(rel),
                Role::Bishop => bishop_delta(rel),
                Role::Knight => KNIGHT_DELTAS[usize::from(rel)],
                _ => unreachable!(),
            };
            let to = offset_mod8(from, delta);
            return build_move(pos, from, to, None).map(Decoded::Move);
        }
    }
    Err(format!("move code {code} is not used"))
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::King => "king",
        Role::Queen => "queen",
        Role::Rook => "rook",
        Role::Bishop => "bishop",
        Role::Knight => "knight",
        Role::Pawn => "pawn",
    }
}

/// Promotion piece from the two-bit field of a two-byte move.
pub(crate) fn promotion_role(bits: u16) -> Role {
    match bits & 3 {
        0 => Role::Queen,
        1 => Role::Rook,
        2 => Role::Bishop,
        _ => Role::Knight,
    }
}

/// Decodes the 16-bit word of a two-byte move (bits 0-5 from, 6-11 to, 12-13
/// promotion). `from == to` is a null move, except that in a Chess960 game a
/// move "from" the king's castling target "to" the same square is castling.
pub(crate) fn two_byte_move(word: u16, pos: &Chess, mode: CastlingMode) -> Result<Decoded, String> {
    let from_i = (word & 0x3f) as u8;
    let to_i = ((word >> 6) & 0x3f) as u8;
    let from = square_from_index(from_i).ok_or("bad square")?;
    let to = square_from_index(to_i).ok_or("bad square")?;
    if from == to {
        if mode == CastlingMode::Chess960 {
            let color = pos.turn();
            let side = match to.file() {
                File::G => Some(CastlingSide::KingSide),
                File::C => Some(CastlingSide::QueenSide),
                _ => None,
            };
            if let Some(side) = side.filter(|s| s.king_to(color) == to) {
                if let (Some(king), Some(rook)) =
                    (pos.board().king_of(color), pos.castles().rook(color, side))
                {
                    return Ok(Decoded::Move(Move::Castle { king, rook }));
                }
            }
        }
        return Ok(Decoded::Null);
    }
    let promotion = Some(promotion_role(word >> 12));
    build_move(pos, from, to, promotion).map(Decoded::Move)
}

/// Passes the move: same board, other side to move, no en passant.
pub(crate) fn play_null(pos: &Chess, mode: CastlingMode) -> Result<Chess, String> {
    let mut setup = pos.clone().into_setup(EnPassantMode::Legal);
    let was_black = setup.turn == Color::Black;
    setup.turn = setup.turn.other();
    setup.ep_square = None;
    setup.halfmoves += 1;
    if was_black {
        setup.fullmoves = setup.fullmoves.saturating_add(1);
    }
    position_from_setup(setup, mode)
}

#[derive(Clone)]
struct State {
    pos: Chess,
    trackers: [Tracker; 2],
    node: usize,
}

fn color_index(c: Color) -> usize {
    if c.is_white() {
        0
    } else {
        1
    }
}

struct Decoder {
    mode: CastlingMode,
    nodes: Vec<Node>,
    stack: Vec<State>,
    state: State,
    /// Number of moves decoded so far: the translation counter.
    n: u32,
}

impl Decoder {
    fn new(pos: Chess, mode: CastlingMode) -> Decoder {
        let trackers = [
            Tracker::from_board(pos.board(), Color::White),
            Tracker::from_board(pos.board(), Color::Black),
        ];
        Decoder {
            mode,
            nodes: vec![Node::default()],
            stack: Vec::new(),
            state: State {
                pos,
                trackers,
                node: 0,
            },
            n: 0,
        }
    }

    fn push_variation(&mut self) {
        self.stack.push(self.state.clone());
    }

    /// Returns `false` when there was nothing to pop: the game is over.
    fn pop_variation(&mut self) -> bool {
        match self.stack.pop() {
            Some(s) => {
                self.state = s;
                true
            }
            None => false,
        }
    }

    fn play(&mut self, d: Decoded) -> Result<(), String> {
        let color = self.state.pos.turn();
        let fullmove = self.state.pos.fullmoves().get();
        let (san, is_null) = match d {
            Decoded::Null => {
                self.state.pos = play_null(&self.state.pos, self.mode)?;
                ("--".to_string(), true)
            }
            Decoded::Move(m) => {
                if !self.state.pos.is_legal(&m) {
                    return Err(format!(
                        "illegal move {} (move {}) in {}",
                        m.to_uci(self.mode),
                        self.n + 1,
                        Fen::from_position(self.state.pos.clone(), EnPassantMode::Legal)
                    ));
                }
                let san = SanPlus::from_move_and_play_unchecked(&mut self.state.pos, &m);
                let [white, black] = &mut self.state.trackers;
                let (me, other) = if color.is_white() {
                    (white, black)
                } else {
                    (black, white)
                };
                Tracker::apply(me, other, color, &m);
                (san.to_string(), false)
            }
        };
        let idx = self.nodes.len();
        self.nodes.push(Node {
            san,
            is_null,
            white: color.is_white(),
            fullmove,
            ..Node::default()
        });
        self.nodes[self.state.node].children.push(idx);
        self.state.node = idx;
        self.n += 1;
        Ok(())
    }

    fn tracker(&self) -> &Tracker {
        &self.state.trackers[color_index(self.state.pos.turn())]
    }
}

/// Decodes a `.cbg` game record given its flags byte and the bytes after the
/// 4-byte record header.
pub fn decode_moves(flags: u8, payload: &[u8]) -> Result<DecodedMoves, String> {
    let mode = flags & 0x3f;
    let encoder = encoder_for_mode(mode)?;
    let chess960 = matches!(mode, 10 | 11);
    let castling_mode = if chess960 {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };
    let mut r = Reader::new(payload);
    let (pos, setup_fen) = if flags & FLAG_SETUP != 0 {
        let setup_bytes = r
            .take(SETUP_SIZE)
            .ok_or("start position block is truncated")?;
        let extra = if chess960 {
            Some(
                r.take(CHESS960_EXTRA_SIZE)
                    .ok_or("Chess960 block is truncated")?,
            )
        } else {
            None
        };
        let setup = decode_setup(setup_bytes, extra)?;
        let pos = position_from_setup(setup, castling_mode)?;
        let fen = Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string();
        (pos, Some(fen))
    } else if chess960 {
        return Err("Chess960 game without a start position".to_string());
    } else {
        (Chess::default(), None)
    };
    let mut dec = Decoder::new(pos, castling_mode);
    match encoder {
        Encoder::Compact => decode_compact(mode, &mut r, &mut dec)?,
        Encoder::Simple => decode_simple(mode, &mut r, &mut dec)?,
    }
    Ok(DecodedMoves {
        nodes: dec.nodes,
        setup_fen,
        chess960,
    })
}

fn decode_compact(mode: u8, r: &mut Reader<'_>, dec: &mut Decoder) -> Result<(), String> {
    while let Some(b) = r.u8() {
        let v = translate(mode, b, dec.n)?;
        match v {
            CODE_VARIATION_START => dec.push_variation(),
            CODE_VARIATION_END => {
                if !dec.pop_variation() {
                    return Ok(());
                }
            }
            CODE_IGNORED => {}
            CODE_TWO_BYTE => {
                let hi = r.u8().ok_or("two-byte move is truncated")?;
                let lo = r.u8().ok_or("two-byte move is truncated")?;
                let word = (u16::from(translate(mode, hi, dec.n)?) << 8)
                    | u16::from(translate(mode, lo, dec.n)?);
                let d = two_byte_move(word, &dec.state.pos, dec.mode)?;
                dec.play(d)?;
            }
            237..=253 => return Err(format!("move code {v} is not used")),
            code => {
                let d = compact_move(code, &dec.state.pos, dec.tracker())?;
                dec.play(d)?;
            }
        }
    }
    Ok(())
}

fn decode_simple(mode: u8, r: &mut Reader<'_>, dec: &mut Decoder) -> Result<(), String> {
    while r.remaining() >= 2 {
        let hi = r.u8().ok_or("truncated")?;
        let lo = r.u8().ok_or("truncated")?;
        let word =
            (u16::from(translate(mode, hi, dec.n)?) << 8) | u16::from(translate(mode, lo, dec.n)?);
        if word & 0x8000 != 0 {
            dec.push_variation();
        }
        let d = two_byte_move(word, &dec.state.pos, dec.mode)?;
        dec.play(d)?;
        if word & 0x4000 != 0 && !dec.pop_variation() {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sans(decoded: &DecodedMoves) -> Vec<String> {
        decoded.nodes[1..].iter().map(|n| n.san.clone()).collect()
    }

    #[test]
    fn tables_are_permutations() {
        for t in [
            &tables::MODE_0,
            &tables::MODE_4,
            &tables::MODE_5,
            &tables::MODE_10,
        ] {
            let mut seen = [false; 256];
            for &v in t.iter() {
                assert!(!seen[v as usize], "duplicate {v}");
                seen[v as usize] = true;
            }
        }
    }

    #[test]
    fn translation_uses_the_counter_per_modifier() {
        // pre: table[(byte - n) mod 256]; MODE_0[2] = 0x43
        assert_eq!(translate(0, 0x05, 3).unwrap(), 0x43);
        assert_eq!(translate(0, 0x02, 0).unwrap(), 0x43);
        assert_eq!(translate(0, 0x01, 255).unwrap(), tables::MODE_0[2]);
        // post: (table[byte] - n) mod 256; MODE_4[0] = 0x58
        assert_eq!(translate(4, 0x00, 3).unwrap(), 0x55);
        assert_eq!(translate(4, 0x00, 0x59).unwrap(), 0xff);
        assert!(translate(1, 0, 0).is_err());
    }

    #[test]
    fn square_numbering_is_file_major() {
        assert_eq!(square_from_index(0), Some(Square::A1));
        assert_eq!(square_from_index(1), Some(Square::A2));
        assert_eq!(square_from_index(8), Some(Square::B1));
        assert_eq!(square_from_index(63), Some(Square::H8));
        assert_eq!(square_from_index(64), None);
        for i in 0..64u8 {
            assert_eq!(square_to_index(square_from_index(i).unwrap()), i);
        }
    }

    #[test]
    fn board_stream_example_from_the_spec() {
        // 58 0e 93: empty, white pawn, six empty, black rook, two empty, white knight
        let mut bytes = vec![0x58, 0x0e, 0x93];
        bytes.resize(24, 0);
        let board = decode_board(&bytes).unwrap();
        assert_eq!(
            board.piece_at(Square::A2),
            Some(Piece {
                color: Color::White,
                role: Role::Pawn
            })
        );
        assert_eq!(
            board.piece_at(Square::B1),
            Some(Piece {
                color: Color::Black,
                role: Role::Rook
            })
        );
        assert_eq!(
            board.piece_at(Square::B4),
            Some(Piece {
                color: Color::White,
                role: Role::Knight
            })
        );
        assert_eq!(board.occupied().count(), 3);
    }

    use shakmaty::Piece;

    #[test]
    fn hand_assembled_mode_0_stream() {
        // 1. e4 e5 2. Nf3, then the end marker; bytes derived by hand from the
        // mode 0 table (see the module tests in the crate report).
        let d = decode_moves(0, &[0xff, 0x00, 0x00, 0x0f]).unwrap();
        assert_eq!(sans(&d), vec!["e4", "e5", "Nf3"]);
        assert!(d.setup_fen.is_none());
        assert_eq!(d.nodes[0].children, vec![1]);
        assert_eq!(d.nodes[1].children, vec![2]);
        assert_eq!(d.nodes[3].children, Vec::<usize>::new());
        assert!(d.nodes[1].white && d.nodes[1].fullmove == 1);
        assert!(!d.nodes[2].white && d.nodes[2].fullmove == 1);
        assert!(d.nodes[3].white && d.nodes[3].fullmove == 2);
    }

    #[test]
    fn hand_assembled_mode_4_stream() {
        let d = decode_moves(4, &[0xf1, 0x2e, 0xde, 0xce]).unwrap();
        assert_eq!(sans(&d), vec!["e4", "e5", "Nf3"]);
    }

    #[test]
    fn compact_codes_name_pieces_by_scan_order() {
        let pos = Chess::default();
        let t = Tracker::from_board(pos.board(), Color::White);
        assert_eq!(t.square_of(Role::Rook, 0), Some(Square::A1));
        assert_eq!(t.square_of(Role::Rook, 1), Some(Square::H1));
        assert_eq!(t.square_of(Role::Knight, 1), Some(Square::G1));
        assert_eq!(t.square_of(Role::Pawn, 4), Some(Square::E2));
        assert_eq!(t.square_of(Role::Queen, 1), None);
        // e-pawn (index 4), two steps: 111 + 4 * 4 + 1 = 128
        match compact_move(128, &pos, &t).unwrap() {
            Decoded::Move(Move::Normal { from, to, .. }) => {
                assert_eq!((from, to), (Square::E2, Square::E4));
            }
            other => panic!("{other:?}"),
        }
        // second knight, (-1, +2): 103 + 2
        match compact_move(105, &pos, &t).unwrap() {
            Decoded::Move(Move::Normal { from, to, .. }) => {
                assert_eq!((from, to), (Square::G1, Square::F3));
            }
            other => panic!("{other:?}"),
        }
        // first rook one step up is blocked: illegal, but the decoder only
        // builds the move here; legality is checked when it is played.
        assert_eq!(compact_move(0, &pos, &t).unwrap(), Decoded::Null);
        assert!(compact_move(240, &pos, &t).is_err());
    }

    #[test]
    fn captured_pieces_renumber_and_pawns_keep_their_number() {
        let mut white = Tracker::from_board(Chess::default().board(), Color::White);
        let mut black = Tracker::from_board(Chess::default().board(), Color::Black);
        // Pretend the a1 rook is captured: h1 becomes the first rook.
        white.captured(Role::Rook, Square::A1);
        assert_eq!(white.square_of(Role::Rook, 0), Some(Square::H1));
        assert_eq!(white.square_of(Role::Rook, 1), None);
        // Pawn d2 captured: slot 3 empties, e-pawn stays number 4.
        white.captured(Role::Pawn, Square::D2);
        assert_eq!(white.square_of(Role::Pawn, 3), None);
        assert_eq!(white.square_of(Role::Pawn, 4), Some(Square::E2));
        // Promotion appends a queen.
        white.promoted(Square::E2, Square::E8, Role::Queen);
        assert_eq!(white.square_of(Role::Pawn, 4), None);
        assert_eq!(white.square_of(Role::Queen, 1), Some(Square::E8));
        // En passant removes the pawn behind the target.
        let m = Move::EnPassant {
            from: Square::E5,
            to: Square::D6,
        };
        black.moved(Role::Pawn, Square::D7, Square::D5);
        white.moved(Role::Pawn, Square::E8, Square::E5);
        Tracker::apply(&mut white, &mut black, Color::White, &m);
        assert_eq!(black.square_of(Role::Pawn, 3), None);
        // Castling moves the rook.
        let m = Move::Castle {
            king: Square::E1,
            rook: Square::H1,
        };
        Tracker::apply(&mut white, &mut black, Color::White, &m);
        assert_eq!(white.square_of(Role::Rook, 0), Some(Square::F1));
    }

    #[test]
    fn setup_decodes_turn_castling_and_en_passant() {
        let mut bytes = vec![1u8, 0x10 | 5, 0b0011, 12];
        // Board: white king e1, rook h1, pawn d5 (just pushed), black king e8, pawn e5.
        let mut board = Board::empty();
        board.set_piece_at(
            Square::E1,
            Piece {
                color: Color::White,
                role: Role::King,
            },
        );
        board.set_piece_at(
            Square::H1,
            Piece {
                color: Color::White,
                role: Role::Rook,
            },
        );
        board.set_piece_at(
            Square::A1,
            Piece {
                color: Color::White,
                role: Role::Rook,
            },
        );
        board.set_piece_at(
            Square::E5,
            Piece {
                color: Color::White,
                role: Role::Pawn,
            },
        );
        board.set_piece_at(
            Square::E8,
            Piece {
                color: Color::Black,
                role: Role::King,
            },
        );
        board.set_piece_at(
            Square::D5,
            Piece {
                color: Color::Black,
                role: Role::Pawn,
            },
        );
        bytes.extend(crate::testenc::encode_board(&board));
        let setup = decode_setup(&bytes, None).unwrap();
        assert_eq!(setup.turn, Color::Black);
        assert_eq!(setup.fullmoves.get(), 12);
        assert_eq!(setup.ep_square, Some(Square::E3));
        assert!(setup.castling_rights.contains(Square::A1));
        assert!(setup.castling_rights.contains(Square::H1));
        assert!(!setup.castling_rights.contains(Square::A8));
        assert_eq!(setup.board, board);
    }

    #[test]
    fn null_move_flips_the_side_to_move() {
        let pos = Chess::default();
        let after = play_null(&pos, CastlingMode::Standard).unwrap();
        assert_eq!(after.turn(), Color::Black);
        assert_eq!(after.fullmoves().get(), 1);
        let again = play_null(&after, CastlingMode::Standard).unwrap();
        assert_eq!(again.turn(), Color::White);
        assert_eq!(again.fullmoves().get(), 2);
    }

    #[test]
    fn rejects_unsupported_modes_and_bad_codes() {
        assert!(decode_moves(1, &[0]).unwrap_err().contains("not supported"));
        assert!(decode_moves(63, &[0]).is_err());
        // Mode 0, n = 0: byte 0x0c translates to 0xff, i.e. end of game.
        assert_eq!(
            sans(&decode_moves(0, &[0x0c]).unwrap()),
            Vec::<String>::new()
        );
        // An illegal first move: code 39 (first rook up one) is blocked.
        let byte = tables::MODE_0.iter().position(|&v| v == 39).unwrap() as u8;
        assert!(decode_moves(0, &[byte])
            .unwrap_err()
            .contains("illegal move"));
    }
}
