//! Test-only encoder: writes small but structurally valid `.cbh`, `.cbg`,
//! `.cba`, `.cbp`, `.cbt`, `.cbc` and `.cbs` files so the reader can be
//! exercised without real ChessBase databases.
//!
//! It mirrors the decoder (and shares the piece-numbering tracker with it), so
//! a misreading of the format that is symmetric on both sides would pass these
//! tests. Validation against real files is still required.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::{
    Board, CastlingMode, CastlingSide, Chess, Color, EnPassantMode, FromSetup, Move, Position,
    Role, Square,
};

use crate::moves::{
    play_null, position_from_setup, role_bits, scan_order, square_to_index, Tracker, CODE_TWO_BYTE,
    CODE_VARIATION_END, CODE_VARIATION_START, KING_DELTAS, KNIGHT_DELTAS, PAWN_FIRST_CODE,
    PIECE_BLOCKS,
};
use crate::tables;

/// Packs a date the way the format does.
pub fn packed_date(year: u32, month: u32, day: u32) -> u32 {
    (year << 9) | (month << 5) | day
}

/// One game to write.
#[derive(Debug, Clone)]
pub struct TestGame {
    pub white: (Vec<u8>, Vec<u8>),
    pub black: (Vec<u8>, Vec<u8>),
    pub white_elo: u16,
    pub black_elo: u16,
    pub event: Vec<u8>,
    pub site: Vec<u8>,
    pub event_date: u32,
    pub round: u8,
    pub subround: u8,
    pub date: u32,
    pub result: u8,
    pub line_eval: u8,
    pub eco: u16,
    pub annotator: Vec<u8>,
    pub source: Vec<u8>,
    /// Start position; `None` for the standard one.
    pub fen: Option<String>,
    /// Moves as bare SAN tokens, `--` for a null move, `(` `)` for variations.
    /// Tokens ending in `.` (move numbers) are ignored.
    pub moves: String,
    /// `(position, type, data)`.
    pub annotations: Vec<(i32, u8, Vec<u8>)>,
    pub mode: u8,
    pub deleted: bool,
    pub guiding_text: bool,
}

impl Default for TestGame {
    fn default() -> Self {
        TestGame {
            white: (b"White".to_vec(), Vec::new()),
            black: (b"Black".to_vec(), Vec::new()),
            white_elo: 0,
            black_elo: 0,
            event: Vec::new(),
            site: Vec::new(),
            event_date: 0,
            round: 0,
            subround: 0,
            date: 0,
            result: 3,
            line_eval: 0,
            eco: 0,
            annotator: Vec::new(),
            source: Vec::new(),
            fen: None,
            moves: String::new(),
            annotations: Vec::new(),
            mode: 0,
            deleted: false,
            guiding_text: false,
        }
    }
}

/// A database to write.
#[derive(Debug, Clone, Default)]
pub struct TestDb {
    pub games: Vec<TestGame>,
    /// Write 32-byte entity headers instead of 28-byte ones.
    pub extra_entity_header: bool,
}

/// Mirror of `decode_board`: the 24-byte board stream.
pub fn encode_board(board: &Board) -> Vec<u8> {
    let mut bits: Vec<u8> = Vec::new();
    for sq in scan_order() {
        match board.piece_at(sq) {
            None => bits.push(0),
            Some(p) => {
                bits.push(1);
                bits.push(if p.color.is_white() { 0 } else { 1 });
                let r = role_bits(p.role);
                bits.extend([(r >> 2) & 1, (r >> 1) & 1, r & 1]);
            }
        }
    }
    bits.resize(192, 0);
    bits.chunks(8)
        .map(|c| c.iter().fold(0u8, |acc, b| (acc << 1) | b))
        .collect()
}

