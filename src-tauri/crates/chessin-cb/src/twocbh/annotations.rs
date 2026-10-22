//! `.2cba`: annotations.
//!
//! A game's record (framed like a `.2cbg` record, tag `00 20`) holds position
//! blocks in ascending order of position: the position as an `int` (−1 is the
//! game as a whole, otherwise the index of a move counting from 0 **in the
//! order a PGN lists them**, each alternative with its continuation right
//! after the move it is an alternative to), the number of annotations, and
//! that many annotations, each a 16-bit type followed by its data. The content
//! ends with the marker `7fffffff`. Annotations carry no length field, so a
//! type whose size we do not know ends what can be read of that game.

use base64::Engine;

use crate::annotations::{
    colour_letter, eval_string, hms, kind_name, square_name_1, Payload, RawAnnotation,
    DIAGRAM_MARKER,
};
use crate::bytes::Reader;
use crate::text::TextDecoder;
use crate::Node;

/// Ends the content of every record.
pub const END_MARKER: i32 = 0x7fff_ffff;

/// The annotations of one record, and why reading stopped early, if it did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    /// Positions are PGN-order move indices, −1 for the game.
    pub annotations: Vec<RawAnnotation>,
    pub problem: Option<String>,
}

fn string(r: &mut Reader<'_>) -> Result<(), String> {
    let len = r.le_i32().ok_or("runs past the end of the record")?;
    if len < 0 {
        return Err(format!("has a string of length {len}"));
    }
    r.take(len as usize)
        .map(|_| ())
        .ok_or_else(|| "runs past the end of the record".to_string())
}

fn take(r: &mut Reader<'_>, n: usize) -> Result<(), String> {
    r.take(n)
        .map(|_| ())
        .ok_or_else(|| "runs past the end of the record".to_string())
}

/// A list as training questions hold them: a `short` count, then per item a
/// `short` kind, an `int` length and that many bytes.
fn list(r: &mut Reader<'_>) -> Result<(), String> {
    let count = r.le_u16().ok_or("runs past the end of the record")?;
    for _ in 0..count {
        take(r, 2)?;
        string(r)?;
    }
    Ok(())
}

fn training(r: &mut Reader<'_>) -> Result<(), String> {
    let head = r.take(6).ok_or("runs past the end of the record")?;
    if head[2] != 1 {
        return Err(format!(
            "is a training question of layout {}, which is unknown",
            head[2]
        ));
    }
    take(r, 6)?;
    for _ in 0..4 {
        list(r)?;
    }
    let solutions = r.u8().ok_or("runs past the end of the record")?;
    for _ in 0..solutions {
        take(r, 4)?;
        list(r)?;
    }
    Ok(())
}

fn quotation(r: &mut Reader<'_>) -> Result<(), String> {
    take(r, 1 + 2 + 2 + 4 + 1)?;
    for _ in 0..6 {
        let len = r.u8().ok_or("runs past the end of the record")?;
        take(r, usize::from(len))?;
    }
    take(r, 35 + 44)?;
    for _ in 0..2 {
        take(r, 5)?;
        string(r)?;
    }
    take(r, 29)?;
    let moves = r.le_i32().ok_or("runs past the end of the record")?;
    if moves < 0 {
        return Err(format!("quotes a game of {moves} moves"));
    }
    take(r, 5 * moves as usize)?;
    take(r, 4)
}

/// Consumes one annotation's data of type `kind` from `r`, returning the
/// number of bytes it took.
fn annotation_size(kind: u16, rest: &[u8]) -> Result<usize, String> {
    let mut r = Reader::new(rest);
    match kind {
        0x02 | 0x82 => {
            take(&mut r, 4)?;
            string(&mut r)?;
        }
        0x03 => take(&mut r, 3)?,
        0x04 | 0x05 | 0x15 => string(&mut r)?,
        0x07 | 0x08 | 0x16 | 0x17 | 0x22 | 0x23 | 0x25 => take(&mut r, 4)?,
        0x14 | 0x18 => take(&mut r, 1)?,
        0x21 => take(&mut r, 6)?,
        0x24 => take(&mut r, 38)?,
        0x26 => {
            take(&mut r, 1)?;
            string(&mut r)?;
        }
        0x1c => {
            take(&mut r, 1)?;
            string(&mut r)?;
            string(&mut r)?;
        }
        0x09 => training(&mut r)?,
        0x13 => quotation(&mut r)?,
        _ => return Err("has no known size".to_string()),
    }
    Ok(r.position())
}

