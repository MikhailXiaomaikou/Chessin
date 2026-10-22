//! `.2cbh`: the 192-byte file header and the 192-byte records (little-endian).
//!
//! Layout per the public 2CBH format description (Morphy `format/v2/1-game-headers.md`):
//! the file header carries the record size at 0x0a, the format version 5 at
//! 0x0d and the next game id at 0x10; record *n* (1-based) starts at `192 · n`.
//! A record is a game, a guiding text or an analysis; the first eight bytes
//! are common to all three.

use crate::bytes::Reader;
use crate::header::{decode_eco, CbDate, EcoField, GameResult};
use crate::text::TextDecoder;

/// Size of the `.2cbh` file header; the same as a record.
pub const RECORD_SIZE: usize = 192;
/// The format version byte found in every 2CBH database.
pub const FORMAT_VERSION: u8 = 5;
/// Size of the rating-type block that follows each Elo.
pub const RATING_TYPE_SIZE: usize = 14;

/// Fields of the `.2cbh` file header that a reader needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHeader {
    pub record_size: u16,
    pub format_version: u8,
    /// Id of the next game to be added: the record count plus one.
    pub next_game_id: u32,
}

/// Parses the first 192 bytes of a `.2cbh` file.
pub fn parse_file_header(buf: &[u8]) -> Result<FileHeader, String> {
    if buf.len() < RECORD_SIZE {
        return Err(format!(
            ".2cbh file is too short for a header ({} bytes)",
            buf.len()
        ));
    }
    let record_size = u16::from_le_bytes([buf[0x0a], buf[0x0b]]);
    let format_version = buf[0x0d];
    let next_game_id = u32::from_le_bytes([buf[0x10], buf[0x11], buf[0x12], buf[0x13]]);
    if record_size != RECORD_SIZE as u16 {
        return Err(format!(
            "unexpected .2cbh record size {record_size} (expected 192); not a 2CBH database?"
        ));
    }
    if format_version != FORMAT_VERSION {
        return Err(format!(
            "unsupported .2cbh format version {format_version} (only version 5 is supported)"
        ));
    }
    Ok(FileHeader {
        record_size,
        format_version,
        next_game_id,
    })
}

/// What a record holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind {
    Game,
    GuidingText,
    Analysis,
}

/// The eight bytes every record begins with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordHead {
    pub kind: RecordKind,
    pub deleted: bool,
}

/// Classifies a record from its first bytes: the type byte at 0x00 (bit 0
/// always set, bit 1 guiding text, bit 7 deleted) and the kind byte at 0x02
/// (1 game or text, 2 analysis).
pub fn parse_record_head(buf: &[u8]) -> Result<RecordHead, String> {
    if buf.len() < RECORD_SIZE {
        return Err(format!("truncated .2cbh record ({} bytes)", buf.len()));
    }
    let type_byte = buf[0];
    if type_byte & 0x01 == 0 {
        return Err(format!(
            "record type byte {type_byte:#04x} has bit 0 clear; not a record"
        ));
    }
    let deleted = type_byte & 0x80 != 0;
    let kind = match (buf[2], type_byte & 0x02 != 0) {
        (1, false) => RecordKind::Game,
        (1, true) => RecordKind::GuidingText,
        (2, _) => RecordKind::Analysis,
        (other, _) => return Err(format!("unknown record kind {other}")),
    };
    Ok(RecordHead { kind, deleted })
}

/// The 14 bytes after an Elo: which rating it is.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RatingType {
    /// 1 international, 2 national, 3 server; 0 when the field is blank.
    pub kind: u8,
    /// 0 normal, 1 bullet, 2 blitz, 3 rapid, 4 correspondence (5 is rapid on
    /// the ChessBase server).
    pub time_control: u8,
    /// The rating list: 1-4 FIDE/ICCF, 5-8 ChessBase server, 10-13 chess.com,
    /// 14-17 LiChess, 100 national.
    pub list: i16,
    pub nation: i16,
    /// `FIDE`, `ICCF`, `CB`, `chess.co`, `LiChess` or empty.
    pub name: String,
}