/// The 28-byte start position block (and the 8-byte Chess960 block).
fn encode_setup(pos: &Chess, chess960: bool) -> Vec<u8> {
    let setup = pos.clone().into_setup(EnPassantMode::Legal);
    let mut out = vec![1u8];
    let ep = setup
        .ep_square
        .map(|s| u32::from(s.file()) as u8 + 1)
        .unwrap_or(0);
    out.push(ep | if setup.turn.is_white() { 0 } else { 0x10 });
    let mut castling = 0u8;
    for (bit, color, side) in [
        (0x01, Color::White, CastlingSide::QueenSide),
        (0x02, Color::White, CastlingSide::KingSide),
        (0x04, Color::Black, CastlingSide::QueenSide),
        (0x08, Color::Black, CastlingSide::KingSide),
    ] {
        if pos.castles().has(color, side) {
            castling |= bit;
        }
    }
    out.push(castling);
    out.push(setup.fullmoves.get().min(255) as u8);
    out.extend(encode_board(&setup.board));
    if chess960 {
        let sq = |s: Option<Square>| s.map(square_to_index).unwrap_or(0);
        out.push(sq(pos.board().king_of(Color::White)));
        out.push(sq(pos.board().king_of(Color::Black)));
        out.push(sq(pos.castles().rook(Color::White, CastlingSide::KingSide)));
        out.push(sq(pos
            .castles()
            .rook(Color::White, CastlingSide::QueenSide)));
        out.push(sq(pos.castles().rook(Color::Black, CastlingSide::KingSide)));
        out.push(sq(pos
            .castles()
            .rook(Color::Black, CastlingSide::QueenSide)));
        out.extend_from_slice(&0u16.to_be_bytes());
    }
    out
}

#[derive(Debug, Clone, Copy)]
enum Ev {
    Push,
    Pop,
    /// `code` is the one-byte code when the move has one; `word` is always the
    /// two-byte form.
    Move {
        code: Option<u8>,
        word: u16,
    },
}

struct EncNode {
    san: String,
    children: Vec<usize>,
    parent: usize,
}

fn parse_tree(text: &str) -> Vec<EncNode> {
    let mut nodes = vec![EncNode {
        san: String::new(),
        children: Vec::new(),
        parent: 0,
    }];
    let mut cur = 0;
    let mut stack = Vec::new();
    for tok in text.split_whitespace() {
        match tok {
            "(" => {
                stack.push(cur);
                cur = nodes[cur].parent;
            }
            ")" => cur = stack.pop().expect("unbalanced variation"),
            t if t.ends_with('.') => {}
            san => {
                let idx = nodes.len();
                nodes.push(EncNode {
                    san: san.to_string(),
                    children: Vec::new(),
                    parent: cur,
                });
                nodes[cur].children.push(idx);
                cur = idx;
            }
        }
    }
    assert!(stack.is_empty(), "unbalanced variation");
    nodes
}

fn word(from: Square, to: Square, promo: u16) -> u16 {
    u16::from(square_to_index(from)) | (u16::from(square_to_index(to)) << 6) | (promo << 12)
}

fn promo_bits(role: Role) -> u16 {
    match role {
        Role::Queen => 0,
        Role::Rook => 1,
        Role::Bishop => 2,
        Role::Knight => 3,
        _ => panic!("not a promotion piece"),
    }
}

fn block_first(role: Role, index: usize) -> u8 {
    PIECE_BLOCKS
        .iter()
        .take(12)
        .find(|(r, i, _, _)| *r == role && *i == index)
        .map(|b| b.2)
        .expect("piece block")
}