/// Parses the content of a record. Reading stops at the first annotation
/// whose size is unknown or does not fit; what came before it is kept.
pub fn parse_content(content: &[u8]) -> Parsed {
    let mut r = Reader::new(content);
    let mut annotations = Vec::new();
    let problem = 'blocks: loop {
        let Some(position) = r.le_i32() else {
            break Some("the record ends without the end marker".to_string());
        };
        if position == END_MARKER {
            break None;
        }
        let Some(count) = r.le_i32() else {
            break Some(format!("the block at position {position} is truncated"));
        };
        if count < 0 {
            break Some(format!(
                "the block at position {position} announces {count} annotations"
            ));
        }
        for _ in 0..count {
            let Some(kind) = r.le_u16() else {
                break 'blocks Some(format!("the block at position {position} is truncated"));
            };
            match annotation_size(kind, r.rest()) {
                Ok(size) => {
                    let data = r.take(size).expect("sized against the rest");
                    annotations.push(RawAnnotation {
                        position,
                        kind: kind as u8,
                        data: data.to_vec(),
                    });
                }
                Err(e) => {
                    break 'blocks Some(format!(
                        "annotation type {kind:#04x} at position {position} {e}; the game's later annotations were dropped"
                    ));
                }
            }
        }
    };
    Parsed {
        annotations,
        problem,
    }
}

/// The node index of each move in PGN order: `result[p]` is the node at
/// annotation position `p`.
pub fn pgn_order(nodes: &[Node]) -> Vec<usize> {
    enum Work {
        Emit(usize),
        Visit(usize),
    }
    let mut out = Vec::with_capacity(nodes.len().saturating_sub(1));
    let mut work = vec![Work::Visit(0)];
    while let Some(item) = work.pop() {
        match item {
            Work::Emit(n) => out.push(n),
            Work::Visit(n) => {
                let Some(kids) = nodes.get(n).map(|n| n.children.as_slice()) else {
                    continue;
                };
                let Some(&main) = kids.first() else {
                    continue;
                };
                work.push(Work::Visit(main));
                for &var in kids[1..].iter().rev() {
                    work.push(Work::Visit(var));
                    work.push(Work::Emit(var));
                }
                work.push(Work::Emit(main));
            }
        }
    }
    out
}

/// Decodes a comment: UTF-8 when valid, else the fallback code page, in which
/// the byte `9e` is the diagram marker of the previous format and is kept by
/// a database converted from it (a native 2CBH comment writes `[#]`).
fn decode_text(data: &[u8], dec: &TextDecoder) -> String {
    let mut r = Reader::new(data);
    let _zero = r.le_u16();
    let _language = r.le_u16();
    let len = r.le_i32().unwrap_or(0).max(0) as usize;
    let text = r.take(len).unwrap_or(&[]);
    if let Ok(s) = std::str::from_utf8(text) {
        return s.to_string();
    }
    let mut out = String::new();
    for (i, part) in text.split(|&b| b == DIAGRAM_MARKER).enumerate() {
        if i > 0 {
            out.push_str("[#]");
        }
        out.push_str(&dec.decode(part));
    }
    out
}

