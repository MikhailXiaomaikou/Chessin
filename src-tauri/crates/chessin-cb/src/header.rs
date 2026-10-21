//! `.cbh`: the 46-byte file header and the 46-byte game records (big-endian).

use crate::bytes::Reader;

/// Size of the `.cbh` file header; the same as a record.
pub const CBH_HEADER_SIZE: usize = 46;

/// Fields of the `.cbh` file header that a reader needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CbhFileHeader {
    pub record_size: u16,
    pub format_version: u8,
    pub next_game_id: u32,
}

/// Parses the first 46 bytes of a `.cbh` file.
pub fn parse_file_header(buf: &[u8]) -> Result<CbhFileHeader, String> {
    if buf.len() < CBH_HEADER_SIZE {
        return Err(format!(
            ".cbh file is too short for a header ({} bytes)",
            buf.len()
        ));
    }
    let mut r = Reader::new(buf);
    let _unknown = r.u8();
    let _bytes_in_use = r.be_u16();
    let record_size = r.be_u16().unwrap_or(0);
    let format_version = r.u8().unwrap_or(0);
    let next_game_id = r.be_u32().unwrap_or(0);
    if record_size != CBH_HEADER_SIZE as u16 {
        return Err(format!(
            "unexpected .cbh record size {record_size} (expected 46); not a CBH v1 database?"
        ));
    }
    if format_version != 1 {
        return Err(format!(
            "unsupported .cbh format version {format_version} (only version 1 is supported)"
        ));
    }
    Ok(CbhFileHeader {
        record_size,
        format_version,
        next_game_id,
    })
}

/// A date with unknown parts stored as 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CbDate {
    pub year: u16,
    pub month: u8,
    pub day: u8,
}

impl CbDate {
    /// Unpacks the common date encoding: bits 0-4 day, 5-8 month, 9-20 year.
    pub fn from_packed(v: u32) -> CbDate {
        CbDate {
            day: (v & 0x1f) as u8,
            month: ((v >> 5) & 0x0f) as u8,
            year: ((v >> 9) & 0x0fff) as u16,
        }
    }

    pub fn is_unknown(&self) -> bool {
        self.year == 0 && self.month == 0 && self.day == 0
    }

    /// `YYYY.MM.DD` with `?` for unknown parts, as PGN wants it.
    pub fn to_pgn(&self) -> String {
        let y = if self.year == 0 {
            "????".to_string()
        } else {
            format!("{:04}", self.year)
        };
        let m = if self.month == 0 {
            "??".to_string()
        } else {
            format!("{:02}", self.month)
        };
        let d = if self.day == 0 {
            "??".to_string()
        } else {
            format!("{:02}", self.day)
        };
        format!("{y}.{m}.{d}")
    }
}

/// The result byte of a game record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameResult {
    BlackWins,
    Draw,
    WhiteWins,
    /// Unfinished; the record then carries a line evaluation NAG.
    Line,
    BlackWinsForfeit,
    DrawForfeit,
    WhiteWinsForfeit,
    /// 0-0, both players lost.
    BothLost,
    Unknown(u8),
}

impl GameResult {
    pub fn from_byte(b: u8) -> GameResult {
        match b {
            0 => GameResult::BlackWins,
            1 => GameResult::Draw,
            2 => GameResult::WhiteWins,
            3 => GameResult::Line,
            4 => GameResult::BlackWinsForfeit,
            5 => GameResult::DrawForfeit,
            6 => GameResult::WhiteWinsForfeit,
            7 => GameResult::BothLost,
            other => GameResult::Unknown(other),
        }
    }

    /// The PGN result token. Results PGN cannot express become `*`.
    pub fn to_pgn(self) -> &'static str {
        match self {
            GameResult::BlackWins | GameResult::BlackWinsForfeit => "0-1",
            GameResult::Draw | GameResult::DrawForfeit => "1/2-1/2",
            GameResult::WhiteWins | GameResult::WhiteWinsForfeit => "1-0",
            GameResult::Line | GameResult::BothLost | GameResult::Unknown(_) => "*",
        }
    }

    pub fn is_forfeit(self) -> bool {
        matches!(
            self,
            GameResult::BlackWinsForfeit | GameResult::DrawForfeit | GameResult::WhiteWinsForfeit
        )
    }
}

/// The ECO field, which doubles as the Chess960 start position number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EcoField {
    None,
    /// `A00`-`E99` plus the sub-ECO (0-99).
    Eco {
        code: String,
        sub: u8,
    },
    /// A Chess960 start position, 0-959.
    Chess960(u16),
}

/// Decodes the 16-bit ECO field: `value / 128 - 1` numbers A00-E99 from 0,
/// `value % 128` is the sub-ECO; 0 is none; 64576 and above is a Chess960 start
/// position.
pub fn decode_eco(value: u16) -> EcoField {
    if value == 0 {
        return EcoField::None;
    }
    if value >= 64576 {
        return EcoField::Chess960(value - 64576);
    }
    let index = (value / 128) as i32 - 1;
    if !(0..500).contains(&index) {
        return EcoField::None;
    }
    let letter = (b'A' + (index / 100) as u8) as char;
    EcoField::Eco {
        code: format!("{letter}{:02}", index % 100),
        sub: (value % 128) as u8,
    }
}