fn compact_code(role: Role, from: Square, to: Square, color: Color, t: &Tracker) -> Option<u8> {
    let dx = u32::from(to.file()) as i32 - u32::from(from.file()) as i32;
    let dy = u32::from(to.rank()) as i32 - u32::from(from.rank()) as i32;
    match role {
        Role::King => KING_DELTAS
            .iter()
            .position(|&d| d == (dx, dy))
            .map(|i| 1 + i as u8),
        Role::Pawn => {
            let slot = t.index_of(Role::Pawn, from)?;
            let dir = if color.is_white() { 1 } else { -1 };
            let kind = if dx == 0 && dy == dir {
                0
            } else if dx == 0 && dy == 2 * dir {
                1
            } else if dx == dir && dy == dir {
                2
            } else if dx == -dir && dy == dir {
                3
            } else {
                return None;
            };
            Some(PAWN_FIRST_CODE + slot as u8 * 4 + kind)
        }
        Role::Knight => {
            let idx = t.index_of(Role::Knight, from)?;
            if idx >= 3 {
                return None;
            }
            let rel = KNIGHT_DELTAS.iter().position(|&d| d == (dx, dy))? as u8;
            Some(block_first(Role::Knight, idx) + rel)
        }
        Role::Queen | Role::Rook | Role::Bishop => {
            let idx = t.index_of(role, from)?;
            if idx >= 3 {
                return None;
            }
            let mx = dx.rem_euclid(8) as u8;
            let my = dy.rem_euclid(8) as u8;
            let rel = match role {
                Role::Queen => {
                    if mx == 0 {
                        my - 1
                    } else if my == 0 {
                        7 + mx - 1
                    } else if mx == my {
                        14 + mx - 1
                    } else if (mx + my).is_multiple_of(8) {
                        21 + mx - 1
                    } else {
                        return None;
                    }
                }
                Role::Rook => {
                    if mx == 0 {
                        my - 1
                    } else if my == 0 {
                        7 + mx - 1
                    } else {
                        return None;
                    }
                }
                _ => {
                    if mx == my {
                        mx - 1
                    } else if (mx + my).is_multiple_of(8) {
                        7 + mx - 1
                    } else {
                        return None;
                    }
                }
            };
            Some(block_first(role, idx) + rel)
        }
    }
}

fn encode_move(
    san: &str,
    pos: &Chess,
    trackers: &[Tracker; 2],
    mode: CastlingMode,
) -> (Ev, Chess, [Tracker; 2]) {
    let color = pos.turn();
    if san == "--" {
        return (
            Ev::Move {
                code: Some(0),
                word: 0,
            },
            play_null(pos, mode).unwrap(),
            trackers.clone(),
        );
    }
    let m = San::from_ascii(san.as_bytes())
        .unwrap_or_else(|e| panic!("{san}: {e}"))
        .to_move(pos)
        .unwrap_or_else(|e| panic!("{san}: {e}"));
    let me = if color.is_white() {
        &trackers[0]
    } else {
        &trackers[1]
    };
    let ev = match &m {
        Move::Castle { king, rook } => {
            let side = CastlingSide::from_king_side(rook.file() > king.file());
            if mode == CastlingMode::Chess960 {
                let to = side.king_to(color);
                Ev::Move {
                    code: None,
                    word: word(to, to, 0),
                }
            } else {
                Ev::Move {
                    code: Some(if side.is_king_side() { 9 } else { 10 }),
                    word: word(*king, side.king_to(color), 0),
                }
            }
        }
        Move::Normal {
            role,
            from,
            to,
            promotion,
            ..
        } => {
            let w = word(*from, *to, promotion.map(promo_bits).unwrap_or(0));
            let code = if promotion.is_some() {
                None
            } else {
                compact_code(*role, *from, *to, color, me)
            };
            Ev::Move { code, word: w }
        }
        Move::EnPassant { from, to } => Ev::Move {
            code: compact_code(Role::Pawn, *from, *to, color, me),
            word: word(*from, *to, 0),
        },
        Move::Put { .. } => unreachable!(),
    };
    let mut next = pos.clone();
    next.play_unchecked(&m);
    let mut t = trackers.clone();
    let [w, b] = &mut t;
    let (mine, other) = if color.is_white() { (w, b) } else { (b, w) };
    Tracker::apply(mine, other, color, &m);
    (ev, next, t)
}

