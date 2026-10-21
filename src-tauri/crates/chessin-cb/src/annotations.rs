//! `.cba`: annotations.
//!
//! A game's record is a 14-byte header followed by annotations, each with a
//! 6-byte header (24-bit position, type, 16-bit size including the header), so
//! a type we do not understand is skipped by its size. Positions count the
//! moves in `.cbg` stream order from 0; -1 is the game as a whole.

use base64::Engine;

use crate::bytes::Reader;
use crate::text::TextDecoder;

/// Size of the record header: game id, magic, count, size.
pub const RECORD_HEADER_SIZE: usize = 14;
/// Size of the header of one annotation.
pub const ANNOTATION_HEADER_SIZE: usize = 6;
/// ChessBase's diagram marker inside a text annotation.
const DIAGRAM_MARKER: u8 = 0x9e;

/// One annotation, not yet interpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAnnotation {
    pub position: i32,
    pub kind: u8,
    pub data: Vec<u8>,
}

/// The size of a record, from its header.
pub fn record_size(header: &[u8]) -> Result<u32, String> {
    if header.len() < RECORD_HEADER_SIZE {
        return Err("annotation record header is truncated".to_string());
    }
    let mut r = Reader::new(header);
    let _game_id = r.be_u24();
    let _magic = r.take(4);
    let _count = r.be_u24();
    let size = r.be_u32().unwrap_or(0);
    if (size as usize) < RECORD_HEADER_SIZE {
        return Err(format!("annotation record size {size} is too small"));
    }
    Ok(size)
}

/// Parses a whole record (header included) into its game id and annotations,
/// in file order.
pub fn parse_record(record: &[u8]) -> Result<(u32, Vec<RawAnnotation>), String> {
    let size = record_size(record)? as usize;
    let mut r = Reader::new(&record[..size.min(record.len())]);
    let game_id = r.be_u24().unwrap_or(0);
    let _magic = r.take(4);
    let count_plus_one = r.be_u24().unwrap_or(0);
    let _size = r.be_u32();
    let mut out = Vec::with_capacity(count_plus_one.saturating_sub(1) as usize);
    while r.remaining() >= ANNOTATION_HEADER_SIZE {
        let position = r.be_i24().unwrap_or(-1);
        let kind = r.u8().unwrap_or(0);
        let len = r.be_u16().unwrap_or(0) as usize;
        if len < ANNOTATION_HEADER_SIZE {
            return Err(format!(
                "annotation of type {kind:#04x} has size {len}, smaller than its header"
            ));
        }
        let data = r
            .take(len - ANNOTATION_HEADER_SIZE)
            .ok_or_else(|| format!("annotation of type {kind:#04x} runs past the record"))?;
        out.push(RawAnnotation {
            position,
            kind,
            data: data.to_vec(),
        });
    }
    Ok((game_id, out))
}

/// What an annotation becomes in PGN.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// Text shown after the move (`{...}` following it).
    TextAfter(String),
    /// Text shown before the move.
    TextBefore(String),
    /// Numeric annotation glyphs.
    Symbols(Vec<u8>),
    /// A `[%...]` command for the comment after the move.
    Command(String),
    /// The `TimeControl` tag.
    TimeControl(String),
    /// Engine evaluations of the main line: entry 0 is the start position,
    /// entry *i* the position after main-line move *i*. `None` is no
    /// evaluation.
    Evaluations(Vec<Option<String>>),
    /// A type we do not translate; the name goes into the import report.
    Unsupported(String),
}

/// Names of the types we know of but do not translate.
pub fn kind_name(kind: u8) -> String {
    let name = match kind {
        0x02 => "text after move",
        0x82 => "text before move",
        0x03 => "symbols",
        0x04 => "coloured squares",
        0x05 => "arrows",
        0x07 => "time spent",
        0x08 => "unknown type 08",
        0x09 => "training",
        0x10 => "sound",
        0x11 => "picture",
        0x13 => "game quotation",
        0x14 => "pawn structure",
        0x15 => "piece path",
        0x16 => "white clock",
        0x17 => "black clock",
        0x18 => "critical position",
        0x19 => "correspondence move",
        0x1a => "unknown type 1a",
        0x1c => "web link",
        0x20 => "video",
        0x21 => "computer evaluation",
        0x22 => "medals",
        0x23 => "variation colour",
        0x24 => "time control",
        0x25 => "video stream time",
        0x26 => "evaluations",
        _ => return format!("unknown type {kind:02x}"),
    };
    format!("{name} ({kind:02x})")
}

