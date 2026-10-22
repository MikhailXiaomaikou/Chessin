//! Test-only encoder: writes small but structurally valid `.2cbh`, `.2cbg`,
//! `.2cba` and `.2lid` files so the reader can be exercised without real
//! ChessBase databases. The `.2lgd` and `.2lcd` indexes are derived data the
//! reader does not need, and are not written.
//!
//! The encoder mirrors the decoder, so a misreading of the format that is
//! symmetric on both sides would pass these tests; the anchors are the words
//! and records transcribed from real files in the unit tests of each module.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::{CastlingMode, CastlingSide, Chess, Color, EnPassantMode, Move, Position};

use super::annotations::testutil::content as annotation_content;
use super::entities::testutil::{
    deleted_record, game_tag_body, lid_file, player_body, record, source_body, team_body,
    tournament_body,
};
use super::entities::{STANDARD_CONTAINERS, TYPE_COUNT};
use super::header::{FORMAT_VERSION, RECORD_SIZE};
use super::moves::testutil::word_of;
use super::moves::{
    castling_word_for, checksum, chess960_setup, placement_word, MAGIC, SETUP_CHESS960_PREFIX,
    TAG_ANNOTATIONS, TAG_CHESS960, TAG_GAME, TAG_TEXT, WORD_ALTERNATIVE, WORD_END, WORD_MOVES,
    WORD_NULL_MOVE, WORD_SETUP,
};
use crate::moves::{play_null, position_from_setup};

/// Packs a date the way the format does.
pub fn packed_date(year: u32, month: u32, day: u32) -> u32 {
    (year << 9) | (month << 5) | day
}

/// What kind of record a game becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Game,
    GuidingText,
    Analysis,
}

/// One game to write.
#[derive(Debug, Clone)]
pub struct TestGame {
    pub white: (String, String),
    pub black: (String, String),
    pub white_elo: u16,
    pub black_elo: u16,
    pub event: String,
    pub site: String,
    pub event_date: u32,
    pub round: i16,
    pub subround: i16,
    pub board: i16,
    pub date: u32,
    pub result: u8,
    pub line_eval: u8,
    pub eco: u16,
    pub annotator: (String, String),
    pub source: String,
    pub white_team: Option<String>,
    pub black_team: Option<String>,
    /// Start position; `None` for the standard one.
    pub fen: Option<String>,
    /// The Chess960 start position number; with a `fen` the game is written
    /// as a Chess960 set-up position.
    pub chess960: Option<u16>,
    /// Moves as bare SAN tokens, `--` for a null move, `(` `)` for variations.
    /// Tokens ending in `.` (move numbers) are ignored.
    pub moves: String,
    /// `(position in PGN order, type, data)`, in ascending order of position.
    pub annotations: Vec<(i32, u16, Vec<u8>)>,
    pub kind: Kind,
    pub deleted: bool,
    /// Spare bytes after the moves.
    pub spare: u32,
}

impl Default for TestGame {
    fn default() -> Self {
        TestGame {
            white: ("White".into(), String::new()),
            black: ("Black".into(), String::new()),
            white_elo: 0,
            black_elo: 0,
            event: String::new(),
            site: String::new(),
            event_date: 0,
            round: 0,
            subround: 0,
            board: 0,
            date: 0,
            result: 3,
            line_eval: 0,
            eco: 0,
            annotator: (String::new(), String::new()),
            source: String::new(),
            white_team: None,
            black_team: None,
            fen: None,
            chess960: None,
            moves: String::new(),
            annotations: Vec::new(),
            kind: Kind::Game,
            deleted: false,
            spare: 98,
        }
    }
}

/// A database to write.
#[derive(Debug, Clone)]
pub struct TestDb {
    pub games: Vec<TestGame>,
    pub containers: [u32; TYPE_COUNT],
    /// Append a deleted player record and put it on the deleted list.
    pub deleted_player: bool,
}