fn emit(
    nodes: &[EncNode],
    idx: usize,
    pos: &Chess,
    trackers: &[Tracker; 2],
    mode: CastlingMode,
    events: &mut Vec<Ev>,
) {
    let kids = &nodes[idx].children;
    if kids.is_empty() {
        events.push(Ev::Pop);
        return;
    }
    for (i, &k) in kids.iter().enumerate() {
        if i + 1 < kids.len() {
            events.push(Ev::Push);
        }
        let (ev, next, t) = encode_move(&nodes[k].san, pos, trackers, mode);
        events.push(ev);
        emit(nodes, k, &next, &t, mode, events);
    }
}

fn translate_inverse(mode: u8, value: u8, n: u32) -> u8 {
    let n = (n & 0xff) as u8;
    let table: &[u8; 256] = match mode {
        0 => &tables::MODE_0,
        4 => &tables::MODE_4,
        5 => &tables::MODE_5,
        10 => &tables::MODE_10,
        m => panic!("no table for mode {m}"),
    };
    let inv = |v: u8| table.iter().position(|&x| x == v).unwrap() as u8;
    match mode {
        0 => inv(value).wrapping_add(n),
        _ => inv(value.wrapping_add(n)),
    }
}

fn serialize_compact(mode: u8, events: &[Ev]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut n = 0u32;
    for ev in events {
        match *ev {
            Ev::Push => out.push(translate_inverse(mode, CODE_VARIATION_START, n)),
            Ev::Pop => out.push(translate_inverse(mode, CODE_VARIATION_END, n)),
            Ev::Move { code: Some(c), .. } => {
                out.push(translate_inverse(mode, c, n));
                n += 1;
            }
            Ev::Move { code: None, word } => {
                out.push(translate_inverse(mode, CODE_TWO_BYTE, n));
                out.push(translate_inverse(mode, (word >> 8) as u8, n));
                out.push(translate_inverse(mode, word as u8, n));
                n += 1;
            }
        }
    }
    out
}

fn serialize_simple(mode: u8, events: &[Ev]) -> Vec<u8> {
    let mut words: Vec<u16> = Vec::new();
    let mut pending = false;
    for ev in events {
        match *ev {
            Ev::Push => pending = true,
            Ev::Pop => {
                if let Some(last) = words.last_mut() {
                    *last |= 0x4000;
                }
            }
            Ev::Move { word, .. } => {
                words.push(word | if pending { 0x8000 } else { 0 });
                pending = false;
            }
        }
    }
    let mut out = Vec::new();
    for (n, w) in words.iter().enumerate() {
        out.push(translate_inverse(mode, (w >> 8) as u8, n as u32));
        out.push(translate_inverse(mode, *w as u8, n as u32));
    }
    out
}

/// The `.cbg` record of a game: flags, size and payload.
fn moves_record(game: &TestGame) -> Vec<u8> {
    let chess960 = game.mode == 10;
    let castling_mode = if chess960 {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };
    let (pos, setup) = match &game.fen {
        Some(fen) => {
            let setup = Fen::from_ascii(fen.as_bytes()).unwrap().into_setup();
            let pos = position_from_setup(setup, castling_mode).unwrap();
            (pos, true)
        }
        None if chess960 => (
            Chess::from_setup(shakmaty::Setup::default(), castling_mode).unwrap(),
            true,
        ),
        None => (Chess::default(), false),
    };
    let mut payload = Vec::new();
    if setup {
        payload.extend(encode_setup(&pos, chess960));
    }
    let nodes = parse_tree(&game.moves);
    let trackers = [
        Tracker::from_board(pos.board(), Color::White),
        Tracker::from_board(pos.board(), Color::Black),
    ];
    let mut events = Vec::new();
    emit(&nodes, 0, &pos, &trackers, castling_mode, &mut events);
    let stream = match game.mode {
        5 => serialize_simple(game.mode, &events),
        _ => serialize_compact(game.mode, &events),
    };
    payload.extend(stream);
    let mut out = vec![game.mode | if setup { 0x40 } else { 0 }];
    let size = (payload.len() + 4) as u32;
    out.extend_from_slice(&size.to_be_bytes()[1..]);
    out.extend(payload);
    out
}