impl RatingType {
    pub fn parse(buf: &[u8], dec: &TextDecoder) -> Option<RatingType> {
        let mut r = Reader::new(buf.get(..RATING_TYPE_SIZE)?);
        let kind_and_tc = r.le_u16()?;
        let list = r.le_i16()?;
        let nation = r.le_i16()?;
        let name = dec.decode_field(r.take(8)?);
        Some(RatingType {
            kind: (kind_and_tc & 7) as u8,
            time_control: (kind_and_tc >> 3) as u8,
            list,
            nation,
            name,
        })
    }
}

/// One 192-byte game record, decoded. Entity ids are 0-based; the teams are
/// −1 when there is none, every other reference points at an entity (possibly
/// a placeholder with empty text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameRecord {
    pub deleted: bool,
    pub moves_offset: u64,
    pub annotations_offset: u64,
    pub white: i64,
    pub black: i64,
    pub tournament: i64,
    /// A player entity.
    pub annotator: i64,
    pub source: i64,
    pub white_team: i64,
    pub black_team: i64,
    pub game_tag: i64,
    pub result: GameResult,
    pub line_evaluation: u8,
    pub round: i16,
    pub subround: i16,
    pub board: i16,
    pub white_elo: u16,
    pub white_rating: RatingType,
    pub black_elo: u16,
    pub black_rating: RatingType,
    pub eco: EcoField,
    pub medals: u16,
    pub flags: u32,
    pub magnitudes: u16,
    /// Full moves in the main line.
    pub move_count: i16,
    /// Final material of the two sides, the greater first (not white/black).
    pub final_material: (u32, u32),
    pub created: i64,
    pub last_changed: i64,
    pub version: i32,
    pub date: CbDate,
}

impl GameRecord {
    pub const FLAG_SETUP_POSITION: u32 = 0x0000_0001;
    pub const FLAG_CHESS960: u32 = 0x0800_0000;
}

