//! `.2cbg`: the moves of a game.
//!
//! A record is framed by a magic number, two sizes, a checksum and a tag
//! (Morphy `format/v2/2-moves.md`). Its content is a stream of 16-bit
//! little-endian words. Words below `fffa` each name one move in a fixed,
//! position-independent enumeration of every move a piece could make on an
//! empty board, crossed with what it captures and what it promotes to, so a
//! word means the same move in any position. Words from `fffa` up are markers:
//! null move, start-position section, move section, "the move just given has
//! a later alternative" and end of line. The main line is stored first and in
//! full; alternatives follow, most recent branch point first.
//!
//! We replay the moves anyway, to produce SAN and to reject a damaged record:
//! a word whose piece is not on its origin square, or whose captured piece is
//! not on its destination, is an error.

use std::sync::OnceLock;

use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::{
    Bitboard, Board, CastlingMode, CastlingSide, Chess, Color, EnPassantMode, File, Move, Piece,
    Position, Rank, Role, Setup, Square,
};

use crate::bytes::Reader;
use crate::moves::{
    play_null, position_from_setup, scan_order, square_from_index, Decoded, DecodedMoves,
};
use crate::Node;

/// The eight bytes every `.2cbg` and `.2cba` record begins with.
pub const MAGIC: [u8; 8] = [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11];
/// Magic, content size, spare size, checksum and tag.
pub const RECORD_HEAD_SIZE: usize = 26;
/// The head plus the trailing record length.
pub const RECORD_OVERHEAD: usize = 34;
/// Record tags.
pub const TAG_GAME: u16 = 0x0001;
pub const TAG_CHESS960: u16 = 0x0002;
pub const TAG_TEXT: u16 = 0x1000;
pub const TAG_ANNOTATIONS: u16 = 0x2000;

/// Stream markers.
pub const WORD_NULL_MOVE: u16 = 0xfffa;
pub const WORD_SETUP: u16 = 0xfffb;
pub const WORD_MOVES: u16 = 0xfffc;
pub const WORD_ALTERNATIVE: u16 = 0xfffd;
pub const WORD_END: u16 = 0xffff;

/// Boundaries of the enumeration.
pub const LAST_PIECE_MOVE: u16 = 0xb128;
pub const FIRST_CASTLING: u16 = 0xb129;
pub const FIRST_CHESS960_CASTLING: u16 = 0xb12d;
pub const LAST_MOVE: u16 = 0xc02c;
pub const FIRST_PLACEMENT: u16 = 0xc02d;
pub const LAST_PLACEMENT: u16 = 0xc30c;
/// In a start position section, this word before a set-up position says the
/// game is Chess960.
pub const SETUP_CHESS960_PREFIX: u16 = 1000;
pub const CHESS960_POSITIONS: u16 = 960;

/// The head of a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordHead {
    pub content_size: u32,
    pub spare_size: u32,
    pub checksum: u64,
    pub tag: u16,
}

/// Parses the 26-byte head of a record.
pub fn parse_record_head(buf: &[u8]) -> Result<RecordHead, String> {
    if buf.len() < RECORD_HEAD_SIZE {
        return Err(format!("record head is truncated ({} bytes)", buf.len()));
    }
    if buf[..8] != MAGIC {
        return Err("record does not begin with the magic number".to_string());
    }
    let mut r = Reader::new(&buf[8..]);
    let content_size = r.le_i32().unwrap_or(-1);
    let spare_size = r.le_i32().unwrap_or(-1);
    let checksum = r.be_u64().unwrap_or(0);
    let tag = r.le_u16().unwrap_or(0);
    if content_size < 0 || spare_size < 0 {
        return Err(format!(
            "record has negative sizes ({content_size} content, {spare_size} spare)"
        ));
    }
    Ok(RecordHead {
        content_size: content_size as u32,
        spare_size: spare_size as u32,
        checksum,
        tag,
    })
}

/// The 64-bit checksum of a record's content: with *m* = ⌊len / 8⌋, byte *i*
/// of the value (from the least significant) is the sum modulo 256 of bytes
/// *i·m* to *i·m + m − 1*; the last `len mod 8` bytes are ignored. When
/// *m* = 0 the value is the content itself as a little-endian integer.
pub fn checksum(content: &[u8]) -> u64 {
    let m = content.len() / 8;
    let mut bytes = [0u8; 8];
    if m == 0 {
        bytes[..content.len()].copy_from_slice(content);
    } else {
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = content[i * m..(i + 1) * m]
                .iter()
                .fold(0u8, |acc, &x| acc.wrapping_add(x));
        }
    }
    u64::from_le_bytes(bytes)
}

/// What a move word captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Captured {
    Nothing,
    Piece(Role),
    EnPassant,
}

/// One entry of the move enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MoveSpec {
    pub color: Color,
    pub role: Role,
    pub from: Square,
    pub to: Square,
    pub captured: Captured,
    pub promotion: Option<Role>,
}

const KING_DIRS: [(i32, i32); 8] = [
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
];
const KNIGHT_DIRS: [(i32, i32); 8] = [
    (-2, -1),
    (-2, 1),
    (2, -1),
    (2, 1),
    (-1, -2),
    (-1, 2),
    (1, -2),
    (1, 2),
];
const BISHOP_DIRS: [(i32, i32); 4] = [(-1, -1), (1, -1), (1, 1), (-1, 1)];
const ROOK_DIRS: [(i32, i32); 4] = [(-1, 0), (0, -1), (1, 0), (0, 1)];
const QUEEN_DIRS: [(i32, i32); 8] = [
    (-1, -1),
    (1, -1),
    (1, 1),
    (-1, 1),
    (-1, 0),
    (0, -1),
    (1, 0),
    (0, 1),
];
/// The captured pieces after "no capture", in order.
const CAPTURES: [Role; 5] = [
    Role::Queen,
    Role::Knight,
    Role::Bishop,
    Role::Rook,
    Role::Pawn,
];
const PROMOTIONS: [Role; 4] = [Role::Queen, Role::Knight, Role::Bishop, Role::Rook];
const PLACEMENT_ROLES: [Role; 5] = [
    Role::King,
    Role::Queen,
    Role::Knight,
    Role::Bishop,
    Role::Rook,
];

/// `sq` moved `k` steps of `(file, rank)`, if still on the board.
fn offset(sq: Square, (df, dr): (i32, i32), k: i32) -> Option<Square> {
    let f = u32::from(sq.file()) as i32 + df * k;
    let r = u32::from(sq.rank()) as i32 + dr * k;
    if (0..8).contains(&f) && (0..8).contains(&r) {
        Some(Square::from_coords(
            File::new(f as u32),
            Rank::new(r as u32),
        ))
    } else {
        None
    }
}