/// A guiding text record: version 3, no titles, no contents.
fn text_record() -> Vec<u8> {
    let payload = [3u8, 0, 0, 0, 0, 0, 0];
    let mut out = vec![0x80];
    out.extend_from_slice(&((payload.len() + 4) as u32).to_be_bytes()[1..]);
    out.extend_from_slice(&payload);
    out
}

fn annotation_record(id: u32, anns: &[(i32, u8, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (pos, kind, data) in anns {
        body.extend_from_slice(&(*pos as u32).to_be_bytes()[1..]);
        body.push(*kind);
        body.extend_from_slice(&((data.len() + 6) as u16).to_be_bytes());
        body.extend_from_slice(data);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&id.to_be_bytes()[1..]);
    out.extend_from_slice(&[0x01, 0x00, 0x0e, 0x0e]);
    out.extend_from_slice(&((anns.len() + 1) as u32).to_be_bytes()[1..]);
    out.extend_from_slice(&((body.len() + 14) as u32).to_be_bytes());
    out.extend(body);
    out
}

fn padded(s: &[u8], len: usize) -> Vec<u8> {
    assert!(s.len() <= len, "string too long for its field");
    let mut v = s.to_vec();
    v.resize(len, 0);
    v
}

struct Entities<K> {
    keys: Vec<K>,
    ids: HashMap<K, u32>,
}

impl<K: std::hash::Hash + Eq + Clone> Entities<K> {
    fn new() -> Self {
        Entities {
            keys: Vec::new(),
            ids: HashMap::new(),
        }
    }

    fn id(&mut self, key: K) -> u32 {
        if let Some(&id) = self.ids.get(&key) {
            return id;
        }
        let id = self.keys.len() as u32;
        self.keys.push(key.clone());
        self.ids.insert(key, id);
        id
    }
}

fn entity_file(records: &[Vec<u8>], data_size: usize, extra: bool) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(records.len() as i32).to_le_bytes());
    out.extend_from_slice(&(if records.is_empty() { -1i32 } else { 0 }).to_le_bytes());
    out.extend_from_slice(&1_234_567_890i32.to_le_bytes());
    out.extend_from_slice(&(data_size as i32).to_le_bytes());
    out.extend_from_slice(&(-1i32).to_le_bytes());
    out.extend_from_slice(&(records.len() as i32).to_le_bytes());
    out.extend_from_slice(&(if extra { 4i32 } else { 0 }).to_le_bytes());
    if extra {
        out.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
    }
    for (i, data) in records.iter().enumerate() {
        assert_eq!(data.len(), data_size);
        // A degenerate tree: every node is the right child of the previous one.
        out.extend_from_slice(&(-1i32).to_le_bytes());
        let right = if i + 1 < records.len() {
            (i + 1) as i32
        } else {
            -1
        };
        out.extend_from_slice(&right.to_le_bytes());
        out.push(0);
        out.extend_from_slice(data);
    }
    out
}

fn with_refs(mut data: Vec<u8>, refs: i32, first_game: i32) -> Vec<u8> {
    data.extend_from_slice(&refs.to_le_bytes());
    data.extend_from_slice(&first_game.to_le_bytes());
    data
}

fn cbg_header(size: usize) -> Vec<u8> {
    let mut h = Vec::new();
    h.extend_from_slice(&26u16.to_be_bytes());
    h.extend_from_slice(&(size as u32).to_be_bytes());
    h.extend_from_slice(&0u32.to_be_bytes());
    h.extend_from_slice(&(size as u64).to_be_bytes());
    h.extend_from_slice(&0u64.to_be_bytes());
    h
}