impl Default for TestDb {
    fn default() -> Self {
        TestDb {
            games: Vec::new(),
            containers: STANDARD_CONTAINERS,
            deleted_player: false,
        }
    }
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

/// The word of one SAN move from `pos`, and the position after it.
fn encode_move(san: &str, pos: &Chess, mode: CastlingMode, chess960: Option<u16>) -> (u16, Chess) {
    if san == "--" {
        return (WORD_NULL_MOVE, play_null(pos, mode).unwrap());
    }
    let m = San::from_ascii(san.as_bytes())
        .unwrap_or_else(|e| panic!("{san}: {e}"))
        .to_move(pos)
        .unwrap_or_else(|e| panic!("{san}: {e}"));
    let word = match (&m, chess960) {
        (Move::Castle { king, rook }, Some(n)) => {
            let side = CastlingSide::from_king_side(rook.file() > king.file());
            castling_word_for(pos.turn(), side, Some(n))
        }
        _ => word_of(pos, &m),
    };
    let mut next = pos.clone();
    next.play_unchecked(&m);
    (word, next)
}

/// Writes the tree the way the format stores it: the main line first and in
/// full, then the alternatives, most recent branch point first.
pub fn encode_tree(
    text: &str,
    start: &Chess,
    mode: CastlingMode,
    chess960: Option<u16>,
) -> Vec<u16> {
    struct Pending {
        pos: Chess,
        alternatives: Vec<usize>,
    }
    let nodes = parse_tree(text);
    let mut out = Vec::new();
    let mut stack: Vec<Pending> = Vec::new();
    let mut cur = 0usize;
    let mut pos = start.clone();
    loop {
        loop {
            let kids = &nodes[cur].children;
            let Some(&main) = kids.first() else {
                break;
            };
            let (w, next) = encode_move(&nodes[main].san, &pos, mode, chess960);
            out.push(w);
            if kids.len() > 1 {
                out.push(WORD_ALTERNATIVE);
                stack.push(Pending {
                    pos: pos.clone(),
                    alternatives: kids[1..].to_vec(),
                });
            }
            cur = main;
            pos = next;
        }
        out.push(WORD_END);
        let Some(pending) = stack.pop() else {
            break;
        };
        let alt = pending.alternatives[0];
        let (w, next) = encode_move(&nodes[alt].san, &pending.pos, mode, chess960);
        out.push(w);
        if pending.alternatives.len() > 1 {
            out.push(WORD_ALTERNATIVE);
            stack.push(Pending {
                pos: pending.pos,
                alternatives: pending.alternatives[1..].to_vec(),
            });
        }
        cur = alt;
        pos = next;
    }
    out
}

/// The words of a set-up position section (after `fffb`).
fn setup_words(pos: &Chess, chess960: bool) -> Vec<u16> {
    let setup = pos.clone().into_setup(EnPassantMode::Legal);
    let mut out = Vec::new();
    if chess960 {
        out.push(SETUP_CHESS960_PREFIX);
    }
    out.push(setup.fullmoves.get().min(u16::MAX as u32) as u16);
    let ep = setup
        .ep_square
        .map(|s| u16::from(s.file()) + 1)
        .unwrap_or(0);
    out.push((ep << 8) | if setup.turn.is_white() { 0 } else { 1 });
    let mut castling = 0u16;
    for (bit, color, side) in [
        (1, Color::White, CastlingSide::QueenSide),
        (2, Color::White, CastlingSide::KingSide),
        (4, Color::Black, CastlingSide::QueenSide),
        (8, Color::Black, CastlingSide::KingSide),
    ] {
        if pos.castles().has(color, side) {
            castling |= bit;
        }
    }
    out.push(castling);
    for sq in shakmaty::Square::ALL {
        if let Some(piece) = setup.board.piece_at(sq) {
            out.push(placement_word(piece, sq));
        }
    }
    out
}

/// A framed `.2cbg`/`.2cba` record.
pub fn framed(tag: u16, content: &[u8], spare: u32) -> Vec<u8> {
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&(content.len() as i32).to_le_bytes());
    out.extend_from_slice(&(spare as i32).to_le_bytes());
    out.extend_from_slice(&checksum(content).to_be_bytes());
    out.extend_from_slice(&tag.to_le_bytes());
    out.extend_from_slice(content);
    out.extend(std::iter::repeat_n(0u8, spare as usize));
    out.extend_from_slice(&((content.len() + spare as usize + 34) as i64).to_le_bytes());
    out
}