fn build_move_table() -> Vec<MoveSpec> {
    // Word 0 is unused; a dummy keeps the indices equal to the words.
    let mut words = vec![MoveSpec {
        color: Color::White,
        role: Role::King,
        from: Square::A1,
        to: Square::A1,
        captured: Captured::Nothing,
        promotion: None,
    }];
    for color in [Color::White, Color::Black] {
        for role in [
            Role::King,
            Role::Queen,
            Role::Knight,
            Role::Bishop,
            Role::Rook,
        ] {
            let (dirs, slides): (&[(i32, i32)], bool) = match role {
                Role::King => (&KING_DIRS, false),
                Role::Queen => (&QUEEN_DIRS, true),
                Role::Knight => (&KNIGHT_DIRS, false),
                Role::Bishop => (&BISHOP_DIRS, true),
                _ => (&ROOK_DIRS, true),
            };
            for from in scan_order() {
                for &d in dirs {
                    let mut k = 1;
                    while let Some(to) = offset(from, d, k) {
                        let spec = MoveSpec {
                            color,
                            role,
                            from,
                            to,
                            captured: Captured::Nothing,
                            promotion: None,
                        };
                        words.push(spec);
                        for c in CAPTURES {
                            words.push(MoveSpec {
                                captured: Captured::Piece(c),
                                ..spec
                            });
                        }
                        if !slides {
                            break;
                        }
                        k += 1;
                    }
                }
            }
        }
    }
    for color in [Color::White, Color::Black] {
        let (dir, start, promo, ep) = if color.is_white() {
            (1, 1u32, 6u32, 4u32)
        } else {
            (-1, 6, 1, 3)
        };
        for file in 0..8u32 {
            for rank in 1..=6u32 {
                let from = Square::from_coords(File::new(file), Rank::new(rank));
                let spec = MoveSpec {
                    color,
                    role: Role::Pawn,
                    from,
                    to: from,
                    captured: Captured::Nothing,
                    promotion: None,
                };
                let forward =
                    |k| offset(from, (0, dir), k).expect("a pawn move stays on the board");
                if rank == start {
                    words.push(MoveSpec {
                        to: forward(2),
                        ..spec
                    });
                    words.push(MoveSpec {
                        to: forward(1),
                        ..spec
                    });
                } else if rank == promo {
                    for p in PROMOTIONS {
                        words.push(MoveSpec {
                            to: forward(1),
                            promotion: Some(p),
                            ..spec
                        });
                    }
                } else {
                    words.push(MoveSpec {
                        to: forward(1),
                        ..spec
                    });
                }
                for df in [-1, 1] {
                    let Some(to) = offset(from, (df, dir), 1) else {
                        continue;
                    };
                    if rank == promo {
                        for c in &CAPTURES[..4] {
                            for p in PROMOTIONS {
                                words.push(MoveSpec {
                                    to,
                                    captured: Captured::Piece(*c),
                                    promotion: Some(p),
                                    ..spec
                                });
                            }
                        }
                    } else {
                        for c in CAPTURES {
                            words.push(MoveSpec {
                                to,
                                captured: Captured::Piece(c),
                                ..spec
                            });
                        }
                        if rank == ep {
                            words.push(MoveSpec {
                                to,
                                captured: Captured::EnPassant,
                                ..spec
                            });
                        }
                    }
                }
            }
        }
    }
    words
}

/// The enumeration of piece and pawn moves, indexed by word (entry 0 is a
/// dummy). Castling and piece placements are not in it.
pub fn move_table() -> &'static [MoveSpec] {
    static TABLE: OnceLock<Vec<MoveSpec>> = OnceLock::new();
    TABLE.get_or_init(build_move_table)
}

/// A castling word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CastlingWord {
    pub color: Color,
    pub side: CastlingSide,
    /// The Chess960 start position the word belongs to, if it is one of the
    /// Chess960 words.
    pub chess960: Option<u16>,
}

fn castling_of(k: u16, chess960: Option<u16>) -> CastlingWord {
    let (color, side) = match k {
        0 => (Color::White, CastlingSide::QueenSide),
        1 => (Color::White, CastlingSide::KingSide),
        2 => (Color::Black, CastlingSide::QueenSide),
        _ => (Color::Black, CastlingSide::KingSide),
    };
    CastlingWord {
        color,
        side,
        chess960,
    }
}

/// Decodes a word in the castling range.
pub fn castling_word(w: u16) -> Option<CastlingWord> {
    if (FIRST_CASTLING..FIRST_CHESS960_CASTLING).contains(&w) {
        Some(castling_of(w - FIRST_CASTLING, None))
    } else if (FIRST_CHESS960_CASTLING..=LAST_MOVE).contains(&w) {
        let r = w - FIRST_CHESS960_CASTLING;
        Some(castling_of(r % 4, Some(r / 4)))
    } else {
        None
    }
}

/// The castling word for a side, for a writer.
#[cfg(test)]
pub fn castling_word_for(color: Color, side: CastlingSide, chess960: Option<u16>) -> u16 {
    let k = match (color, side) {
        (Color::White, CastlingSide::QueenSide) => 0,
        (Color::White, CastlingSide::KingSide) => 1,
        (Color::Black, CastlingSide::QueenSide) => 2,
        (Color::Black, CastlingSide::KingSide) => 3,
    };
    match chess960 {
        Some(n) => FIRST_CHESS960_CASTLING + 4 * n + k,
        None => FIRST_CASTLING + k,
    }
}

/// The piece and square a placement word names.
pub fn placement_from_word(w: u16) -> Option<(Piece, Square)> {
    let i = w.checked_sub(FIRST_PLACEMENT)?;
    let piece_square = |color: Color, i: u16| {
        Some((
            Piece {
                color,
                role: PLACEMENT_ROLES[usize::from(i / 64)],
            },
            square_from_index((i % 64) as u8)?,
        ))
    };
    let pawn_square = |color: Color, i: u16| {
        Some((
            Piece {
                color,
                role: Role::Pawn,
            },
            Square::from_coords(File::new(u32::from(i / 6)), Rank::new(u32::from(i % 6 + 1))),
        ))
    };
    match i {
        0..=319 => piece_square(Color::White, i),
        320..=639 => piece_square(Color::Black, i - 320),
        640..=687 => pawn_square(Color::White, i - 640),
        688..=735 => pawn_square(Color::Black, i - 688),
        _ => None,
    }
}

