//! Entity files (`.cbp` players, `.cbt` tournaments, `.cbc` annotators,
//! `.cbs` sources): a 28- or 32-byte header followed by fixed-size records that
//! double as the nodes of an AVL tree. Little-endian throughout.
//!
//! We only look records up by id, so the tree is never walked.

use crate::bytes::{c_field, le_i32_at, le_u32_at};
use crate::header::CbDate;
use crate::text::TextDecoder;

/// Size of the tree node that starts every record: left, right, balance.
const NODE_SIZE: usize = 9;
/// Marker in the left-child field of a deleted record.
const DELETED_MARK: i32 = -999;
const MAGIC: i32 = 1_234_567_890;

/// An entity file loaded into memory.
#[derive(Debug, Clone)]
pub struct EntityFile {
    data: Vec<u8>,
    header_size: usize,
    data_size: usize,
    record_count: u32,
}

impl EntityFile {
    /// An empty file: every lookup fails, which callers treat as "not set".
    pub fn empty() -> Self {
        EntityFile {
            data: Vec::new(),
            header_size: 0,
            data_size: 0,
            record_count: 0,
        }
    }

    /// Parses the whole file. `expected_data_size` is the data size the
    /// specification gives for this entity type; the header's value wins when
    /// the two differ (the field layout is still read at the documented
    /// offsets), and a header that is clearly not an entity header is an error.
    pub fn parse(data: Vec<u8>, expected_data_size: usize) -> Result<Self, String> {
        if data.len() < 28 {
            return Err(format!("entity file too short ({} bytes)", data.len()));
        }
        let record_count = le_i32_at(&data, 0).unwrap_or(0);
        let magic = le_i32_at(&data, 8).unwrap_or(0);
        let data_size = le_i32_at(&data, 12).unwrap_or(0);
        let extra = le_i32_at(&data, 24).unwrap_or(0);
        if magic != MAGIC {
            return Err(format!("entity file has bad magic {magic:#x}"));
        }
        if record_count < 0 || data_size <= 0 || !(0..=4).contains(&extra) {
            return Err("entity file header is corrupt".to_string());
        }
        let data_size = data_size as usize;
        if data_size < expected_data_size {
            return Err(format!(
                "entity record data is {data_size} bytes, expected at least {expected_data_size}"
            ));
        }
        Ok(EntityFile {
            data,
            header_size: 28 + extra as usize,
            data_size,
            record_count: record_count as u32,
        })
    }

    pub fn record_count(&self) -> u32 {
        self.record_count
    }

    /// The data part of record `id`, or `None` when the id is out of range or
    /// the record is deleted.
    pub fn record_data(&self, id: u32) -> Option<&[u8]> {
        if id >= self.record_count {
            return None;
        }
        let record_size = NODE_SIZE + self.data_size;
        let start = self.header_size + (id as usize) * record_size;
        let rec = self.data.get(start..start + record_size)?;
        let left = i32::from_le_bytes([rec[0], rec[1], rec[2], rec[3]]);
        if left == DELETED_MARK {
            return None;
        }
        Some(&rec[NODE_SIZE..])
    }

    /// The zero-terminated strings of every live record, for encoding detection.
    pub fn string_fields<'a>(
        &'a self,
        fields: &'a [(usize, usize)],
    ) -> impl Iterator<Item = &'a [u8]> + 'a {
        (0..self.record_count)
            .filter_map(move |id| self.record_data(id))
            .flat_map(move |rec| {
                fields
                    .iter()
                    .filter_map(move |&(off, len)| rec.get(off..off + len).map(c_field))
            })
    }
}

/// A player: `last name, first name`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Player {
    pub last: String,
    pub first: String,
}

impl Player {
    pub const DATA_SIZE: usize = 58;
    pub const STRING_FIELDS: &'static [(usize, usize)] = &[(0, 30), (30, 20)];

    pub fn parse(data: &[u8], dec: &TextDecoder) -> Option<Player> {
        Some(Player {
            last: dec.decode_field(data.get(0..30)?),
            first: dec.decode_field(data.get(30..50)?),
        })
    }