/// One 46-byte game record, decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameRecord {
    pub deleted: bool,
    pub guiding_text: bool,
    pub moves_offset: u32,
    pub annotations_offset: u32,
    pub white: u32,
    pub black: u32,
    pub tournament: u32,
    pub annotator: u32,
    pub source: u32,
    pub date: CbDate,
    pub result: GameResult,
    pub line_evaluation: u8,
    pub round: u8,
    pub subround: u8,
    pub white_elo: u16,
    pub black_elo: u16,
    pub eco: EcoField,
    pub medals: u16,
    pub flags: u32,
    pub magnitudes: u16,
    pub move_count: u8,
}

impl GameRecord {
    pub const FLAG_SETUP_POSITION: u32 = 0x0000_0001;
    pub const FLAG_CHESS960: u32 = 0x0800_0000;
}

/// Parses one record. Returns `None` for a record that is all zeros, which lies
/// past the last game.
pub fn parse_game_record(buf: &[u8]) -> Result<Option<GameRecord>, String> {
    if buf.len() < CBH_HEADER_SIZE {
        return Err(format!("truncated .cbh record ({} bytes)", buf.len()));
    }
    let kind = buf[0];
    if kind & 0x01 == 0 {
        return Ok(None);
    }
    let guiding_text = kind & 0x02 != 0;
    let deleted = kind & 0x80 != 0;
    let mut r = Reader::new(&buf[1..]);
    if guiding_text {
        // Only the fields a reader may want to report; the rest is text-specific.
        let moves_offset = r.be_u32().unwrap_or(0);
        let _ = r.be_u16();
        let tournament = r.be_u24().unwrap_or(0);
        let source = r.be_u24().unwrap_or(0);
        let annotator = r.be_u24().unwrap_or(0);
        let round = r.u8().unwrap_or(0);
        let subround = r.u8().unwrap_or(0);
        let flags = r.be_u32().unwrap_or(0);
        return Ok(Some(GameRecord {
            deleted,
            guiding_text,
            moves_offset,
            annotations_offset: 0,
            white: 0,
            black: 0,
            tournament,
            annotator,
            source,
            date: CbDate::default(),
            result: GameResult::Line,
            line_evaluation: 0,
            round,
            subround,
            white_elo: 0,
            black_elo: 0,
            eco: EcoField::None,
            medals: 0,
            flags,
            magnitudes: 0,
            move_count: 0,
        }));
    }
    let moves_offset = r.be_u32().unwrap_or(0);
    let annotations_offset = r.be_u32().unwrap_or(0);
    let white = r.be_u24().unwrap_or(0);
    let black = r.be_u24().unwrap_or(0);
    let tournament = r.be_u24().unwrap_or(0);
    let annotator = r.be_u24().unwrap_or(0);
    let source = r.be_u24().unwrap_or(0);
    let date = CbDate::from_packed(r.be_u24().unwrap_or(0));
    let result = GameResult::from_byte(r.u8().unwrap_or(3));
    let line_evaluation = r.u8().unwrap_or(0);
    let round = r.u8().unwrap_or(0);
    let subround = r.u8().unwrap_or(0);
    let white_elo = r.be_u16().unwrap_or(0);
    let black_elo = r.be_u16().unwrap_or(0);
    let eco = decode_eco(r.be_u16().unwrap_or(0));
    let medals = r.be_u16().unwrap_or(0);
    let flags = r.be_u32().unwrap_or(0);
    let magnitudes = r.be_u16().unwrap_or(0);
    let move_count = r.u8().unwrap_or(0);
    Ok(Some(GameRecord {
        deleted,
        guiding_text,
        moves_offset,
        annotations_offset,
        white,
        black,
        tournament,
        annotator,
        source,
        date,
        result,
        line_evaluation,
        round,
        subround,
        white_elo,
        black_elo,
        eco,
        medals,
        flags,
        magnitudes,
        move_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_unpacks_and_prints_unknown_parts() {
        // 2024-03-15: day 15 | month 3 << 5 | year 2024 << 9
        let v = 15 | (3 << 5) | (2024 << 9);
        let d = CbDate::from_packed(v);
        assert_eq!(
            d,
            CbDate {
                year: 2024,
                month: 3,
                day: 15
            }
        );
        assert_eq!(d.to_pgn(), "2024.03.15");
        assert_eq!(CbDate::from_packed(0).to_pgn(), "????.??.??");
        assert!(CbDate::from_packed(0).is_unknown());
        assert_eq!(CbDate::from_packed(1999 << 9).to_pgn(), "1999.??.??");
        assert_eq!(
            CbDate::from_packed((1999 << 9) | (7 << 5)).to_pgn(),
            "1999.07.??"
        );
    }

    #[test]
    fn result_codes_follow_the_spec() {
        assert_eq!(GameResult::from_byte(0).to_pgn(), "0-1");
        assert_eq!(GameResult::from_byte(1).to_pgn(), "1/2-1/2");
        assert_eq!(GameResult::from_byte(2).to_pgn(), "1-0");
        assert_eq!(GameResult::from_byte(3).to_pgn(), "*");
        assert_eq!(GameResult::from_byte(4).to_pgn(), "0-1");
        assert_eq!(GameResult::from_byte(5).to_pgn(), "1/2-1/2");
        assert_eq!(GameResult::from_byte(6).to_pgn(), "1-0");
        assert_eq!(GameResult::from_byte(7).to_pgn(), "*");
        assert!(GameResult::from_byte(6).is_forfeit());
        assert!(!GameResult::from_byte(2).is_forfeit());
    }

    #[test]
    fn eco_decodes_letter_number_and_sub() {
        assert_eq!(decode_eco(0), EcoField::None);
        // A00 is index 0 -> value 128
        assert_eq!(
            decode_eco(128),
            EcoField::Eco {
                code: "A00".into(),
                sub: 0
            }
        );
        // B12 is index 112 -> (112 + 1) * 128 = 14464, sub 3
        assert_eq!(
            decode_eco(14464 + 3),
            EcoField::Eco {
                code: "B12".into(),
                sub: 3
            }
        );
        // E99 is index 499
        assert_eq!(
            decode_eco(500 * 128),
            EcoField::Eco {
                code: "E99".into(),
                sub: 0
            }
        );
        assert_eq!(decode_eco(64576), EcoField::Chess960(0));
        assert_eq!(decode_eco(64576 + 518), EcoField::Chess960(518));
    }

    #[test]
    fn file_header_rejects_other_formats() {
        let mut h = [0u8; 46];
        h[1] = 0;
        h[2] = 44;
        h[3] = 0;
        h[4] = 46;
        h[5] = 1;
        h[6..10].copy_from_slice(&3u32.to_be_bytes());
        let parsed = parse_file_header(&h).unwrap();
        assert_eq!(parsed.next_game_id, 3);
        assert_eq!(parsed.record_size, 46);
        h[5] = 5;
        assert!(parse_file_header(&h).unwrap_err().contains("version 5"));
        h[5] = 1;
        h[4] = 47;
        assert!(parse_file_header(&h).unwrap_err().contains("record size"));
        assert!(parse_file_header(&h[..10]).is_err());
    }

    #[test]
    fn game_record_fields_land_at_their_offsets() {
        let mut rec = [0u8; 46];
        rec[0] = 0x01;
        rec[1..5].copy_from_slice(&0x0000_1234u32.to_be_bytes());
        rec[5..9].copy_from_slice(&0x0000_0056u32.to_be_bytes());
        rec[9..12].copy_from_slice(&[0x01, 0x02, 0x03]); // white 0x010203
        rec[12..15].copy_from_slice(&[0, 0, 7]); // black 7
        rec[15..18].copy_from_slice(&[0, 0, 2]); // tournament
        rec[18..21].copy_from_slice(&[0, 0, 1]); // annotator
        rec[21..24].copy_from_slice(&[0, 0, 4]); // source
        let date: u32 = 15 | (3 << 5) | (2024 << 9);
        rec[24..27].copy_from_slice(&date.to_be_bytes()[1..]);
        rec[27] = 2; // 1-0
        rec[28] = 0;
        rec[29] = 5; // round
        rec[30] = 2; // subround
        rec[31..33].copy_from_slice(&2850u16.to_be_bytes());
        rec[33..35].copy_from_slice(&2800u16.to_be_bytes());
        rec[35..37].copy_from_slice(&(14464u16 + 3).to_be_bytes());
        rec[37..39].copy_from_slice(&0u16.to_be_bytes());
        rec[39..43].copy_from_slice(&0x0000_0006u32.to_be_bytes());
        rec[43..45].copy_from_slice(&0u16.to_be_bytes());
        rec[45] = 40;
        let g = parse_game_record(&rec).unwrap().unwrap();
        assert!(!g.deleted && !g.guiding_text);
        assert_eq!(g.moves_offset, 0x1234);
        assert_eq!(g.annotations_offset, 0x56);
        assert_eq!(g.white, 0x010203);
        assert_eq!(g.black, 7);
        assert_eq!(g.tournament, 2);
        assert_eq!(g.annotator, 1);
        assert_eq!(g.source, 4);
        assert_eq!(g.date.to_pgn(), "2024.03.15");
        assert_eq!(g.result, GameResult::WhiteWins);
        assert_eq!((g.round, g.subround), (5, 2));
        assert_eq!((g.white_elo, g.black_elo), (2850, 2800));
        assert_eq!(
            g.eco,
            EcoField::Eco {
                code: "B12".into(),
                sub: 3
            }
        );
        assert_eq!(g.flags, 6);
        assert_eq!(g.move_count, 40);

        rec[0] = 0x81;
        assert!(parse_game_record(&rec).unwrap().unwrap().deleted);
        rec[0] = 0x03;
        assert!(parse_game_record(&rec).unwrap().unwrap().guiding_text);
        rec[0] = 0x00;
        assert!(parse_game_record(&rec).unwrap().is_none());
    }
}