fn decode_text(data: &[u8], dec: &TextDecoder) -> String {
    // 1 unknown byte, 1 language byte, then the text.
    let text = data.get(2..).unwrap_or(&[]);
    let text = match text.iter().rposition(|&b| b != 0) {
        Some(i) => &text[..=i],
        None => &[],
    };
    let mut out = String::new();
    for (i, part) in text.split(|&b| b == DIAGRAM_MARKER).enumerate() {
        if i > 0 {
            out.push_str("[#]");
        }
        out.push_str(&dec.decode(part));
    }
    out
}

fn colour_letter(c: u8) -> char {
    match c {
        2 => 'G',
        3 => 'Y',
        4 => 'R',
        _ => 'B',
    }
}

/// Square name from the 1-based numbering of squares and arrows.
fn square_name_1(v: u8) -> Option<String> {
    if !(1..=64).contains(&v) {
        return None;
    }
    let i = v - 1;
    let file = (b'a' + i / 8) as char;
    let rank = (b'1' + i % 8) as char;
    Some(format!("{file}{rank}"))
}

fn hms(total_seconds: u64) -> String {
    format!(
        "{}:{:02}:{:02}",
        total_seconds / 3600,
        (total_seconds / 60) % 60,
        total_seconds % 60
    )
}

fn eval_string(value: i16, mate: bool) -> String {
    if mate {
        format!("#{value}")
    } else {
        format!("{:.2}", f64::from(value) / 100.0)
    }
}

fn time_control(data: &[u8]) -> Option<String> {
    let mut r = Reader::new(data);
    let mut parts = Vec::new();
    for _ in 0..3 {
        let initial = r.be_i32()?;
        let increment = r.be_i32()?;
        let moves = r.be_u16()?;
        let kind = r.u8()?;
        let secs = (initial.max(0) / 100) as u32;
        let inc = (increment.max(0) / 100) as u32;
        match kind {
            1 if moves > 0 && moves < 1000 => {
                if inc > 0 {
                    parts.push(format!("{moves}/{secs}+{inc}"));
                } else {
                    parts.push(format!("{moves}/{secs}"));
                }
            }
            0 if initial > 0 => parts.push(secs.to_string()),
            3 if initial > 0 || inc > 0 => parts.push(format!("{secs}+{inc}")),
            _ => {}
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(":"))
    }
}