/// The placement word of a piece on a square, for a writer. Pawns must stand
/// on ranks 2 to 7.
#[cfg(test)]
pub fn placement_word(piece: Piece, sq: Square) -> u16 {
    let colour_base = if piece.color.is_white() { 0 } else { 320 };
    let i = match piece.role {
        Role::Pawn => {
            let rank = u32::from(sq.rank());
            assert!((1..=6).contains(&rank), "pawn on rank {}", rank + 1);
            640 + colour_base / 320 * 48 + 6 * u32::from(sq.file()) + rank - 1
        }
        role => {
            let r = PLACEMENT_ROLES.iter().position(|&p| p == role).unwrap() as u32;
            colour_base + 64 * r + u32::from(crate::moves::square_to_index(sq))
        }
    };
    FIRST_PLACEMENT + i as u16
}

/// The back rank of Chess960 start position `n` (0-959), `a` to `h`.
pub fn chess960_back_rank(n: u16) -> Option<[Role; 8]> {
    if n >= CHESS960_POSITIONS {
        return None;
    }
    let n = usize::from(n);
    let mut rank: [Option<Role>; 8] = [None; 8];
    let (n2, b1) = (n / 4, n % 4);
    rank[2 * b1 + 1] = Some(Role::Bishop);
    let (n3, b2) = (n2 / 4, n2 % 4);
    rank[2 * b2] = Some(Role::Bishop);
    let (n4, q) = (n3 / 6, n3 % 6);
    let free = |rank: &[Option<Role>; 8]| -> Vec<usize> {
        (0..8).filter(|&i| rank[i].is_none()).collect()
    };
    rank[free(&rank)[q]] = Some(Role::Queen);
    const KNIGHTS: [(usize, usize); 10] = [
        (0, 1),
        (0, 2),
        (0, 3),
        (0, 4),
        (1, 2),
        (1, 3),
        (1, 4),
        (2, 3),
        (2, 4),
        (3, 4),
    ];
    let (i, j) = KNIGHTS[n4];
    let f = free(&rank);
    rank[f[i]] = Some(Role::Knight);
    rank[f[j]] = Some(Role::Knight);
    let f = free(&rank);
    rank[f[0]] = Some(Role::Rook);
    rank[f[1]] = Some(Role::King);
    rank[f[2]] = Some(Role::Rook);
    Some(rank.map(|r| r.expect("every file is filled")))
}

/// The start position of Chess960 game `n`, with all four castling rights.
pub fn chess960_setup(n: u16) -> Option<Setup> {
    let back = chess960_back_rank(n)?;
    let mut board = Board::empty();
    let mut rights = Bitboard::EMPTY;
    for (file, role) in back.iter().enumerate() {
        let f = File::new(file as u32);
        for (color, rank, pawn_rank) in [
            (Color::White, Rank::First, Rank::Second),
            (Color::Black, Rank::Eighth, Rank::Seventh),
        ] {
            board.set_piece_at(Square::from_coords(f, rank), Piece { color, role: *role });
            board.set_piece_at(
                Square::from_coords(f, pawn_rank),
                Piece {
                    color,
                    role: Role::Pawn,
                },
            );
            if *role == Role::Rook {
                rights.add(Square::from_coords(f, rank));
            }
        }
    }
    Some(Setup {
        board,
        turn: Color::White,
        castling_rights: rights,
        ep_square: None,
        halfmoves: 0,
        fullmoves: std::num::NonZeroU32::new(1).unwrap(),
        ..Setup::default()
    })
}

/// The outermost rook of `color` on its back rank on `side` of the king.
fn chess960_rook(board: &Board, color: Color, side: CastlingSide) -> Option<Square> {
    let king = board.king_of(color)?;
    if king.rank() != color.backrank() {
        return None;
    }
    let rooks = board.by_piece(Piece {
        color,
        role: Role::Rook,
    }) & Bitboard::from_rank(color.backrank());
    if side.is_king_side() {
        rooks
            .into_iter()
            .filter(|s| s.file() > king.file())
            .max_by_key(|s| s.file())
    } else {
        rooks
            .into_iter()
            .filter(|s| s.file() < king.file())
            .min_by_key(|s| s.file())
    }
}

/// Rook squares for the castling bits (1 white O-O-O, 2 white O-O, 4 black
/// O-O-O, 8 black O-O). A right whose rook is not where it should be is
/// dropped.
fn castling_rights(board: &Board, bits: u16, chess960: bool) -> Bitboard {
    let mut rights = Bitboard::EMPTY;
    for (bit, color, side) in [
        (1, Color::White, CastlingSide::QueenSide),
        (2, Color::White, CastlingSide::KingSide),
        (4, Color::Black, CastlingSide::QueenSide),
        (8, Color::Black, CastlingSide::KingSide),
    ] {
        if bits & bit == 0 {
            continue;
        }
        let rook = if chess960 {
            chess960_rook(board, color, side)
        } else {
            let file = if side.is_king_side() {
                File::H
            } else {
                File::A
            };
            Some(Square::from_coords(file, color.backrank()))
        };
        if let Some(sq) = rook {
            if board.piece_at(sq)
                == Some(Piece {
                    color,
                    role: Role::Rook,
                })
            {
                rights.add(sq);
            }
        }
    }
    rights
}

/// A decoded start position section.
#[derive(Debug, Clone)]
pub struct StartPosition {
    pub setup: Setup,
    pub chess960: bool,
}

/// Decodes the words between `fffb` and `fffc`: a Chess960 start position
/// number, a set-up position, or the word 1000 and a set-up position.
pub fn decode_start_position(words: &[u16]) -> Result<StartPosition, String> {
    if words.len() == 1 && words[0] < CHESS960_POSITIONS {
        return Ok(StartPosition {
            setup: chess960_setup(words[0]).expect("checked range"),
            chess960: true,
        });
    }
    let (chess960, rest) = match words.first() {
        Some(&SETUP_CHESS960_PREFIX) => (true, &words[1..]),
        _ => (false, words),
    };
    if rest.len() < 3 {
        return Err(format!(
            "start position section has {} word(s); expected a Chess960 number or a set-up position",
            words.len()
        ));
    }
    let move_number = rest[0];
    let turn = match rest[1] & 0xff {
        0 => Color::White,
        1 => Color::Black,
        other => return Err(format!("side to move is {other}")),
    };
    let ep_file = rest[1] >> 8;
    let ep_square = (1..=8).contains(&ep_file).then(|| {
        let rank = if turn.is_white() {
            Rank::Sixth
        } else {
            Rank::Third
        };
        Square::from_coords(File::new(u32::from(ep_file - 1)), rank)
    });
    let mut board = Board::empty();
    for &w in &rest[3..] {
        let (piece, sq) = placement_from_word(w)
            .ok_or_else(|| format!("word {w:#06x} in a set-up position is not a piece"))?;
        if board.piece_at(sq).is_some() {
            return Err(format!("set-up position places two pieces on {sq}"));
        }
        board.set_piece_at(sq, piece);
    }
    let castling_rights = castling_rights(&board, rest[2], chess960);
    Ok(StartPosition {
        setup: Setup {
            board,
            turn,
            castling_rights,
            ep_square,
            halfmoves: 0,
            fullmoves: std::num::NonZeroU32::new(u32::from(move_number.max(1))).unwrap(),
            ..Setup::default()
        },
        chess960,
    })
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

fn color_name(color: Color) -> &'static str {
    if color.is_white() {
        "white"
    } else {
        "black"
    }
}