impl TestDb {
    /// Writes the database as `test.*` in `dir` and returns the `.cbh` path.
    pub fn write(&self, dir: &Path) -> PathBuf {
        let mut players: Entities<(Vec<u8>, Vec<u8>)> = Entities::new();
        let mut tournaments: Entities<(Vec<u8>, Vec<u8>, u32)> = Entities::new();
        let mut annotators: Entities<Vec<u8>> = Entities::new();
        let mut sources: Entities<Vec<u8>> = Entities::new();
        let mut cbh = vec![0u8; 46];
        cbh[1..3].copy_from_slice(&44u16.to_be_bytes());
        cbh[3..5].copy_from_slice(&46u16.to_be_bytes());
        cbh[5] = 1;
        let next_id = self.games.len() as u32 + 1;
        cbh[6..10].copy_from_slice(&next_id.to_be_bytes());
        cbh[0x28..0x2c].copy_from_slice(&next_id.to_be_bytes());
        let mut cbg: Vec<u8> = cbg_header(0);
        let mut cba: Vec<u8> = cbg_header(0);
        for (i, g) in self.games.iter().enumerate() {
            let id = i as u32 + 1;
            let mut rec = Vec::with_capacity(46);
            let kind =
                0x01 | if g.guiding_text { 0x02 } else { 0 } | if g.deleted { 0x80 } else { 0 };
            rec.push(kind);
            let tournament = tournaments.id((g.event.clone(), g.site.clone(), g.event_date));
            let annotator = annotators.id(g.annotator.clone());
            let source = sources.id(g.source.clone());
            if g.guiding_text {
                let offset = cbg.len() as u32;
                cbg.extend(text_record());
                rec.extend_from_slice(&offset.to_be_bytes());
                rec.extend_from_slice(&[0, 0]);
                rec.extend_from_slice(&tournament.to_be_bytes()[1..]);
                rec.extend_from_slice(&source.to_be_bytes()[1..]);
                rec.extend_from_slice(&annotator.to_be_bytes()[1..]);
                rec.push(g.round);
                rec.push(g.subround);
                rec.extend_from_slice(&0u32.to_be_bytes());
                rec.extend_from_slice(&[0u8; 24]);
            } else {
                let moves_offset = cbg.len() as u32;
                cbg.extend(moves_record(g));
                let ann_offset = if g.annotations.is_empty() {
                    0
                } else {
                    let off = cba.len() as u32;
                    cba.extend(annotation_record(id, &g.annotations));
                    off
                };
                rec.extend_from_slice(&moves_offset.to_be_bytes());
                rec.extend_from_slice(&ann_offset.to_be_bytes());
                rec.extend_from_slice(&players.id(g.white.clone()).to_be_bytes()[1..]);
                rec.extend_from_slice(&players.id(g.black.clone()).to_be_bytes()[1..]);
                rec.extend_from_slice(&tournament.to_be_bytes()[1..]);
                rec.extend_from_slice(&annotator.to_be_bytes()[1..]);
                rec.extend_from_slice(&source.to_be_bytes()[1..]);
                rec.extend_from_slice(&g.date.to_be_bytes()[1..]);
                rec.push(g.result);
                rec.push(g.line_eval);
                rec.push(g.round);
                rec.push(g.subround);
                rec.extend_from_slice(&g.white_elo.to_be_bytes());
                rec.extend_from_slice(&g.black_elo.to_be_bytes());
                rec.extend_from_slice(&g.eco.to_be_bytes());
                rec.extend_from_slice(&0u16.to_be_bytes());
                let flags = if g.fen.is_some() { 1u32 } else { 0 }
                    | if g.mode == 10 { 0x0800_0000 } else { 0 };
                rec.extend_from_slice(&flags.to_be_bytes());
                rec.extend_from_slice(&0u16.to_be_bytes());
                rec.push(0);
            }
            assert_eq!(rec.len(), 46);
            cbh.extend(rec);
        }
        let cbg_len = cbg.len();
        cbg[..26].copy_from_slice(&cbg_header(cbg_len));
        let cba_len = cba.len();
        cba[..26].copy_from_slice(&cbg_header(cba_len));

        let extra = self.extra_entity_header;
        let player_records: Vec<Vec<u8>> = players
            .keys
            .iter()
            .map(|(last, first)| {
                let mut d = padded(last, 30);
                d.extend(padded(first, 20));
                with_refs(d, 1, 1)
            })
            .collect();
        let tournament_records: Vec<Vec<u8>> = tournaments
            .keys
            .iter()
            .map(|(title, place, date)| {
                let mut d = padded(title, 40);
                d.extend(padded(place, 30));
                d.extend_from_slice(&date.to_le_bytes());
                d.extend_from_slice(&[0u8; 8]);
                with_refs(d, 1, 1)
            })
            .collect();
        let annotator_records: Vec<Vec<u8>> = annotators
            .keys
            .iter()
            .map(|name| with_refs(padded(name, 45), 1, 1))
            .collect();
        let source_records: Vec<Vec<u8>> = sources
            .keys
            .iter()
            .map(|title| {
                let mut d = padded(title, 25);
                d.extend(padded(b"", 16));
                d.extend_from_slice(&[0u8; 10]);
                with_refs(d, 1, 1)
            })
            .collect();

        let base = dir.join("test");
        std::fs::write(base.with_extension("cbh"), cbh).unwrap();
        std::fs::write(base.with_extension("cbg"), cbg).unwrap();
        std::fs::write(base.with_extension("cba"), cba).unwrap();
        std::fs::write(
            base.with_extension("cbp"),
            entity_file(&player_records, 58, extra),
        )
        .unwrap();
        std::fs::write(
            base.with_extension("cbt"),
            entity_file(&tournament_records, 90, extra),
        )
        .unwrap();
        std::fs::write(
            base.with_extension("cbc"),
            entity_file(&annotator_records, 53, extra),
        )
        .unwrap();
        std::fs::write(
            base.with_extension("cbs"),
            entity_file(&source_records, 59, extra),
        )
        .unwrap();
        base.with_extension("cbh")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_reproduces_the_spec_stream_layout() {
        // 1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4
        let nodes = parse_tree("e4 c5 ( c6 d4 ) ( Nf6 e5 ) Nf3 d6 ( Nc6 Bb5 ) d4");
        let pos = Chess::default();
        let trackers = [
            Tracker::from_board(pos.board(), Color::White),
            Tracker::from_board(pos.board(), Color::Black),
        ];
        let mut events = Vec::new();
        emit(
            &nodes,
            0,
            &pos,
            &trackers,
            CastlingMode::Standard,
            &mut events,
        );
        let shape: Vec<&str> = events
            .iter()
            .map(|e| match e {
                Ev::Push => "254",
                Ev::Pop => "255",
                Ev::Move { .. } => "m",
            })
            .collect();
        assert_eq!(
            shape.join(" "),
            "m 254 m m 254 m m 255 m m 255 254 m m 255 m m 255"
        );
        // e4 is code 128, the hand-derived bytes of the mode 0 stream.
        let bytes = serialize_compact(0, &events[..1]);
        assert_eq!(bytes, vec![0xff]);
    }

    #[test]
    fn inverse_translation_round_trips() {
        for mode in [0u8, 4, 5, 10] {
            for n in [0u32, 1, 7, 255, 256, 1000] {
                for v in [0u8, 1, 128, 235, 254, 255] {
                    let b = translate_inverse(mode, v, n);
                    assert_eq!(crate::moves::translate(mode, b, n).unwrap(), v);
                }
            }
        }
    }
}