/// Interprets one annotation.
pub fn decode(kind: u8, data: &[u8], dec: &TextDecoder) -> Payload {
    match kind {
        0x02 => Payload::TextAfter(decode_text(data, dec)),
        0x82 => Payload::TextBefore(decode_text(data, dec)),
        0x03 => Payload::Symbols(data.iter().take(3).copied().filter(|&n| n != 0).collect()),
        0x04 => {
            let items: Vec<String> = data
                .chunks_exact(2)
                .filter_map(|c| {
                    square_name_1(c[1]).map(|sq| format!("{}{sq}", colour_letter(c[0])))
                })
                .collect();
            if items.is_empty() {
                Payload::Unsupported(kind_name(kind))
            } else {
                Payload::Command(format!("[%csl {}]", items.join(",")))
            }
        }
        0x05 => {
            let items: Vec<String> = data
                .chunks_exact(3)
                .filter_map(|c| {
                    Some(format!(
                        "{}{}{}",
                        colour_letter(c[0]),
                        square_name_1(c[1])?,
                        square_name_1(c[2])?
                    ))
                })
                .collect();
            if items.is_empty() {
                Payload::Unsupported(kind_name(kind))
            } else {
                Payload::Command(format!("[%cal {}]", items.join(",")))
            }
        }
        0x07 => match data {
            [h, m, s, ..] => Payload::Command(format!(
                "[%emt {}]",
                hms(u64::from(*h) * 3600 + u64::from(*m) * 60 + u64::from(*s))
            )),
            _ => Payload::Unsupported(kind_name(kind)),
        },
        0x09 => Payload::Command(format!(
            "[%train {}]",
            base64::engine::general_purpose::STANDARD.encode(data)
        )),
        0x16 | 0x17 => {
            let mut r = Reader::new(data);
            match r.be_i32() {
                Some(cs) => {
                    Payload::Command(format!("[%clk {}]", hms(u64::from(cs.max(0) as u32) / 100)))
                }
                None => Payload::Unsupported(kind_name(kind)),
            }
        }
        0x18 => {
            let phase = match data.first() {
                Some(1) => "opening".to_string(),
                Some(2) => "middlegame".to_string(),
                Some(3) => "endgame".to_string(),
                Some(n) => n.to_string(),
                None => return Payload::Unsupported(kind_name(kind)),
            };
            Payload::Command(format!("[%crit {phase}]"))
        }
        0x1c => {
            let mut r = Reader::new(data);
            let _size = r.le_u16();
            let url_len = r.u8().map(usize::from).unwrap_or(0);
            match r.take(url_len) {
                Some(url) if !url.is_empty() => {
                    let url = dec.decode(url);
                    let text_len = r.u8().map(usize::from).unwrap_or(0);
                    let text = r.take(text_len).map(|t| dec.decode(t)).unwrap_or_default();
                    if text.is_empty() {
                        Payload::TextAfter(url)
                    } else {
                        Payload::TextAfter(format!("{text}: {url}"))
                    }
                }
                _ => Payload::Unsupported(kind_name(kind)),
            }
        }
        0x21 => {
            if data.len() != 6 {
                return Payload::Unsupported(format!("computer evaluation ({kind:02x}, old form)"));
            }
            let mut r = Reader::new(data);
            let value = r.le_i16().unwrap_or(0);
            let mate = r.le_i16().unwrap_or(0) == 1;
            let _depth = r.le_i16();
            Payload::Command(format!("[%eval {}]", eval_string(value, mate)))
        }
        0x24 => match time_control(data) {
            Some(tc) => Payload::TimeControl(tc),
            None => Payload::Unsupported(kind_name(kind)),
        },
        0x26 => {
            let mut r = Reader::new(data);
            let count = r.be_u16().unwrap_or(0) as usize;
            let mut evals = Vec::with_capacity(count);
            for _ in 0..count {
                let Some(entry) = r.take(4) else { break };
                let value = i16::from_be_bytes([entry[2], entry[3]]);
                evals.push(match entry[0] {
                    0 => Some(eval_string(value, false)),
                    1 => Some(eval_string(value, true)),
                    _ => None,
                });
            }
            Payload::Evaluations(evals)
        }
        _ => Payload::Unsupported(kind_name(kind)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec() -> TextDecoder {
        TextDecoder::default()
    }

    #[test]
    fn parses_a_record_and_skips_unknown_types_by_size() {
        let mut rec = Vec::new();
        rec.extend_from_slice(&[0, 0, 7]); // game id 7
        rec.extend_from_slice(&[0x01, 0x00, 0x0e, 0x0e]);
        rec.extend_from_slice(&[0, 0, 3]); // 2 annotations + 1
        let mut body = Vec::new();
        // text after move 0: "hi"
        body.extend_from_slice(&[0, 0, 0, 0x02]);
        body.extend_from_slice(&(6u16 + 4).to_be_bytes());
        body.extend_from_slice(&[0, 0, b'h', b'i']);
        // unknown type 0x42 on the game, 3 bytes
        body.extend_from_slice(&[0xff, 0xff, 0xff, 0x42]);
        body.extend_from_slice(&(6u16 + 3).to_be_bytes());
        body.extend_from_slice(&[1, 2, 3]);
        let size = (RECORD_HEADER_SIZE + body.len()) as u32;
        rec.extend_from_slice(&size.to_be_bytes());
        rec.extend(body);
        // Trailing bytes of the next record must not be read.
        let mut with_tail = rec.clone();
        with_tail.extend_from_slice(&[9, 9, 9, 9, 9, 9, 9]);
        assert_eq!(record_size(&with_tail).unwrap(), size);
        let (id, anns) = parse_record(&with_tail).unwrap();
        assert_eq!(id, 7);
        assert_eq!(anns.len(), 2);
        assert_eq!(anns[0].position, 0);
        assert_eq!(anns[0].kind, 0x02);
        assert_eq!(
            decode(anns[0].kind, &anns[0].data, &dec()),
            Payload::TextAfter("hi".into())
        );
        assert_eq!(anns[1].position, -1);
        assert_eq!(
            decode(anns[1].kind, &anns[1].data, &dec()),
            Payload::Unsupported("unknown type 42".into())
        );
    }

    #[test]
    fn text_handles_diagram_marker_and_trailing_zeros() {
        let data = b"\x00\x00Position\x9e now\x00\x00";
        assert_eq!(
            decode(0x82, data, &dec()),
            Payload::TextBefore("Position[#] now".into())
        );
        assert_eq!(
            decode(0x02, b"\x00\x00", &dec()),
            Payload::TextAfter(String::new())
        );
    }

    #[test]
    fn symbols_drop_zero_bytes() {
        assert_eq!(
            decode(0x03, &[1, 14], &dec()),
            Payload::Symbols(vec![1, 14])
        );
        assert_eq!(
            decode(0x03, &[0, 18, 0], &dec()),
            Payload::Symbols(vec![18])
        );
    }

    #[test]
    fn squares_and_arrows_are_one_based() {
        assert_eq!(
            decode(0x04, &[2, 1, 4, 64, 3, 9, 7, 10], &dec()),
            Payload::Command("[%csl Ga1,Rh8,Yb1,Bb2]".into())
        );
        // e2 = 4 * 8 + 1 + 1 = 34, e4 = 36; a to-square of 0 drops the arrow.
        assert_eq!(
            decode(0x05, &[2, 34, 36, 4, 1, 0], &dec()),
            Payload::Command("[%cal Ge2e4]".into())
        );
        assert_eq!(
            decode(0x04, &[2, 0], &dec()),
            Payload::Unsupported("coloured squares (04)".into())
        );
    }

    #[test]
    fn clocks_time_spent_eval_critical_and_training() {
        // 1h 2m 3s = 372300 hundredths
        assert_eq!(
            decode(0x16, &372_300i32.to_be_bytes(), &dec()),
            Payload::Command("[%clk 1:02:03]".into())
        );
        assert_eq!(
            decode(0x17, &[0, 0, 0, 0], &dec()),
            Payload::Command("[%clk 0:00:00]".into())
        );
        assert_eq!(
            decode(0x07, &[0, 5, 9, 0], &dec()),
            Payload::Command("[%emt 0:05:09]".into())
        );
        let mut eval = Vec::new();
        eval.extend_from_slice(&35i16.to_le_bytes());
        eval.extend_from_slice(&0i16.to_le_bytes());
        eval.extend_from_slice(&20i16.to_le_bytes());
        assert_eq!(
            decode(0x21, &eval, &dec()),
            Payload::Command("[%eval 0.35]".into())
        );
        let mut mate = Vec::new();
        mate.extend_from_slice(&(-3i16).to_le_bytes());
        mate.extend_from_slice(&1i16.to_le_bytes());
        mate.extend_from_slice(&20i16.to_le_bytes());
        assert_eq!(
            decode(0x21, &mate, &dec()),
            Payload::Command("[%eval #-3]".into())
        );
        assert_eq!(
            decode(0x21, &[0; 32], &dec()),
            Payload::Unsupported("computer evaluation (21, old form)".into())
        );
        assert_eq!(
            decode(0x18, &[2], &dec()),
            Payload::Command("[%crit middlegame]".into())
        );
        assert_eq!(
            decode(0x09, &[1, 0, 1], &dec()),
            Payload::Command("[%train AQAB]".into())
        );
    }

    #[test]
    fn time_control_series_become_a_pgn_tag() {
        let mut data = Vec::new();
        for (initial, inc, moves, kind) in [
            (720_000i32, 0i32, 40u16, 1u8),
            (180_000, 3000, 1000, 3),
            (0, 0, 1000, 5),
        ] {
            data.extend_from_slice(&initial.to_be_bytes());
            data.extend_from_slice(&inc.to_be_bytes());
            data.extend_from_slice(&moves.to_be_bytes());
            data.push(kind);
        }
        assert_eq!(
            decode(0x24, &data, &dec()),
            Payload::TimeControl("40/7200:1800+30".into())
        );
        assert_eq!(
            decode(0x24, &[0; 33], &dec()),
            Payload::Unsupported("time control (24)".into())
        );
    }

    #[test]
    fn evaluation_list_maps_entries() {
        let mut data = Vec::new();
        data.extend_from_slice(&3u16.to_be_bytes());
        data.extend_from_slice(&[0, 20, 0, 30]); // +0.30
        data.extend_from_slice(&[0xff, 0, 0, 0]); // none
        data.extend_from_slice(&[1, 20, 0xff, 0xfe]); // mate -2
        assert_eq!(
            decode(0x26, &data, &dec()),
            Payload::Evaluations(vec![Some("0.30".into()), None, Some("#-2".into())])
        );
    }

    #[test]
    fn web_link_becomes_text() {
        let mut data = Vec::new();
        data.extend_from_slice(&0u16.to_le_bytes());
        data.push(11);
        data.extend_from_slice(b"https://x.y");
        data.push(0);
        assert_eq!(
            decode(0x1c, &data, &dec()),
            Payload::TextAfter("https://x.y".into())
        );
    }

    #[test]
    fn unknown_kinds_are_named_for_the_report() {
        assert_eq!(kind_name(0x22), "medals (22)");
        assert_eq!(kind_name(0x7f), "unknown type 7f");
        assert_eq!(
            decode(0x22, &[0; 4], &dec()),
            Payload::Unsupported("medals (22)".into())
        );
    }
}