/// Turns a move word into a move, checking it against the board.
fn build_move(pos: &Chess, spec: &MoveSpec) -> Result<Move, String> {
    let board = pos.board();
    let color = pos.turn();
    if spec.color != color {
        return Err(format!(
            "move word for {} while {} is to move",
            color_name(spec.color),
            color_name(color)
        ));
    }
    if board.piece_at(spec.from)
        != Some(Piece {
            color,
            role: spec.role,
        })
    {
        return Err(format!(
            "no {} {} on {} to move to {}",
            color_name(color),
            role_name(spec.role),
            spec.from,
            spec.to
        ));
    }
    let on_target = board.piece_at(spec.to);
    match spec.captured {
        Captured::Nothing => {
            if on_target.is_some() {
                return Err(format!(
                    "move word {}{} captures nothing, but {} is occupied",
                    spec.from, spec.to, spec.to
                ));
            }
            Ok(Move::Normal {
                role: spec.role,
                from: spec.from,
                capture: None,
                to: spec.to,
                promotion: spec.promotion,
            })
        }
        Captured::Piece(r) => match on_target {
            Some(p) if p.color != color && p.role == r => Ok(Move::Normal {
                role: spec.role,
                from: spec.from,
                capture: Some(r),
                to: spec.to,
                promotion: spec.promotion,
            }),
            _ => Err(format!(
                "move word {}{} captures a {}, but {} holds {}",
                spec.from,
                spec.to,
                role_name(r),
                spec.to,
                on_target
                    .map(|p| format!("a {} {}", color_name(p.color), role_name(p.role)))
                    .unwrap_or_else(|| "nothing".to_string())
            )),
        },
        Captured::EnPassant => Ok(Move::EnPassant {
            from: spec.from,
            to: spec.to,
        }),
    }
}

fn castle(pos: &Chess, c: CastlingWord) -> Result<Move, String> {
    let color = pos.turn();
    if c.color != color {
        return Err(format!(
            "castling word for {} while {} is to move",
            color_name(c.color),
            color_name(color)
        ));
    }
    let king = pos
        .board()
        .king_of(color)
        .ok_or_else(|| format!("{} has no king", color_name(color)))?;
    let rook = pos.castles().rook(color, c.side).ok_or_else(|| {
        format!(
            "{} cannot castle {} here",
            color_name(color),
            if c.side.is_king_side() {
                "king-side"
            } else {
                "queen-side"
            }
        )
    })?;
    Ok(Move::Castle { king, rook })
}

#[derive(Clone)]
struct State {
    pos: Chess,
    node: usize,
}

struct Decoder {
    mode: CastlingMode,
    nodes: Vec<Node>,
    stack: Vec<State>,
    state: State,
    /// The state before the last move, which `fffd` pushes.
    before_last: Option<State>,
    /// Moves decoded so far, for error messages.
    n: u32,
}

impl Decoder {
    fn new(pos: Chess, mode: CastlingMode) -> Decoder {
        Decoder {
            mode,
            nodes: vec![Node::default()],
            stack: Vec::new(),
            state: State { pos, node: 0 },
            before_last: None,
            n: 0,
        }
    }

    fn play(&mut self, d: Decoded) -> Result<(), String> {
        let before = self.state.clone();
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
        self.before_last = Some(before);
        self.n += 1;
        Ok(())
    }

    fn mark_alternative(&mut self) -> Result<(), String> {
        let before = self
            .before_last
            .take()
            .ok_or("alternative marker fffd without a move before it")?;
        self.stack.push(before);
        Ok(())
    }

    /// Returns `false` when there was nothing to pop: the game is over.
    fn end_line(&mut self) -> bool {
        match self.stack.pop() {
            Some(s) => {
                self.state = s;
                self.before_last = None;
                true
            }
            None => false,
        }
    }
}