fn words_bytes(words: &[u16]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

/// The moves record of a game: tag and content words.
fn moves_record(game: &TestGame) -> (u16, Vec<u16>) {
    let mode = if game.chess960.is_some() {
        CastlingMode::Chess960
    } else {
        CastlingMode::Standard
    };
    let mut words = Vec::new();
    let start = match (&game.fen, game.chess960) {
        (Some(fen), c960) => {
            let setup = Fen::from_ascii(fen.as_bytes()).unwrap().into_setup();
            let pos = position_from_setup(setup, mode).unwrap();
            words.push(WORD_SETUP);
            words.extend(setup_words(&pos, c960.is_some()));
            pos
        }
        (None, Some(n)) => {
            let pos = position_from_setup(chess960_setup(n).unwrap(), mode).unwrap();
            words.extend([WORD_SETUP, n]);
            pos
        }
        (None, None) => Chess::default(),
    };
    words.push(WORD_MOVES);
    words.extend(encode_tree(&game.moves, &start, mode, game.chess960));
    let tag = if game.chess960.is_some() {
        TAG_CHESS960
    } else {
        TAG_GAME
    };
    (tag, words)
}

/// A guiding text body: version 5, no languages.
fn text_content() -> Vec<u8> {
    let mut c = vec![5u8, 0];
    c.extend_from_slice(&4i32.to_le_bytes());
    c.extend_from_slice(&0i32.to_le_bytes());
    c
}

fn stream_header(size: u64, version: u8) -> Vec<u8> {
    let mut h = size.to_le_bytes().to_vec();
    h.extend_from_slice(&12i16.to_le_bytes());
    h.push(0);
    h.push(version);
    h
}

struct Entities<K> {
    keys: Vec<K>,
    ids: HashMap<K, i64>,
}

impl<K: std::hash::Hash + Eq + Clone> Entities<K> {
    fn new() -> Self {
        Entities {
            keys: Vec::new(),
            ids: HashMap::new(),
        }
    }

    fn id(&mut self, key: K) -> i64 {
        if let Some(&id) = self.ids.get(&key) {
            return id;
        }
        let id = self.keys.len() as i64;
        self.keys.push(key.clone());
        self.ids.insert(key, id);
        id
    }
}

fn put_i64(rec: &mut [u8], off: usize, v: i64) {
    rec[off..off + 8].copy_from_slice(&v.to_le_bytes());
}

fn put_i16(rec: &mut [u8], off: usize, v: i16) {
    rec[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

impl TestDb {
    /// Writes the database as `test.*` in `dir` and returns the `.2cbh` path.
    pub fn write(&self, dir: &Path) -> PathBuf {
        let mut players: Entities<(String, String)> = Entities::new();
        let mut tournaments: Entities<(String, String, u32)> = Entities::new();
        let mut sources: Entities<String> = Entities::new();
        let mut teams: Entities<String> = Entities::new();
        let mut cbh = vec![0u8; RECORD_SIZE];
        cbh[0x08..0x0a].copy_from_slice(&38u16.to_le_bytes());
        cbh[0x0a..0x0c].copy_from_slice(&(RECORD_SIZE as u16).to_le_bytes());
        cbh[0x0d] = FORMAT_VERSION;
        cbh[0x10..0x14].copy_from_slice(&(self.games.len() as u32 + 1).to_le_bytes());
        let version = if self.games.is_empty() { 0 } else { 5 };
        let mut cbg = stream_header(0, version);
        let mut cba = stream_header(0, 0);
        for (i, g) in self.games.iter().enumerate() {
            let _id = i as u32 + 1;
            let mut rec = vec![0u8; RECORD_SIZE];
            rec[0] = 0x01
                | if g.kind == Kind::GuidingText { 0x02 } else { 0 }
                | if g.deleted { 0x80 } else { 0 };
            rec[2] = if g.kind == Kind::Analysis { 2 } else { 1 };
            rec[3] = rec[0] & 0x7f;
            let tournament = tournaments.id((g.event.clone(), g.site.clone(), g.event_date));
            let annotator = players.id(g.annotator.clone());
            let source = sources.id(g.source.clone());
            match g.kind {
                Kind::GuidingText => {
                    put_i64(&mut rec, 0x08, cbg.len() as i64);
                    cbg.extend(framed(TAG_TEXT, &text_content(), 193));
                    put_i64(&mut rec, 0x10, tournament);
                    put_i64(&mut rec, 0x18, source);
                    put_i64(&mut rec, 0x20, annotator);
                    put_i64(&mut rec, 0x28, 0);
                    put_i64(&mut rec, 0x38, -1);
                    put_i64(&mut rec, 0x40, 1);
                }
                Kind::Game | Kind::Analysis => {
                    let (tag, words) = moves_record(g);
                    put_i64(&mut rec, 0x08, cbg.len() as i64);
                    cbg.extend(framed(tag, &words_bytes(&words), g.spare));
                    put_i64(&mut rec, 0x10, cba.len() as i64);
                    cba.extend(framed(
                        TAG_ANNOTATIONS,
                        &annotation_content(&g.annotations),
                        g.spare,
                    ));
                    if g.kind == Kind::Analysis {
                        put_i64(&mut rec, 0x18, 0);
                        put_i64(&mut rec, 0x20, source);
                        put_i64(&mut rec, 0x28, annotator);
                        put_i64(&mut rec, 0x38, 776);
                    } else {
                        put_i64(&mut rec, 0x18, players.id(g.white.clone()));
                        put_i64(&mut rec, 0x20, players.id(g.black.clone()));
                        put_i64(&mut rec, 0x28, tournament);
                        put_i64(&mut rec, 0x30, annotator);
                        put_i64(&mut rec, 0x38, source);
                        let team = |teams: &mut Entities<String>, t: &Option<String>| {
                            t.as_ref().map(|t| teams.id(t.clone())).unwrap_or(-1)
                        };
                        put_i64(&mut rec, 0x40, team(&mut teams, &g.white_team));
                        put_i64(&mut rec, 0x48, team(&mut teams, &g.black_team));
                        put_i64(&mut rec, 0x50, 0);
                        rec[0x58] = g.result;
                        rec[0x59] = g.line_eval;
                        put_i16(&mut rec, 0x5a, g.round);
                        put_i16(&mut rec, 0x5c, g.subround);
                        put_i16(&mut rec, 0x5e, g.board);
                        rec[0x60..0x62].copy_from_slice(&g.white_elo.to_le_bytes());
                        if g.white_elo > 0 {
                            rec[0x62..0x64].copy_from_slice(&1u16.to_le_bytes());
                            rec[0x64..0x66].copy_from_slice(&1u16.to_le_bytes());
                            rec[0x68..0x6c].copy_from_slice(b"FIDE");
                        }
                        rec[0x70..0x72].copy_from_slice(&g.black_elo.to_le_bytes());
                        let eco = match (g.eco, g.chess960) {
                            (0, Some(n)) => 64576 + n,
                            (eco, _) => eco,
                        };
                        rec[0x80..0x82].copy_from_slice(&eco.to_le_bytes());
                        let flags = if g.fen.is_some() { 1u32 } else { 0 }
                            | if g.chess960.is_some() { 0x0800_0000 } else { 0 }
                            | if g.moves.contains('(') { 2 } else { 0 };
                        rec[0x84..0x88].copy_from_slice(&flags.to_le_bytes());
                        let plies = g
                            .moves
                            .split_whitespace()
                            .filter(|t| !t.ends_with('.') && *t != "(" && *t != ")")
                            .count();
                        put_i16(&mut rec, 0x8a, plies.div_ceil(2) as i16);
                        rec[0xb8..0xbc].copy_from_slice(&1i32.to_le_bytes());
                        rec[0xbc..0xc0].copy_from_slice(&g.date.to_le_bytes());
                    }
                }
            }
            cbh.extend(rec);
        }
        let cbg_len = cbg.len() as u64;
        cbg[..8].copy_from_slice(&cbg_len.to_le_bytes());
        let cba_len = cba.len() as u64;
        cba[..8].copy_from_slice(&cba_len.to_le_bytes());

        let mut player_records: Vec<Vec<u8>> = players
            .keys
            .iter()
            .map(|(last, first)| record(&player_body(last.as_bytes(), first.as_bytes())))
            .collect();
        let mut first_deleted = [-1i64; TYPE_COUNT];
        if self.deleted_player {
            first_deleted[0] = player_records.len() as i64;
            player_records.push(deleted_record(-1));
        }
        let tournament_records: Vec<Vec<u8>> = tournaments
            .keys
            .iter()
            .map(|(title, place, date)| {
                record(&tournament_body(
                    title.as_bytes(),
                    place.as_bytes(),
                    *date,
                    0,
                    0,
                ))
            })
            .collect();
        let source_records: Vec<Vec<u8>> = sources
            .keys
            .iter()
            .map(|title| record(&source_body(title.as_bytes(), b"", 0)))
            .collect();
        let team_records: Vec<Vec<u8>> = teams
            .keys
            .iter()
            .map(|title| record(&team_body(title.as_bytes(), 0, 0, 0)))
            .collect();
        let tag_records = vec![record(&game_tag_body(&[]))];
        let lid = lid_file(
            &self.containers,
            &[
                player_records,
                tournament_records,
                source_records,
                Vec::new(),
                team_records,
                tag_records,
            ],
            &first_deleted,
        );

        let base = dir.join("test");
        std::fs::write(base.with_extension("2cbh"), cbh).unwrap();
        std::fs::write(base.with_extension("2cbg"), cbg).unwrap();
        std::fs::write(base.with_extension("2cba"), cba).unwrap();
        std::fs::write(base.with_extension("2lid"), lid).unwrap();
        base.with_extension("2cbh")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::twocbh::moves::testutil::words_of;

    #[test]
    fn encoder_writes_the_spec_example_stream() {
        // 1.e4 c5 (1...c6 2.d4) (1...Nf6 2.e5) 2.Nf3 d6 (2...Nc6 3.Bb5) 3.d4
        let words = encode_tree(
            "e4 c5 ( c6 d4 ) ( Nf6 e5 ) Nf3 d6 ( Nc6 Bb5 ) d4",
            &Chess::default(),
            CastlingMode::Standard,
            None,
        );
        let start = Chess::default();
        let (main, _) = words_of(&start, "e4 c5 Nf3 d6 d4");
        let (_, after_nf3) = words_of(&start, "e4 c5 Nf3");
        let (nc6, _) = words_of(&after_nf3, "Nc6 Bb5");
        let (_, after_e4) = words_of(&start, "e4");
        let (c6, _) = words_of(&after_e4, "c6 d4");
        let (nf6, _) = words_of(&after_e4, "Nf6 e5");
        assert_eq!(
            words,
            vec![
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
            ]
        );
        // The words transcribed from a real record.
        let (real, _) = words_of(&start, "d4 d5 c4 c6 e3");
        assert_eq!(real, vec![0xace1, 0xafcf, 0xac83, 0xaf72, 0xad40]);
        assert_eq!(
            encode_tree("", &start, CastlingMode::Standard, None),
            vec![WORD_END]
        );
    }

    #[test]
    fn framing_round_trips_through_the_head_parser() {
        let rec = framed(TAG_GAME, &[0xfc, 0xff, 0xff, 0xff], 98);
        assert_eq!(rec.len(), 4 + 98 + 34);
        let head = crate::twocbh::moves::parse_record_head(&rec).unwrap();
        assert_eq!(head.content_size, 4);
        assert_eq!(head.spare_size, 98);
        assert_eq!(head.tag, TAG_GAME);
        assert_eq!(head.checksum, checksum(&[0xfc, 0xff, 0xff, 0xff]));
        assert_eq!(&rec[rec.len() - 8..], &136i64.to_le_bytes());
        let empty = framed(TAG_ANNOTATIONS, &[0xff, 0xff, 0xff, 0x7f], 0);
        assert_eq!(&empty[16..24], &[0, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]);
    }
}