fn time_control(data: &[u8]) -> Option<String> {
    let mut r = Reader::new(data);
    if r.u8()? != 1 {
        return None;
    }
    let mut parts = Vec::new();
    for _ in 0..3 {
        let initial = r.le_i32()?;
        let increment = r.le_i32()?;
        let moves = r.le_u16()?;
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

/// Interprets one annotation. Types we know the size of but do not
/// translate come back as [`Payload::Unsupported`].
pub fn decode(kind: u8, data: &[u8], dec: &TextDecoder) -> Payload {
    match kind {
        0x02 => Payload::TextAfter(decode_text(data, dec)),
        0x82 => Payload::TextBefore(decode_text(data, dec)),
        0x03 => Payload::Symbols(data.iter().take(3).copied().filter(|&n| n != 0).collect()),
        0x04 => {
            let items: Vec<String> = data
                .get(4..)
                .unwrap_or(&[])
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
                .get(4..)
                .unwrap_or(&[])
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
            [_, s, m, h] => Payload::Command(format!(
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
            match r.le_i32() {
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
            let _one = r.u8();
            let url_len = r.le_i32().unwrap_or(0).max(0) as usize;
            let url = r.take(url_len).map(|u| dec.decode(u)).unwrap_or_default();
            let caption_len = r.le_i32().unwrap_or(0).max(0) as usize;
            let caption = r
                .take(caption_len)
                .map(|c| dec.decode(c))
                .unwrap_or_default();
            if url.is_empty() {
                Payload::Unsupported(kind_name(kind))
            } else if caption.is_empty() {
                Payload::TextAfter(url)
            } else {
                Payload::TextAfter(format!("{caption}: {url}"))
            }
        }
        0x21 => {
            let mut r = Reader::new(data);
            match (r.le_i16(), r.le_i16(), r.le_i16()) {
                (Some(value), Some(mate_kind), Some(_depth)) => {
                    Payload::Command(format!("[%eval {}]", eval_string(value, mate_kind == 1)))
                }
                _ => Payload::Unsupported(kind_name(kind)),
            }
        }
        0x24 => match time_control(data) {
            Some(tc) => Payload::TimeControl(tc),
            None => Payload::Unsupported(kind_name(kind)),
        },
        0x26 => {
            let mut r = Reader::new(data);
            let _one = r.u8();
            let _bytes = r.le_i32();
            let count = r.le_u16().unwrap_or(0) as usize;
            let mut evals = Vec::with_capacity(count);
            for _ in 0..count {
                let Some(entry) = r.take(4) else { break };
                let value = i16::from_le_bytes([entry[0], entry[1]]);
                evals.push(match entry[3] {
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
pub(crate) mod testutil {
    /// The data of a text annotation (type `02`/`82`), language 7 (any).
    pub fn text(s: &str) -> Vec<u8> {
        let mut v = vec![0u8, 0, 7, 0];
        v.extend_from_slice(&(s.len() as i32).to_le_bytes());
        v.extend_from_slice(s.as_bytes());
        v
    }

    /// The data of a squares, arrows or piece-path annotation: a length and bytes.
    pub fn sized(bytes: &[u8]) -> Vec<u8> {
        let mut v = (bytes.len() as i32).to_le_bytes().to_vec();
        v.extend_from_slice(bytes);
        v
    }

    /// Serialises position blocks: `(position, kind, data)` triples, which must
    /// be grouped by position in ascending order.
    pub fn content(anns: &[(i32, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < anns.len() {
            let position = anns[i].0;
            let j = anns[i..]
                .iter()
                .position(|a| a.0 != position)
                .map(|n| i + n)
                .unwrap_or(anns.len());
            out.extend_from_slice(&position.to_le_bytes());
            out.extend_from_slice(&((j - i) as i32).to_le_bytes());
            for (_, kind, data) in &anns[i..j] {
                out.extend_from_slice(&kind.to_le_bytes());
                out.extend_from_slice(data);
            }
            i = j;
        }
        out.extend_from_slice(&super::END_MARKER.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    fn dec() -> TextDecoder {
        TextDecoder::default()
    }

    #[test]
    fn empty_record_is_the_end_marker_alone() {
        let p = parse_content(&[0xff, 0xff, 0xff, 0x7f]);
        assert_eq!(p, Parsed::default());
        assert_eq!(content(&[]), vec![0xff, 0xff, 0xff, 0x7f]);
    }

    #[test]
    fn real_first_block_of_a_converted_database() {
        // Position −1, two annotations, the first a text in language 7.
        let mut c = vec![0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0x02, 0x00, 0, 0, 7, 0];
        c.extend_from_slice(&6i32.to_le_bytes());
        c.extend_from_slice(b"Games ");
        c.extend_from_slice(&[0x03, 0x00, 0, 14, 0]);
        c.extend_from_slice(&END_MARKER.to_le_bytes());
        let p = parse_content(&c);
        assert!(p.problem.is_none());
        assert_eq!(p.annotations.len(), 2);
        assert_eq!(p.annotations[0].position, -1);
        assert_eq!(
            decode(p.annotations[0].kind, &p.annotations[0].data, &dec()),
            Payload::TextAfter("Games ".into())
        );
        assert_eq!(
            decode(p.annotations[1].kind, &p.annotations[1].data, &dec()),
            Payload::Symbols(vec![14])
        );
    }

    #[test]
    fn every_known_type_is_sized_and_unknown_ones_stop_the_record() {
        let mut quote = vec![1u8, 2, 0, 0, 0, 1, 0, 0, 0, 0];
        for s in [&b"Last\0"[..], b"\0", b"B\0", b"\0", b"Site\0", b"Ev\0"] {
            quote.push(s.len() as u8);
            quote.extend_from_slice(s);
        }
        quote.extend_from_slice(&[0u8; 35 + 44]);
        for _ in 0..2 {
            quote.extend_from_slice(&[1, 0, 1, 0, 0]);
            quote.extend(sized(b"FIDE"));
        }
        quote.extend_from_slice(&[0u8; 29]);
        quote.extend_from_slice(&2i32.to_le_bytes());
        quote.extend_from_slice(&[12, 28, 0, 0, 0, 52, 36, 0, 0, 0]);
        quote.extend_from_slice(&0i32.to_le_bytes());
        let mut training = vec![1u8, 1, 1, 0, 0, 0];
        training.extend_from_slice(&30i32.to_le_bytes());
        training.extend_from_slice(&5i16.to_le_bytes());
        // question: one text item; three empty response lists
        training.extend_from_slice(&1u16.to_le_bytes());
        training.extend_from_slice(&0u16.to_le_bytes());
        training.extend(sized(b"Find the move"));
        training.extend_from_slice(&[0u8; 6]);
        training.push(1); // one solution
        training.extend_from_slice(&[12, 28, 0, 0]);
        training.extend_from_slice(&0u16.to_le_bytes());
        let mut link = vec![1u8];
        link.extend(sized(b"https://x.y"));
        link.extend(sized(b"Site"));
        let mut evals = vec![1u8];
        evals.extend_from_slice(&6i32.to_le_bytes());
        evals.extend_from_slice(&1u16.to_le_bytes());
        evals.extend_from_slice(&[20, 0, 18, 0]);
        let anns: Vec<(i32, u16, Vec<u8>)> = vec![
            (-1, 0x02, text("whole")),
            (-1, 0x16, 6000i32.to_le_bytes().to_vec()),
            (-1, 0x17, 6000i32.to_le_bytes().to_vec()),
            (-1, 0x22, vec![0; 4]),
            (-1, 0x24, vec![0; 38]),
            (-1, 0x26, evals),
            (0, 0x82, text("before")),
            (0, 0x03, vec![1, 14, 0]),
            (0, 0x04, sized(&[2, 37])),
            (0, 0x05, sized(&[2, 36, 38])),
            (0, 0x07, vec![0, 5, 1, 0]),
            (0, 0x08, vec![6, 0, 0, 0]),
            (0, 0x09, training),
            (0, 0x13, quote),
            (0, 0x14, vec![1]),
            (0, 0x15, sized(&[1, 2, 3])),
            (0, 0x18, vec![2]),
            (0, 0x1c, link),
            (0, 0x21, vec![35, 0, 0, 0, 20, 0]),
            (0, 0x23, vec![0; 4]),
            (0, 0x25, vec![0; 4]),
            (1, 0x02, text("after")),
        ];
        let c = content(&anns);
        let p = parse_content(&c);
        assert_eq!(p.problem, None);
        assert_eq!(p.annotations.len(), anns.len());
        for (raw, (pos, kind, data)) in p.annotations.iter().zip(&anns) {
            assert_eq!(raw.position, *pos);
            assert_eq!(u16::from(raw.kind), *kind);
            assert_eq!(&raw.data, data, "type {kind:#04x}");
        }
        // A video annotation has no known size: the rest is dropped.
        let mut with_video = anns.clone();
        with_video.insert(8, (0, 0x20, vec![1, 2, 3]));
        let p = parse_content(&content(&with_video));
        assert_eq!(p.annotations.len(), 8);
        assert_eq!(
            p.problem.as_deref(),
            Some("annotation type 0x20 at position 0 has no known size; the game's later annotations were dropped")
        );
        let mut layout2 = anns.clone();
        layout2[12].2[2] = 2;
        let p = parse_content(&content(&layout2));
        assert_eq!(p.annotations.len(), 12);
        assert!(p.problem.unwrap().contains("training question of layout 2"));
        // Truncation and bad counts.
        let p = parse_content(&c[..c.len() - 6]);
        assert!(p.problem.unwrap().contains("runs past the end"));
        let p = parse_content(&c[..c.len() - 4]);
        assert!(p.problem.unwrap().contains("without the end marker"));
        let p = parse_content(&[0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
        assert!(p.problem.unwrap().contains("announces -1"));
        let p = parse_content(&[0, 0, 0, 0, 1, 0, 0, 0, 0x02]);
        assert!(p.problem.unwrap().contains("truncated"));
    }

    #[test]
    fn payloads_translate_to_pgn_commands() {
        let d = dec();
        assert_eq!(
            decode(0x02, &text("hi"), &d),
            Payload::TextAfter("hi".into())
        );
        assert_eq!(
            decode(0x82, &text("caf\u{e9}"), &d),
            Payload::TextBefore("café".into())
        );
        // cp1252 text is still decoded, with the old diagram marker.
        let mut cp = vec![0u8, 0, 1, 0, 4, 0, 0, 0];
        cp.extend_from_slice(b"caf\xe9");
        assert_eq!(decode(0x02, &cp, &d), Payload::TextAfter("café".into()));
        let mut cp = vec![0u8, 0, 1, 0, 6, 0, 0, 0];
        cp.extend_from_slice(b"\x9eZug\xe9\x9e");
        assert_eq!(
            decode(0x02, &cp, &d),
            Payload::TextAfter("[#]Zugé[#]".into())
        );
        // A UTF-8 comment keeps a continuation byte 9e (here inside U+00DE).
        let mut utf = vec![0u8, 0, 1, 0, 5, 0, 0, 0];
        utf.extend_from_slice("Þ[#]".as_bytes());
        assert_eq!(decode(0x02, &utf, &d), Payload::TextAfter("Þ[#]".into()));
        assert_eq!(decode(0x03, &[1, 14, 0], &d), Payload::Symbols(vec![1, 14]));
        assert_eq!(
            decode(0x04, &sized(&[2, 37, 4, 29]), &d),
            Payload::Command("[%csl Ge5,Rd5]".into())
        );
        assert_eq!(
            decode(0x05, &sized(&[2, 36, 38]), &d),
            Payload::Command("[%cal Ge4e6]".into())
        );
        assert_eq!(
            decode(0x04, &sized(&[]), &d),
            Payload::Unsupported("coloured squares (04)".into())
        );
        assert_eq!(
            decode(0x07, &[0, 9, 5, 1], &d),
            Payload::Command("[%emt 1:05:09]".into())
        );
        assert_eq!(
            decode(0x16, &372_300i32.to_le_bytes(), &d),
            Payload::Command("[%clk 1:02:03]".into())
        );
        assert_eq!(
            decode(0x17, &[0; 4], &d),
            Payload::Command("[%clk 0:00:00]".into())
        );
        assert_eq!(
            decode(0x18, &[3], &d),
            Payload::Command("[%crit endgame]".into())
        );
        assert_eq!(
            decode(0x09, &[1, 0, 1], &d),
            Payload::Command("[%train AQAB]".into())
        );
        let mut link = vec![1u8];
        link.extend(sized(b"https://x.y"));
        link.extend(sized(b""));
        assert_eq!(
            decode(0x1c, &link, &d),
            Payload::TextAfter("https://x.y".into())
        );
        let mut link = vec![1u8];
        link.extend(sized(b"https://x.y"));
        link.extend(sized(b"Site"));
        assert_eq!(
            decode(0x1c, &link, &d),
            Payload::TextAfter("Site: https://x.y".into())
        );
        assert_eq!(
            decode(0x21, &[35, 0, 0, 0, 20, 0], &d),
            Payload::Command("[%eval 0.35]".into())
        );
        assert_eq!(
            decode(0x21, &[0xfd, 0xff, 1, 0, 20, 0], &d),
            Payload::Command("[%eval #-3]".into())
        );
        let mut tc = vec![1u8];
        for (initial, inc, moves, kind) in [
            (720_000i32, 0i32, 40u16, 1u8),
            (180_000, 3000, 1000, 3),
            (0, 0, 0, 0),
        ] {
            tc.extend_from_slice(&initial.to_le_bytes());
            tc.extend_from_slice(&inc.to_le_bytes());
            tc.extend_from_slice(&moves.to_le_bytes());
            tc.push(kind);
        }
        tc.extend_from_slice(&[0; 4]);
        assert_eq!(
            decode(0x24, &tc, &d),
            Payload::TimeControl("40/7200:1800+30".into())
        );
        assert_eq!(
            decode(0x24, &[0; 38], &d),
            Payload::Unsupported("time control (24)".into())
        );
        let mut evals = vec![1u8];
        evals.extend_from_slice(&14i32.to_le_bytes());
        evals.extend_from_slice(&3u16.to_le_bytes());
        evals.extend_from_slice(&[30, 0, 20, 0]);
        evals.extend_from_slice(&[0, 0, 0, 0xff]);
        evals.extend_from_slice(&[0xfe, 0xff, 20, 1]);
        assert_eq!(
            decode(0x26, &evals, &d),
            Payload::Evaluations(vec![Some("0.30".into()), None, Some("#-2".into())])
        );
        assert_eq!(
            decode(0x22, &[0; 4], &d),
            Payload::Unsupported("medals (22)".into())
        );
        assert_eq!(
            decode(0x13, &[], &d),
            Payload::Unsupported("game quotation (13)".into())
        );
    }

    #[test]
    fn pgn_order_lists_each_alternative_right_after_its_move() {
        // 1.e4 c5 (1...c6 2.d4) (1...Nf6 2.e5) 2.Nf3 d6 (2...Nc6 3.Bb5) 3.d4,
        // nodes in stream order: e4 1, c5 2, Nf3 3, d6 4, d4 5, Nc6 6, Bb5 7,
        // c6 8, d4 9, Nf6 10, e5 11.
        let mut nodes: Vec<Node> = (0..12).map(|_| Node::default()).collect();
        nodes[0].children = vec![1];
        nodes[1].children = vec![2, 8, 10];
        nodes[2].children = vec![3];
        nodes[3].children = vec![4, 6];
        nodes[4].children = vec![5];
        nodes[6].children = vec![7];
        nodes[8].children = vec![9];
        nodes[10].children = vec![11];
        assert_eq!(pgn_order(&nodes), vec![1, 2, 8, 9, 10, 11, 3, 4, 6, 7, 5]);
        assert_eq!(pgn_order(&[Node::default()]), Vec::<usize>::new());
        assert_eq!(pgn_order(&[]), Vec::<usize>::new());
    }
}