/// Parses a record already known to be a game (see [`parse_record_head`]).
pub fn parse_game_record(buf: &[u8], dec: &TextDecoder) -> Result<GameRecord, String> {
    let head = parse_record_head(buf)?;
    if head.kind != RecordKind::Game {
        return Err(format!("record is a {:?}, not a game", head.kind));
    }
    let mut r = Reader::new(buf);
    let _common = r.take(8);
    let field = |v: Option<i64>| v.unwrap_or(0);
    let moves_offset = r.le_u64().unwrap_or(0);
    let annotations_offset = r.le_u64().unwrap_or(0);
    let white = field(r.le_i64());
    let black = field(r.le_i64());
    let tournament = field(r.le_i64());
    let annotator = field(r.le_i64());
    let source = field(r.le_i64());
    let white_team = r.le_i64().unwrap_or(-1);
    let black_team = r.le_i64().unwrap_or(-1);
    let game_tag = field(r.le_i64());
    let result = GameResult::from_byte(r.u8().unwrap_or(3));
    let line_evaluation = r.u8().unwrap_or(0);
    let round = r.le_i16().unwrap_or(0);
    let subround = r.le_i16().unwrap_or(0);
    let board = r.le_i16().unwrap_or(0);
    let white_elo = r.le_u16().unwrap_or(0);
    let white_rating = r
        .take(RATING_TYPE_SIZE)
        .and_then(|b| RatingType::parse(b, dec))
        .unwrap_or_default();
    let black_elo = r.le_u16().unwrap_or(0);
    let black_rating = r
        .take(RATING_TYPE_SIZE)
        .and_then(|b| RatingType::parse(b, dec))
        .unwrap_or_default();
    let eco = decode_eco(r.le_u16().unwrap_or(0));
    let medals = r.le_u16().unwrap_or(0);
    let flags = r.le_u32().unwrap_or(0);
    let magnitudes = r.le_u16().unwrap_or(0);
    let move_count = r.le_i16().unwrap_or(0);
    let greater = r.le_u32().unwrap_or(0);
    let lesser = r.le_u32().unwrap_or(0);
    let _unknown = r.take(4);
    let created = r.le_i64().unwrap_or(0);
    let last_changed = r.le_i64().unwrap_or(0);
    let _endgames = r.take(6);
    let _unknown = r.take(2);
    let _classification = r.take(6);
    let _unknown = r.take(2);
    let version = r.le_i32().unwrap_or(0);
    let date = CbDate::from_packed(r.le_u32().unwrap_or(0));
    Ok(GameRecord {
        deleted: head.deleted,
        moves_offset,
        annotations_offset,
        white,
        black,
        tournament,
        annotator,
        source,
        white_team,
        black_team,
        game_tag,
        result,
        line_evaluation,
        round,
        subround,
        board,
        white_elo,
        white_rating,
        black_elo,
        black_rating,
        eco,
        medals,
        flags,
        magnitudes,
        move_count,
        final_material: (greater, lesser),
        created,
        last_changed,
        version,
        date,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valid file header announcing `games` games.
    pub(crate) fn file_header(games: u32) -> [u8; RECORD_SIZE] {
        let mut h = [0u8; RECORD_SIZE];
        h[0x08..0x0a].copy_from_slice(&38u16.to_le_bytes());
        h[0x0a..0x0c].copy_from_slice(&(RECORD_SIZE as u16).to_le_bytes());
        h[0x0d] = FORMAT_VERSION;
        h[0x10..0x14].copy_from_slice(&(games + 1).to_le_bytes());
        h
    }

    /// Record 1 of a database ChessBase converted from the CBH version of the
    /// same games: Zukertort - Steinitz, World Championship 1886, game 1.
    /// Transcribed from the file, not generated by the encoder.
    pub(crate) const REAL_RECORD_1: [u8; RECORD_SIZE] = {
        let mut r = [0u8; RECORD_SIZE];
        let bytes: [(usize, &[u8]); 12] = [
            (0x00, &[0x01, 0x00, 0x01, 0x01]),
            (0x08, &[0x0c]),
            (0x10, &[0x0c]),
            (0x20, &[0x01]),
            (0x30, &[0x02]),
            (0x40, &[0xff; 16]),
            (0x5a, &[0x01]),
            (
                0x80,
                &[
                    0x00, 0x9c, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x2e, 0x00,
                ],
            ),
            (0x8c, &[0x09, 0x52, 0x00, 0x00, 0x42, 0x30, 0x00, 0x00]),
            (0x98, &[0x63, 0xa3, 0x86, 0xf6, 0x3e, 0x00, 0x00, 0x00]),
            (0xa0, &[0xe6, 0x02, 0x42, 0xbe, 0x73, 0xb4, 0xf1, 0x01]),
            (
                0xb0,
                &[
                    0x5a, 0x74, 0x00, 0xc0, 0x90, 0x06, 0x00, 0x00, 0x7a, 0x03, 0x01, 0x00, 0x2b,
                    0xbc, 0x0e, 0x00,
                ],
            ),
        ];
        let mut i = 0;
        while i < bytes.len() {
            let (off, src) = bytes[i];
            let mut j = 0;
            while j < src.len() {
                r[off + j] = src[j];
                j += 1;
            }
            i += 1;
        }
        r
    };

    #[test]
    fn file_header_checks_record_size_and_version() {
        let h = file_header(1038);
        let parsed = parse_file_header(&h).unwrap();
        assert_eq!(parsed.record_size, 192);
        assert_eq!(parsed.format_version, 5);
        assert_eq!(parsed.next_game_id, 1039);
        let mut bad = h;
        bad[0x0d] = 1;
        assert!(parse_file_header(&bad).unwrap_err().contains("version 1"));
        let mut bad = h;
        bad[0x0a] = 46;
        assert!(parse_file_header(&bad)
            .unwrap_err()
            .contains("record size 46"));
        assert!(parse_file_header(&h[..100]).is_err());
    }

    #[test]
    fn record_heads_tell_games_texts_analyses_and_deleted_apart() {
        let mut rec = [0u8; RECORD_SIZE];
        rec[0] = 0x01;
        rec[2] = 1;
        assert_eq!(
            parse_record_head(&rec).unwrap(),
            RecordHead {
                kind: RecordKind::Game,
                deleted: false
            }
        );
        rec[0] = 0x81;
        assert!(parse_record_head(&rec).unwrap().deleted);
        rec[0] = 0x03;
        assert_eq!(
            parse_record_head(&rec).unwrap().kind,
            RecordKind::GuidingText
        );
        rec[0] = 0x01;
        rec[2] = 2;
        assert_eq!(parse_record_head(&rec).unwrap().kind, RecordKind::Analysis);
        rec[2] = 3;
        assert!(parse_record_head(&rec).unwrap_err().contains("kind 3"));
        rec[0] = 0x00;
        rec[2] = 1;
        assert!(parse_record_head(&rec).unwrap_err().contains("bit 0"));
        assert!(parse_game_record(&rec[..10], &TextDecoder::default()).is_err());
    }

    #[test]
    fn real_record_decodes_to_the_1886_game() {
        let dec = TextDecoder::default();
        let g = parse_game_record(&REAL_RECORD_1, &dec).unwrap();
        assert!(!g.deleted);
        assert_eq!(g.moves_offset, 12);
        assert_eq!(g.annotations_offset, 12);
        assert_eq!((g.white, g.black), (0, 1));
        assert_eq!(g.tournament, 0);
        assert_eq!(g.annotator, 2);
        assert_eq!(g.source, 0);
        assert_eq!((g.white_team, g.black_team), (-1, -1));
        assert_eq!(g.game_tag, 0);
        assert_eq!(g.result, GameResult::BlackWins);
        assert_eq!(g.line_evaluation, 0);
        assert_eq!((g.round, g.subround, g.board), (1, 0, 0));
        assert_eq!((g.white_elo, g.black_elo), (0, 0));
        assert_eq!(g.white_rating, RatingType::default());
        assert_eq!(
            g.eco,
            EcoField::Eco {
                code: "D11".into(),
                sub: 0
            }
        );
        assert_eq!(g.medals, 0);
        assert_eq!(g.flags, 0x0e, "variations, commentary, symbols");
        assert_eq!(g.magnitudes, 0x0d);
        assert_eq!(g.move_count, 46);
        assert_eq!(g.final_material, (0x5209, 0x3042));
        assert_eq!(g.created, 0x3e_f686_a363);
        assert_eq!(g.last_changed, 0x01f1_b473_be42_02e6);
        assert_eq!(g.version, 0x0001_037a);
        assert_eq!(g.date.to_pgn(), "1886.01.11");
    }

    #[test]
    fn rating_type_unpacks_kind_time_control_and_name() {
        let dec = TextDecoder::default();
        let mut b = [0u8; 14];
        // server (3) at blitz (2 << 3), list 7, nation 196, "CB"
        b[0..2].copy_from_slice(&(3u16 | (2 << 3)).to_le_bytes());
        b[2..4].copy_from_slice(&7i16.to_le_bytes());
        b[4..6].copy_from_slice(&196i16.to_le_bytes());
        b[6..8].copy_from_slice(b"CB");
        let rt = RatingType::parse(&b, &dec).unwrap();
        assert_eq!(rt.kind, 3);
        assert_eq!(rt.time_control, 2);
        assert_eq!(rt.list, 7);
        assert_eq!(rt.nation, 196);
        assert_eq!(rt.name, "CB");
        // A name that fills the field has no terminator.
        b[6..14].copy_from_slice(b"chess.co");
        assert_eq!(RatingType::parse(&b, &dec).unwrap().name, "chess.co");
        assert!(RatingType::parse(&b[..13], &dec).is_none());
    }

    #[test]
    fn game_record_reads_every_field_at_its_offset() {
        let dec = TextDecoder::default();
        let mut rec = [0u8; RECORD_SIZE];
        rec[0] = 0x01;
        rec[2] = 1;
        rec[0x08..0x10].copy_from_slice(&0x1234_5678_9abcu64.to_le_bytes());
        rec[0x10..0x18].copy_from_slice(&0x56u64.to_le_bytes());
        rec[0x18..0x20].copy_from_slice(&0x0001_0203i64.to_le_bytes());
        rec[0x20..0x28].copy_from_slice(&7i64.to_le_bytes());
        rec[0x28..0x30].copy_from_slice(&2i64.to_le_bytes());
        rec[0x30..0x38].copy_from_slice(&1i64.to_le_bytes());
        rec[0x38..0x40].copy_from_slice(&4i64.to_le_bytes());
        rec[0x40..0x48].copy_from_slice(&9i64.to_le_bytes());
        rec[0x48..0x50].copy_from_slice(&(-1i64).to_le_bytes());
        rec[0x50..0x58].copy_from_slice(&3i64.to_le_bytes());
        rec[0x58] = 3; // line
        rec[0x59] = 14;
        rec[0x5a..0x5c].copy_from_slice(&5i16.to_le_bytes());
        rec[0x5c..0x5e].copy_from_slice(&2i16.to_le_bytes());
        rec[0x5e..0x60].copy_from_slice(&4i16.to_le_bytes());
        rec[0x60..0x62].copy_from_slice(&2850u16.to_le_bytes());
        rec[0x62..0x64].copy_from_slice(&1u16.to_le_bytes());
        rec[0x64..0x66].copy_from_slice(&1i16.to_le_bytes());
        rec[0x68..0x6c].copy_from_slice(b"FIDE");
        rec[0x70..0x72].copy_from_slice(&2800u16.to_le_bytes());
        rec[0x80..0x82].copy_from_slice(&(64576u16 + 100).to_le_bytes());
        rec[0x82..0x84].copy_from_slice(&0x0009u16.to_le_bytes());
        rec[0x84..0x88].copy_from_slice(&0x0800_0003u32.to_le_bytes());
        rec[0x88..0x8a].copy_from_slice(&0x0004u16.to_le_bytes());
        rec[0x8a..0x8c].copy_from_slice(&40i16.to_le_bytes());
        rec[0xb8..0xbc].copy_from_slice(&7i32.to_le_bytes());
        let date: u32 = 15 | (3 << 5) | (2024 << 9);
        rec[0xbc..0xc0].copy_from_slice(&date.to_le_bytes());
        let g = parse_game_record(&rec, &dec).unwrap();
        assert_eq!(g.moves_offset, 0x1234_5678_9abc);
        assert_eq!(g.annotations_offset, 0x56);
        assert_eq!(g.white, 0x0001_0203);
        assert_eq!(g.black, 7);
        assert_eq!(g.tournament, 2);
        assert_eq!(g.annotator, 1);
        assert_eq!(g.source, 4);
        assert_eq!((g.white_team, g.black_team), (9, -1));
        assert_eq!(g.game_tag, 3);
        assert_eq!(g.result, GameResult::Line);
        assert_eq!(g.line_evaluation, 14);
        assert_eq!((g.round, g.subround, g.board), (5, 2, 4));
        assert_eq!((g.white_elo, g.black_elo), (2850, 2800));
        assert_eq!(g.white_rating.kind, 1);
        assert_eq!(g.white_rating.name, "FIDE");
        assert_eq!(g.eco, EcoField::Chess960(100));
        assert_eq!(g.medals, 9);
        assert_eq!(g.flags, 0x0800_0003);
        assert!(g.flags & GameRecord::FLAG_CHESS960 != 0);
        assert!(g.flags & GameRecord::FLAG_SETUP_POSITION != 0);
        assert_eq!(g.magnitudes, 4);
        assert_eq!(g.move_count, 40);
        assert_eq!(g.version, 7);
        assert_eq!(g.date.to_pgn(), "2024.03.15");
        rec[0] = 0x03;
        assert!(parse_game_record(&rec, &dec)
            .unwrap_err()
            .contains("GuidingText"));
    }
}