/// Decodes the content of a game's `.2cbg` record. `tag` is the record's
/// tag: 1 for chess, 2 for Chess960.
pub fn decode_moves(
    tag: u16,
    content: &[u8],
    warnings: &mut Vec<String>,
) -> Result<DecodedMoves, String> {
    let mut chess960 = match tag {
        TAG_GAME => false,
        TAG_CHESS960 => true,
        TAG_TEXT => return Err("the moves record is a guiding text".to_string()),
        other => return Err(format!("moves record has tag {other:#06x}, not a game")),
    };
    if !content.len().is_multiple_of(2) {
        return Err(format!(
            "move stream has an odd number of bytes ({})",
            content.len()
        ));
    }
    let words: Vec<u16> = content
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let mut start = None;
    let mut i = match words.first() {
        Some(&WORD_SETUP) => {
            let end = words
                .iter()
                .position(|&w| w == WORD_MOVES)
                .ok_or("start position section has no move section after it")?;
            start = Some(decode_start_position(&words[1..end])?);
            end + 1
        }
        Some(&WORD_MOVES) => 1,
        Some(w) => {
            return Err(format!(
                "move stream begins with word {w:#06x}, not a section marker"
            ))
        }
        None => return Err("empty move stream".to_string()),
    };
    chess960 |= start.as_ref().is_some_and(|s| s.chess960);
    let mode = if chess960 {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };
    let (pos, setup_fen) = match start {
        Some(s) => {
            let pos = position_from_setup(s.setup, mode)?;
            let fen = Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string();
            (pos, Some(fen))
        }
        None if chess960 => (position_from_setup(Setup::default(), mode)?, None),
        None => (Chess::default(), None),
    };
    let mut dec = Decoder::new(pos, mode);
    let table = move_table();
    let mut finished = false;
    while i < words.len() {
        let w = words[i];
        i += 1;
        match w {
            WORD_NULL_MOVE => dec.play(Decoded::Null)?,
            WORD_ALTERNATIVE => dec.mark_alternative()?,
            WORD_END => {
                if !dec.end_line() {
                    finished = true;
                    break;
                }
            }
            WORD_SETUP | WORD_MOVES => {
                return Err(format!("section marker {w:#06x} inside the moves"));
            }
            0xfffe => return Err("unknown marker fffe".to_string()),
            0 => return Err("move word 0 is not used".to_string()),
            w if w <= LAST_PIECE_MOVE => {
                let m = build_move(&dec.state.pos, &table[usize::from(w)])?;
                dec.play(Decoded::Move(m))?;
            }
            w if w <= LAST_MOVE => {
                let c = castling_word(w).expect("in the castling range");
                let m = castle(&dec.state.pos, c)?;
                dec.play(Decoded::Move(m))?;
            }
            w => return Err(format!("piece placement word {w:#06x} in the move section")),
        }
    }
    if finished {
        if i < words.len() {
            warnings.push(format!(
                "{} word(s) after the end of the game were ignored",
                words.len() - i
            ));
        }
    } else {
        warnings.push("move stream ended without an end-of-line marker".to_string());
    }
    Ok(DecodedMoves {
        nodes: dec.nodes,
        setup_fen,
        chess960,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::collections::HashMap;

    /// The inverse of the move table.
    pub fn word_index() -> &'static HashMap<MoveSpec, u16> {
        static INDEX: OnceLock<HashMap<MoveSpec, u16>> = OnceLock::new();
        INDEX.get_or_init(|| {
            move_table()
                .iter()
                .enumerate()
                .skip(1)
                .map(|(i, s)| (*s, i as u16))
                .collect()
        })
    }

    /// The word of a legal move in `pos`.
    pub fn word_of(pos: &Chess, m: &Move) -> u16 {
        let color = pos.turn();
        match *m {
            Move::Normal {
                role,
                from,
                capture,
                to,
                promotion,
            } => word_index()[&MoveSpec {
                color,
                role,
                from,
                to,
                captured: capture.map(Captured::Piece).unwrap_or(Captured::Nothing),
                promotion,
            }],
            Move::EnPassant { from, to } => word_index()[&MoveSpec {
                color,
                role: Role::Pawn,
                from,
                to,
                captured: Captured::EnPassant,
                promotion: None,
            }],
            Move::Castle { king, rook } => {
                let side = CastlingSide::from_king_side(rook.file() > king.file());
                castling_word_for(color, side, None)
            }
            Move::Put { .. } => unreachable!(),
        }
    }

    /// Words of a line of SAN moves from `pos` (no variations).
    pub fn words_of(pos: &Chess, sans: &str) -> (Vec<u16>, Chess) {
        let mut pos = pos.clone();
        let mut out = Vec::new();
        for san in sans.split_whitespace() {
            let m = shakmaty::san::San::from_ascii(san.as_bytes())
                .unwrap()
                .to_move(&pos)
                .unwrap();
            out.push(word_of(&pos, &m));
            pos.play_unchecked(&m);
        }
        (out, pos)
    }

    pub fn bytes(words: &[u16]) -> Vec<u8> {
        words.iter().flat_map(|w| w.to_le_bytes()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    fn sans(d: &DecodedMoves) -> String {
        d.nodes[1..]
            .iter()
            .map(|n| n.san.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn decode(words: &[u16]) -> Result<(DecodedMoves, Vec<String>), String> {
        let mut warnings = Vec::new();
        decode_moves(TAG_GAME, &bytes(words), &mut warnings).map(|d| (d, warnings))
    }

    #[test]
    fn blocks_start_where_the_spec_says() {
        let t = move_table();
        assert_eq!(t.len(), usize::from(FIRST_CASTLING));
        let first = |color: Color, role: Role| {
            t.iter()
                .skip(1)
                .position(|s| s.color == color && s.role == role)
                .unwrap()
                + 1
        };
        let expected: [(Color, Role, usize); 12] = [
            (Color::White, Role::King, 0x0001),
            (Color::White, Role::Queen, 0x09d9),
            (Color::White, Role::Knight, 0x2bf9),
            (Color::White, Role::Bishop, 0x33d9),
            (Color::White, Role::Rook, 0x40f9),
            (Color::Black, Role::King, 0x55f9),
            (Color::Black, Role::Queen, 0x5fd1),
            (Color::Black, Role::Knight, 0x81f1),
            (Color::Black, Role::Bishop, 0x89d1),
            (Color::Black, Role::Rook, 0x96f1),
            (Color::White, Role::Pawn, 0xabf1),
            (Color::Black, Role::Pawn, 0xae8d),
        ];
        for (color, role, word) in expected {
            assert_eq!(first(color, role), word, "{color:?} {role:?}");
        }
        // The white king on a1 reaches a2 as word 1 and b1 as word 7.
        assert_eq!(
            (t[1].from, t[1].to, t[1].captured),
            (Square::A1, Square::A2, Captured::Nothing)
        );
        assert_eq!((t[7].from, t[7].to), (Square::A1, Square::B1));
        assert_eq!(t[2].captured, Captured::Piece(Role::Queen));
        assert_eq!(t[6].captured, Captured::Piece(Role::Pawn));
        // Pawn blocks begin at a2: the double step for white, promotions for black.
        let wp = &t[0xabf1];
        assert_eq!(
            (wp.from, wp.to, wp.promotion),
            (Square::A2, Square::A4, None)
        );
        let bp = &t[0xae8d];
        assert_eq!(
            (bp.from, bp.to, bp.promotion),
            (Square::A2, Square::A1, Some(Role::Queen))
        );
        // Every word is distinct.
        assert_eq!(word_index().len(), t.len() - 1);
    }

    #[test]
    fn words_transcribed_from_a_real_record_decode_to_the_1886_opening() {
        // The first words of game 1 of a converted World Championship
        // database: 1.d4 d5 2.c4 c6 3.e3.
        let (d, warnings) =
            decode(&[WORD_MOVES, 0xace1, 0xafcf, 0xac83, 0xaf72, 0xad40, WORD_END]).unwrap();
        assert_eq!(sans(&d), "d4 d5 c4 c6 e3");
        assert!(warnings.is_empty());
        assert!(d.setup_fen.is_none());
        assert!(!d.chess960);
        assert!(d.nodes[1].white && d.nodes[1].fullmove == 1);
        assert!(!d.nodes[2].white && d.nodes[2].fullmove == 1);
        assert!(d.nodes[5].white && d.nodes[5].fullmove == 3);
    }

    #[test]
    fn alternatives_are_stored_most_recent_branch_point_first() {
        // 1.e4 c5 (1...c6 2.d4) (1...Nf6 2.e5) 2.Nf3 d6 (2...Nc6 3.Bb5) 3.d4
        let start = Chess::default();
        let (main, _) = words_of(&start, "e4 c5 Nf3 d6 d4");
        let (_, after_nf3) = words_of(&start, "e4 c5 Nf3");
        let (nc6, _) = words_of(&after_nf3, "Nc6 Bb5");
        let (_, after_e4) = words_of(&start, "e4");
        let (c6, _) = words_of(&after_e4, "c6 d4");
        let (nf6, _) = words_of(&after_e4, "Nf6 e5");
        let words = [
            WORD_MOVES,
            main[0],
            main[1],
            WORD_ALTERNATIVE,
            main[2],
            main[3],
            WORD_ALTERNATIVE,
            main[4],
            WORD_END,
            nc6[0],
            nc6[1],
            WORD_END,
            c6[0],
            WORD_ALTERNATIVE,
            c6[1],
            WORD_END,
            nf6[0],
            nf6[1],
            WORD_END,
        ];
        let (d, warnings) = decode(&words).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(sans(&d), "e4 c5 Nf3 d6 d4 Nc6 Bb5 c6 d4 Nf6 e5");
        assert_eq!(d.nodes[0].children, vec![1]);
        assert_eq!(d.nodes[1].children, vec![2, 8, 10]);
        assert_eq!(d.nodes[3].children, vec![4, 6]);
        assert_eq!(d.nodes[6].children, vec![7]);
        assert_eq!(d.nodes[8].children, vec![9]);
        assert_eq!(d.nodes[10].children, vec![11]);
        assert!(!d.nodes[8].white && d.nodes[8].fullmove == 1);
        assert!(d.nodes[9].white && d.nodes[9].fullmove == 2);
    }

    #[test]
    fn checksum_follows_the_spec() {
        // The spec's worked example: an empty annotation record.
        assert_eq!(checksum(&[0xff, 0xff, 0xff, 0x7f]), 0x7fff_ffff);
        assert_eq!(
            checksum(&[0xff, 0xff, 0xff, 0x7f]).to_be_bytes(),
            [0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]
        );
        assert_eq!(checksum(&[]), 0);
        // Sixteen bytes: eight runs of two, the last mod 8 bytes ignored.
        let content: Vec<u8> = (1..=17).collect();
        let expected = u64::from_le_bytes([3, 7, 11, 15, 19, 23, 27, 31]);
        assert_eq!(checksum(&content), expected);
        let mut wide = [0u8; 16];
        wide[0] = 200;
        wide[1] = 100;
        assert_eq!(checksum(&wide), 44);
        assert_eq!(checksum(&[200, 100, 0, 0, 0, 0, 0, 0]), 200 + 100 * 256);
    }

    #[test]
    fn record_head_checks_the_magic_and_sizes() {
        let mut head = MAGIC.to_vec();
        head.extend_from_slice(&704i32.to_le_bytes());
        head.extend_from_slice(&98i32.to_le_bytes());
        head.extend_from_slice(&0x0102_0304_0506_0708u64.to_be_bytes());
        head.extend_from_slice(&TAG_GAME.to_le_bytes());
        let h = parse_record_head(&head).unwrap();
        assert_eq!(h.content_size, 704);
        assert_eq!(h.spare_size, 98);
        assert_eq!(h.checksum, 0x0102_0304_0506_0708);
        assert_eq!(h.tag, 1);
        head[0] = 0;
        assert!(parse_record_head(&head).unwrap_err().contains("magic"));
        head[0] = 0x88;
        head[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        assert!(parse_record_head(&head).unwrap_err().contains("negative"));
        assert!(parse_record_head(&head[..20]).is_err());
    }

    #[test]
    fn castling_words_cover_both_sets() {
        let w = castling_word(0xb129).unwrap();
        assert_eq!(
            (w.color, w.side, w.chess960),
            (Color::White, CastlingSide::QueenSide, None)
        );
        let w = castling_word(0xb12c).unwrap();
        assert_eq!((w.color, w.side), (Color::Black, CastlingSide::KingSide));
        let w = castling_word(0xb12d + 4 * 100 + 1).unwrap();
        assert_eq!(
            (w.color, w.side, w.chess960),
            (Color::White, CastlingSide::KingSide, Some(100))
        );
        let w = castling_word(LAST_MOVE).unwrap();
        assert_eq!(
            (w.color, w.side, w.chess960),
            (Color::Black, CastlingSide::KingSide, Some(959))
        );
        assert!(castling_word(0xb128).is_none());
        assert!(castling_word(FIRST_PLACEMENT).is_none());
        for (color, side) in [
            (Color::White, CastlingSide::QueenSide),
            (Color::White, CastlingSide::KingSide),
            (Color::Black, CastlingSide::QueenSide),
            (Color::Black, CastlingSide::KingSide),
        ] {
            for n in [None, Some(0), Some(518), Some(959)] {
                let w = castling_word(castling_word_for(color, side, n)).unwrap();
                assert_eq!((w.color, w.side, w.chess960), (color, side, n));
            }
        }
    }

    #[test]
    fn placement_words_round_trip_and_sit_where_the_spec_says() {
        for color in [Color::White, Color::Black] {
            for role in [
                Role::King,
                Role::Queen,
                Role::Knight,
                Role::Bishop,
                Role::Rook,
                Role::Pawn,
            ] {
                for sq in scan_order() {
                    if role == Role::Pawn && matches!(sq.rank(), Rank::First | Rank::Eighth) {
                        continue;
                    }
                    let piece = Piece { color, role };
                    let w = placement_word(piece, sq);
                    assert!((FIRST_PLACEMENT..=LAST_PLACEMENT).contains(&w));
                    assert_eq!(placement_from_word(w), Some((piece, sq)), "{piece:?} {sq}");
                }
            }
        }
        let wk = Piece {
            color: Color::White,
            role: Role::King,
        };
        assert_eq!(placement_word(wk, Square::A1), 0xc02d);
        let wr = Piece {
            color: Color::White,
            role: Role::Rook,
        };
        assert_eq!(placement_word(wr, Square::H8), 0xc16c);
        let bk = Piece {
            color: Color::Black,
            role: Role::King,
        };
        assert_eq!(placement_word(bk, Square::A1), 0xc16d);
        let br = Piece {
            color: Color::Black,
            role: Role::Rook,
        };
        assert_eq!(placement_word(br, Square::H8), 0xc2ac);
        let wp = Piece {
            color: Color::White,
            role: Role::Pawn,
        };
        assert_eq!(placement_word(wp, Square::A2), 0xc2ad);
        assert_eq!(placement_word(wp, Square::H7), 0xc2dc);
        let bp = Piece {
            color: Color::Black,
            role: Role::Pawn,
        };
        assert_eq!(placement_word(bp, Square::A2), 0xc2dd);
        assert_eq!(placement_word(bp, Square::H7), 0xc30c);
        assert!(placement_from_word(0xc30d).is_none());
        assert!(placement_from_word(0xc02c).is_none());
    }

    #[test]
    fn chess960_back_ranks() {
        let name = |r: [Role; 8]| r.iter().map(|r| r.upper_char()).collect::<String>();
        assert_eq!(name(chess960_back_rank(518).unwrap()), "RNBQKBNR");
        assert_eq!(name(chess960_back_rank(0).unwrap()), "BBQNNRKR");
        assert_eq!(name(chess960_back_rank(959).unwrap()), "RKRNNQBB");
        assert!(chess960_back_rank(960).is_none());
        let setup = chess960_setup(0).unwrap();
        let pos = position_from_setup(setup, CastlingMode::Chess960).unwrap();
        assert_eq!(
            Fen::from_position(pos, EnPassantMode::Legal).to_string(),
            "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"
        );
    }

    #[test]
    fn start_position_sections() {
        // A Chess960 number alone.
        let s = decode_start_position(&[518]).unwrap();
        assert!(s.chess960);
        assert_eq!(s.setup.board, Board::default());
        // A set-up position: black to move, e-file en passant, white may castle both ways.
        let wk = Piece {
            color: Color::White,
            role: Role::King,
        };
        let wr = Piece {
            color: Color::White,
            role: Role::Rook,
        };
        let wp = Piece {
            color: Color::White,
            role: Role::Pawn,
        };
        let bk = Piece {
            color: Color::Black,
            role: Role::King,
        };
        let bp = Piece {
            color: Color::Black,
            role: Role::Pawn,
        };
        let words = [
            12,
            0x0501,
            0b0011,
            placement_word(wk, Square::E1),
            placement_word(wr, Square::A1),
            placement_word(wr, Square::H1),
            placement_word(wp, Square::E5),
            placement_word(bk, Square::E8),
            placement_word(bp, Square::D5),
        ];
        let s = decode_start_position(&words).unwrap();
        assert!(!s.chess960);
        assert_eq!(s.setup.turn, Color::Black);
        assert_eq!(s.setup.fullmoves.get(), 12);
        assert_eq!(s.setup.ep_square, Some(Square::E3));
        assert!(s.setup.castling_rights.contains(Square::A1));
        assert!(s.setup.castling_rights.contains(Square::H1));
        assert!(!s.setup.castling_rights.contains(Square::A8));
        assert_eq!(s.setup.board.piece_at(Square::D5), Some(bp));
        // The en passant byte 15 means none.
        let mut none = words;
        none[1] = 0x0f00;
        let s = decode_start_position(&none).unwrap();
        assert_eq!(s.setup.turn, Color::White);
        assert_eq!(s.setup.ep_square, None);
        // Castling bits whose rook is missing are dropped.
        let mut no_rook = words.to_vec();
        no_rook.remove(4);
        let s = decode_start_position(&no_rook).unwrap();
        assert!(!s.setup.castling_rights.contains(Square::A1));
        assert!(s.setup.castling_rights.contains(Square::H1));
        // The 1000 prefix: Chess960 with the rooks found beside the king.
        let c960 = [
            SETUP_CHESS960_PREFIX,
            1,
            0,
            0b1111,
            placement_word(wk, Square::B1),
            placement_word(wr, Square::A1),
            placement_word(wr, Square::E1),
            placement_word(bk, Square::B8),
            placement_word(
                Piece {
                    color: Color::Black,
                    role: Role::Rook,
                },
                Square::A8,
            ),
            placement_word(
                Piece {
                    color: Color::Black,
                    role: Role::Rook,
                },
                Square::E8,
            ),
        ];
        let s = decode_start_position(&c960).unwrap();
        assert!(s.chess960);
        assert_eq!(
            s.setup.castling_rights,
            Bitboard::from_iter([Square::A1, Square::E1, Square::A8, Square::E8])
        );
        // Errors.
        assert!(decode_start_position(&[1, 0])
            .unwrap_err()
            .contains("2 word(s)"));
        assert!(decode_start_position(&[1, 2, 0])
            .unwrap_err()
            .contains("side to move is 2"));
        assert!(decode_start_position(&[1, 0, 0, 0xc02c])
            .unwrap_err()
            .contains("not a piece"));
        let twice = [
            1,
            0,
            0,
            placement_word(wk, Square::E1),
            placement_word(wr, Square::E1),
        ];
        assert!(decode_start_position(&twice)
            .unwrap_err()
            .contains("two pieces on e1"));
    }

    #[test]
    fn set_up_games_null_moves_and_promotions() {
        let wk = Piece {
            color: Color::White,
            role: Role::King,
        };
        let wp = Piece {
            color: Color::White,
            role: Role::Pawn,
        };
        let bk = Piece {
            color: Color::Black,
            role: Role::King,
        };
        let bn = Piece {
            color: Color::Black,
            role: Role::Knight,
        };
        let setup = [
            WORD_SETUP,
            30,
            0,
            0,
            placement_word(wk, Square::H1),
            placement_word(wp, Square::B7),
            placement_word(bk, Square::A1),
            placement_word(bn, Square::C8),
            WORD_MOVES,
        ];
        let pos = position_from_setup(
            decode_start_position(&setup[1..setup.len() - 1])
                .unwrap()
                .setup,
            CastlingMode::Standard,
        )
        .unwrap();
        let (line, after) = words_of(&pos, "bxc8=N Ka2");
        let passed = play_null(&after, CastlingMode::Standard).unwrap();
        let (kb2, _) = words_of(&passed, "Kb2");
        let (alt, _) = words_of(&pos, "b8=R");
        let mut words = setup.to_vec();
        words.extend([
            line[0],
            WORD_ALTERNATIVE,
            line[1],
            WORD_NULL_MOVE,
            kb2[0],
            WORD_END,
            alt[0],
            WORD_END,
        ]);
        let (d, warnings) = decode(&words).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(sans(&d), "bxc8=N Ka2 -- Kb2 b8=R");
        assert_eq!(
            d.setup_fen.as_deref(),
            Some("2n5/1P6/8/8/8/8/8/k6K w - - 0 30")
        );
        assert!(d.nodes[3].is_null);
        assert_eq!(d.nodes[0].children, vec![1, 5]);
        assert_eq!(d.nodes[1].children, vec![2]);
        assert_eq!(d.nodes[2].children, vec![3]);
        assert!(d.nodes[3].white && d.nodes[3].fullmove == 31);
        assert!(!d.nodes[4].white && d.nodes[4].fullmove == 31);
        assert!(d.nodes[5].white && d.nodes[5].fullmove == 30);
    }

    #[test]
    fn chess960_games_castle_with_their_own_words() {
        // Position 100: QBBNRNKR; once the f1 knight has moved, the king on
        // g1 castles king-side with the h1 rook.
        let setup = chess960_setup(100).unwrap();
        let pos = position_from_setup(setup, CastlingMode::Chess960).unwrap();
        let (line, after) = words_of(&pos, "e4 e5 Ng3 Ng6");
        let oo = castling_word_for(Color::White, CastlingSide::KingSide, Some(100));
        let (rest, _) = words_of(&after, "O-O");
        assert_ne!(
            rest[0], oo,
            "the helper writes plain castling words; Chess960 ones are separate"
        );
        let mut words = vec![WORD_SETUP, 100, WORD_MOVES];
        words.extend(&line);
        words.extend([oo, WORD_END]);
        let mut warnings = Vec::new();
        let d = decode_moves(TAG_CHESS960, &bytes(&words), &mut warnings).unwrap();
        assert!(warnings.is_empty());
        assert!(d.chess960);
        assert_eq!(sans(&d), "e4 e5 Ng3 Ng6 O-O");
        assert_eq!(
            d.setup_fen.as_deref(),
            Some("qbbnrnkr/pppppppp/8/8/8/8/PPPPPPPP/QBBNRNKR w KQkq - 0 1")
        );
        // A plain castling word also works there.
        let last = words.len() - 2;
        words[last] = rest[0];
        let d = decode_moves(TAG_CHESS960, &bytes(&words), &mut warnings).unwrap();
        assert_eq!(sans(&d), "e4 e5 Ng3 Ng6 O-O");
    }

    #[test]
    fn damaged_streams_are_rejected_or_warned_about() {
        let e4 = words_of(&Chess::default(), "e4").0[0];
        let err = |words: &[u16]| decode(words).unwrap_err();
        assert!(decode_moves(TAG_GAME, &[1, 2, 3], &mut Vec::new())
            .unwrap_err()
            .contains("odd number"));
        assert!(err(&[]).contains("empty"));
        assert!(err(&[e4]).contains("not a section marker"));
        assert!(err(&[WORD_SETUP, 518]).contains("no move section"));
        assert!(err(&[WORD_MOVES, 0xfffe]).contains("fffe"));
        assert!(err(&[WORD_MOVES, 0]).contains("word 0"));
        assert!(err(&[WORD_MOVES, WORD_SETUP]).contains("inside the moves"));
        assert!(err(&[WORD_MOVES, FIRST_PLACEMENT]).contains("piece placement"));
        assert!(err(&[WORD_MOVES, WORD_ALTERNATIVE]).contains("without a move"));
        assert!(
            err(&[WORD_MOVES, e4, WORD_ALTERNATIVE, WORD_ALTERNATIVE]).contains("without a move")
        );
        // Nf3 capturing a queen: the square is empty.
        let nf3 = words_of(&Chess::default(), "Nf3").0[0];
        assert!(err(&[WORD_MOVES, nf3 + 1]).contains("captures a queen, but f3 holds nothing"));
        // A black move while white is to move.
        let e5 = words_of(&Chess::default(), "e4 e5").0[1];
        assert!(err(&[WORD_MOVES, e5]).contains("while white is to move"));
        // A white rook move from a1 up one: the piece is there but the square is occupied.
        let a1a2 = word_index()[&MoveSpec {
            color: Color::White,
            role: Role::Rook,
            from: Square::A1,
            to: Square::A2,
            captured: Captured::Nothing,
            promotion: None,
        }];
        assert!(err(&[WORD_MOVES, a1a2]).contains("occupied"));
        let a1a3 = word_index()[&MoveSpec {
            color: Color::White,
            role: Role::Rook,
            from: Square::A1,
            to: Square::A3,
            captured: Captured::Nothing,
            promotion: None,
        }];
        assert!(err(&[WORD_MOVES, a1a3]).contains("illegal move a1a3"));
        // A piece that is not where the word says.
        let a3 = word_index()[&MoveSpec {
            color: Color::White,
            role: Role::Knight,
            from: Square::A3,
            to: Square::B5,
            captured: Captured::Nothing,
            promotion: None,
        }];
        assert!(err(&[WORD_MOVES, a3]).contains("no white knight on a3"));
        // Castling that is not legal, and castling after the right is gone.
        assert!(err(&[WORD_MOVES, FIRST_CASTLING]).contains("illegal move e1c1"));
        assert!(err(&[WORD_MOVES, FIRST_CASTLING + 2]).contains("castling word for black"));
        let (moved, _) = words_of(&Chess::default(), "e4 e5 Ke2 Ke7");
        let mut gone = vec![WORD_MOVES];
        gone.extend(&moved);
        gone.push(FIRST_CASTLING + 1);
        assert!(err(&gone).contains("white cannot castle king-side here"));
        // Guiding text and unknown tags.
        assert!(decode_moves(TAG_TEXT, &[], &mut Vec::new())
            .unwrap_err()
            .contains("guiding text"));
        assert!(decode_moves(7, &[], &mut Vec::new())
            .unwrap_err()
            .contains("tag 0x0007"));
        // Warnings: a missing end marker and words after the end.
        let (d, w) = decode(&[WORD_MOVES, e4]).unwrap();
        assert_eq!(sans(&d), "e4");
        assert_eq!(w, vec!["move stream ended without an end-of-line marker"]);
        let (d, w) = decode(&[WORD_MOVES, e4, WORD_END, e4, e4]).unwrap();
        assert_eq!(sans(&d), "e4");
        assert_eq!(w, vec!["2 word(s) after the end of the game were ignored"]);
        let (d, w) = decode(&[WORD_MOVES, WORD_END]).unwrap();
        assert_eq!(d.nodes.len(), 1);
        assert!(w.is_empty());
    }
}