    /// `Last, First` as PGN writes names; `Last` alone when the first name is
    /// empty; `?` when both are.
    pub fn pgn_name(&self) -> String {
        match (self.last.is_empty(), self.first.is_empty()) {
            (true, true) => "?".to_string(),
            (false, true) => self.last.clone(),
            (true, false) => self.first.clone(),
            (false, false) => format!("{}, {}", self.last, self.first),
        }
    }
}

/// A tournament: the PGN `Event`, `Site` and `EventDate`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Tournament {
    pub title: String,
    pub place: String,
    pub date: CbDate,
    pub nation: u8,
    pub rounds: u8,
}

impl Tournament {
    pub const DATA_SIZE: usize = 90;
    pub const STRING_FIELDS: &'static [(usize, usize)] = &[(0, 40), (40, 30)];

    pub fn parse(data: &[u8], dec: &TextDecoder) -> Option<Tournament> {
        Some(Tournament {
            title: dec.decode_field(data.get(0..40)?),
            place: dec.decode_field(data.get(40..70)?),
            date: CbDate::from_packed(le_u32_at(data, 70)?),
            nation: *data.get(76)?,
            rounds: *data.get(80)?,
        })
    }
}

/// An annotator.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Annotator {
    pub name: String,
}

impl Annotator {
    pub const DATA_SIZE: usize = 53;
    pub const STRING_FIELDS: &'static [(usize, usize)] = &[(0, 45)];

    pub fn parse(data: &[u8], dec: &TextDecoder) -> Option<Annotator> {
        Some(Annotator {
            name: dec.decode_field(data.get(0..45)?),
        })
    }
}

/// A source (a publication the game was taken from).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Source {
    pub title: String,
    pub publisher: String,
    pub publication_date: CbDate,
}

impl Source {
    pub const DATA_SIZE: usize = 59;
    pub const STRING_FIELDS: &'static [(usize, usize)] = &[(0, 25), (25, 16)];

    pub fn parse(data: &[u8], dec: &TextDecoder) -> Option<Source> {
        Some(Source {
            title: dec.decode_field(data.get(0..25)?),
            publisher: dec.decode_field(data.get(25..41)?),
            publication_date: CbDate::from_packed(le_u32_at(data, 41)?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(records: &[Vec<u8>], data_size: usize, extra: i32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(records.len() as i32).to_le_bytes());
        out.extend_from_slice(&0i32.to_le_bytes()); // root
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&(data_size as i32).to_le_bytes());
        out.extend_from_slice(&(-1i32).to_le_bytes()); // first deleted
        out.extend_from_slice(&(records.len() as i32).to_le_bytes());
        out.extend_from_slice(&extra.to_le_bytes());
        out.extend(std::iter::repeat_n(0xeeu8, extra as usize));
        for r in records {
            assert_eq!(r.len(), NODE_SIZE + data_size);
            out.extend_from_slice(r);
        }
        out
    }

    fn node(left: i32, right: i32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&left.to_le_bytes());
        v.extend_from_slice(&right.to_le_bytes());
        v.push(0);
        v
    }

    fn padded(s: &[u8], len: usize) -> Vec<u8> {
        let mut v = s.to_vec();
        v.resize(len, 0);
        v
    }

    #[test]
    fn player_records_are_fixed_size_after_a_node_prefix() {
        let mut r0 = node(-1, 1);
        r0.extend(padded(b"Carlsen", 30));
        r0.extend(padded(b"Magnus", 20));
        r0.extend_from_slice(&3i32.to_le_bytes());
        r0.extend_from_slice(&1i32.to_le_bytes());
        let mut r1 = node(DELETED_MARK, -1);
        r1.extend(padded(b"Deleted", 30));
        r1.extend(padded(b"", 20));
        r1.extend_from_slice(&0i32.to_le_bytes());
        r1.extend_from_slice(&0i32.to_le_bytes());
        let mut r2 = node(-1, -1);
        r2.extend(padded(b"", 30)); // placeholder entity: empty text
        r2.extend(padded(b"", 20));
        r2.extend_from_slice(&1i32.to_le_bytes());
        r2.extend_from_slice(&2i32.to_le_bytes());
        for extra in [0, 4] {
            let f = EntityFile::parse(file(&[r0.clone(), r1.clone(), r2.clone()], 58, extra), 58)
                .unwrap();
            assert_eq!(f.record_count(), 3);
            let dec = TextDecoder::default();
            let p = Player::parse(f.record_data(0).unwrap(), &dec).unwrap();
            assert_eq!(p.last, "Carlsen");
            assert_eq!(p.first, "Magnus");
            assert_eq!(p.pgn_name(), "Carlsen, Magnus");
            assert!(f.record_data(1).is_none(), "deleted record");
            assert_eq!(
                Player::parse(f.record_data(2).unwrap(), &dec)
                    .unwrap()
                    .pgn_name(),
                "?"
            );
            assert!(f.record_data(3).is_none());
            let strings: Vec<&[u8]> = f.string_fields(Player::STRING_FIELDS).collect();
            assert_eq!(strings, vec![&b"Carlsen"[..], b"Magnus", b"", b""]);
        }
    }

    #[test]
    fn tournament_annotator_and_source_layouts() {
        let dec = TextDecoder::default();
        let mut t = node(-1, -1);
        t.extend(padded(b"Tata Steel", 40));
        t.extend(padded(b"Wijk aan Zee", 30));
        t.extend_from_slice(&((2024u32 << 9) | (1 << 5) | 13).to_le_bytes());
        // type 3, not a team event, nation 20, unknown, category 0, flags 2, 13 rounds, unknown
        t.extend_from_slice(&[3, 0, 20, 0, 0, 2, 13, 0]);
        t.extend_from_slice(&5i32.to_le_bytes());
        t.extend_from_slice(&1i32.to_le_bytes());
        assert_eq!(t.len(), NODE_SIZE + Tournament::DATA_SIZE);
        let f =
            EntityFile::parse(file(&[t], Tournament::DATA_SIZE, 4), Tournament::DATA_SIZE).unwrap();
        let tr = Tournament::parse(f.record_data(0).unwrap(), &dec).unwrap();
        assert_eq!(tr.title, "Tata Steel");
        assert_eq!(tr.place, "Wijk aan Zee");
        assert_eq!(tr.date.to_pgn(), "2024.01.13");
        assert_eq!(tr.nation, 20);
        assert_eq!(tr.rounds, 13);

        let mut a = node(-1, -1);
        a.extend(padded(b"Kasparov,G", 45));
        a.extend_from_slice(&1i32.to_le_bytes());
        a.extend_from_slice(&1i32.to_le_bytes());
        assert_eq!(a.len(), NODE_SIZE + Annotator::DATA_SIZE);
        let f =
            EntityFile::parse(file(&[a], Annotator::DATA_SIZE, 0), Annotator::DATA_SIZE).unwrap();
        assert_eq!(
            Annotator::parse(f.record_data(0).unwrap(), &dec)
                .unwrap()
                .name,
            "Kasparov,G"
        );

        let mut s = node(-1, -1);
        s.extend(padded(b"Mega 2024", 25));
        s.extend(padded(b"ChessBase", 16));
        s.extend_from_slice(&(2023u32 << 9).to_le_bytes());
        s.extend_from_slice(&0u32.to_le_bytes());
        s.extend_from_slice(&[1, 1]);
        s.extend_from_slice(&9i32.to_le_bytes());
        s.extend_from_slice(&1i32.to_le_bytes());
        assert_eq!(s.len(), NODE_SIZE + Source::DATA_SIZE);
        let f = EntityFile::parse(file(&[s], Source::DATA_SIZE, 0), Source::DATA_SIZE).unwrap();
        let src = Source::parse(f.record_data(0).unwrap(), &dec).unwrap();
        assert_eq!(src.title, "Mega 2024");
        assert_eq!(src.publisher, "ChessBase");
        assert_eq!(src.publication_date.to_pgn(), "2023.??.??");
    }

    #[test]
    fn rejects_files_without_the_magic() {
        let mut bad = file(&[], 58, 0);
        bad[8] = 0;
        assert!(EntityFile::parse(bad, 58).unwrap_err().contains("magic"));
        assert!(EntityFile::parse(vec![0; 10], 58).is_err());
        assert!(EntityFile::parse(file(&[], 10, 0), 58)
            .unwrap_err()
            .contains("expected at least"));
    }
}
