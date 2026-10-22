//! The fixed parts of the `.cpi` file: the header and the segment table.
//!
//! Both carry a CRC-32 so a damaged file is rejected on open; the segment
//! regions themselves are bounds-checked (see [`SegmentEntry::validate`]) and
//! their blocks are checked as they are read.

use crate::{Error, Result};

pub const MAGIC: &[u8; 4] = b"CPI1";
pub const HEADER_LEN: usize = 64;
pub const SEGMENT_ENTRY_LEN: usize = 96;
/// Bytes per meta record.
pub const META_LEN: u64 = 8;
/// Bytes per signature record.
pub const SIG_LEN: u64 = 64;

/// The file header (64 bytes).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Header {
    pub max_ply: u16,
    pub segments: u16,
    pub max_game_id: u32,
    pub games: u32,
    pub skipped: u32,
    pub postings: u64,
    pub table_off: u64,
    pub file_len: u64,
    pub built_at: i64,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(MAGIC);
        out[8..10].copy_from_slice(&self.max_ply.to_le_bytes());
        out[10..12].copy_from_slice(&self.segments.to_le_bytes());
        out[12..16].copy_from_slice(&self.max_game_id.to_le_bytes());
        out[16..20].copy_from_slice(&self.games.to_le_bytes());
        out[20..24].copy_from_slice(&self.skipped.to_le_bytes());
        out[24..32].copy_from_slice(&self.postings.to_le_bytes());
        out[32..40].copy_from_slice(&self.table_off.to_le_bytes());
        out[40..48].copy_from_slice(&self.file_len.to_le_bytes());
        out[48..56].copy_from_slice(&self.built_at.to_le_bytes());
        let crc = header_crc(&out);
        out[4..8].copy_from_slice(&crc.to_le_bytes());
        out
    }

    /// Checks the magic and the CRC; the offsets are checked by the caller
    /// against the file length.
    pub fn decode(bytes: &[u8]) -> Result<Header> {
        if bytes.len() < HEADER_LEN {
            return Err(Error::corrupt("file too short for a header"));
        }
        let bytes = &bytes[..HEADER_LEN];
        if &bytes[0..4] != MAGIC {
            return Err(Error::corrupt("bad magic (not a CPI1 index)"));
        }
        let crc = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if crc != header_crc(bytes) {
            return Err(Error::corrupt("header checksum mismatch"));
        }
        Ok(Header {
            max_ply: u16::from_le_bytes(bytes[8..10].try_into().unwrap()),
            segments: u16::from_le_bytes(bytes[10..12].try_into().unwrap()),
            max_game_id: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
            games: u32::from_le_bytes(bytes[16..20].try_into().unwrap()),
            skipped: u32::from_le_bytes(bytes[20..24].try_into().unwrap()),
            postings: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
            table_off: u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
            file_len: u64::from_le_bytes(bytes[40..48].try_into().unwrap()),
            built_at: i64::from_le_bytes(bytes[48..56].try_into().unwrap()),
        })
    }
}

/// CRC over the header with its own CRC field zeroed.
fn header_crc(bytes: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(&bytes[0..4]);
    h.update(&[0u8; 4]);
    h.update(&bytes[8..HEADER_LEN]);
    h.finalize()
}

/// One segment's location and counts (96 bytes in the table). All offsets
/// are absolute file offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SegmentEntry {
    pub seg_off: u64,
    pub seg_len: u64,
    pub meta_off: u64,
    pub sig_off: u64,
    pub blocks_off: u64,
    pub blocks_len: u64,
    pub dir_off: u64,
    pub dir_count: u64,
    pub postings: u64,
    pub first_game_id: u32,
    pub last_game_id: u32,
    pub games: u32,
    pub skipped: u32,
}

impl SegmentEntry {
    /// Ids covered: `last - first + 1` (0 for an empty segment).
    pub fn span(&self) -> u64 {
        if self.last_game_id < self.first_game_id {
            0
        } else {
            u64::from(self.last_game_id - self.first_game_id) + 1
        }
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.seg_off.to_le_bytes());
        out.extend_from_slice(&self.seg_len.to_le_bytes());
        out.extend_from_slice(&self.meta_off.to_le_bytes());
        out.extend_from_slice(&self.sig_off.to_le_bytes());
        out.extend_from_slice(&self.blocks_off.to_le_bytes());
        out.extend_from_slice(&self.blocks_len.to_le_bytes());
        out.extend_from_slice(&self.dir_off.to_le_bytes());
        out.extend_from_slice(&self.dir_count.to_le_bytes());
        out.extend_from_slice(&self.postings.to_le_bytes());
        out.extend_from_slice(&self.first_game_id.to_le_bytes());
        out.extend_from_slice(&self.last_game_id.to_le_bytes());
        out.extend_from_slice(&self.games.to_le_bytes());
        out.extend_from_slice(&self.skipped.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
    }

    fn decode(b: &[u8]) -> SegmentEntry {
        let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
        let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        SegmentEntry {
            seg_off: u64_at(0),
            seg_len: u64_at(8),
            meta_off: u64_at(16),
            sig_off: u64_at(24),
            blocks_off: u64_at(32),
            blocks_len: u64_at(40),
            dir_off: u64_at(48),
            dir_count: u64_at(56),
            postings: u64_at(64),
            first_game_id: u32_at(72),
            last_game_id: u32_at(76),
            games: u32_at(80),
            skipped: u32_at(84),
        }
    }

    /// Every region lies inside `[seg_off, seg_off + seg_len)` and the file.
    pub fn validate(&self, file_len: u64) -> Result<()> {
        let end = self
            .seg_off
            .checked_add(self.seg_len)
            .ok_or_else(|| Error::corrupt("segment length overflow"))?;
        if end > file_len {
            return Err(Error::corrupt("segment past the end of the file"));
        }
        let inside = |off: u64, len: u64| -> Result<()> {
            let stop = off
                .checked_add(len)
                .ok_or_else(|| Error::corrupt("segment region overflow"))?;
            if off < self.seg_off || stop > end {
                return Err(Error::corrupt("segment region outside the segment"));
            }
            Ok(())
        };
        let span = self.span();
        inside(self.meta_off, span * META_LEN)?;
        inside(self.sig_off, span * SIG_LEN)?;
        inside(self.blocks_off, self.blocks_len)?;
        let dir_len = self
            .dir_count
            .checked_mul(crate::blocks::DIR_ENTRY as u64)
            .ok_or_else(|| Error::corrupt("directory length overflow"))?;
        inside(self.dir_off, dir_len)?;
        if self.games as u64 > span {
            return Err(Error::corrupt("more games than ids in a segment"));
        }
        Ok(())
    }
}

/// Encodes the segment table: the entries followed by their CRC-32.
pub fn encode_table(segments: &[SegmentEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(segments.len() * SEGMENT_ENTRY_LEN + 4);
    for s in segments {
        s.encode(&mut out);
    }
    let crc = crc32fast::hash(&out);
    out.extend_from_slice(&crc.to_le_bytes());
    out
}

/// Decodes and checks the table of `count` entries at the start of `bytes`.
pub fn decode_table(bytes: &[u8], count: usize) -> Result<Vec<SegmentEntry>> {
    let len = count * SEGMENT_ENTRY_LEN;
    if bytes.len() < len + 4 {
        return Err(Error::corrupt("file too short for the segment table"));
    }
    let crc = u32::from_le_bytes(bytes[len..len + 4].try_into().unwrap());
    if crc != crc32fast::hash(&bytes[..len]) {
        return Err(Error::corrupt("segment table checksum mismatch"));
    }
    Ok((0..count)
        .map(|i| SegmentEntry::decode(&bytes[i * SEGMENT_ENTRY_LEN..(i + 1) * SEGMENT_ENTRY_LEN]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips_and_detects_damage() {
        let h = Header {
            max_ply: 40,
            segments: 2,
            max_game_id: 1234,
            games: 1200,
            skipped: 3,
            postings: 49_000,
            table_off: 1 << 20,
            file_len: (1 << 20) + 200,
            built_at: 1_700_000_000,
        };
        let bytes = h.encode();
        assert_eq!(Header::decode(&bytes).unwrap(), h);
        let mut flipped = bytes;
        flipped[12] ^= 1;
        assert!(matches!(Header::decode(&flipped), Err(Error::Corrupt(_))));
        let mut magic = bytes;
        magic[0] = b'X';
        assert!(matches!(Header::decode(&magic), Err(Error::Corrupt(_))));
        assert!(Header::decode(&bytes[..10]).is_err());
    }

    #[test]
    fn table_round_trips_and_validates_regions() {
        let seg = SegmentEntry {
            seg_off: 64,
            seg_len: 1000,
            meta_off: 64,
            sig_off: 64 + 8 * 10,
            blocks_off: 64 + 72 * 10,
            blocks_len: 100,
            dir_off: 64 + 72 * 10 + 100,
            dir_count: 2,
            postings: 77,
            first_game_id: 1,
            last_game_id: 10,
            games: 9,
            skipped: 1,
        };
        let table = encode_table(&[seg, seg]);
        assert_eq!(table.len(), 2 * SEGMENT_ENTRY_LEN + 4);
        let back = decode_table(&table, 2).unwrap();
        assert_eq!(back, vec![seg, seg]);
        assert_eq!(seg.span(), 10);
        seg.validate(2000).unwrap();
        assert!(seg.validate(500).is_err(), "segment past the file end");
        let mut bad = seg;
        bad.dir_off = 2000;
        assert!(bad.validate(5000).is_err());
        let mut bad = seg;
        bad.games = 11;
        assert!(bad.validate(5000).is_err());
        let mut damaged = table.clone();
        damaged[20] ^= 0x80;
        assert!(decode_table(&damaged, 2).is_err());
        assert!(decode_table(&table[..50], 2).is_err());
        // The range is inclusive: `[0, 0]` is one id, `[1, 0]` is empty.
        assert_eq!(SegmentEntry::default().span(), 1);
        let empty = SegmentEntry {
            first_game_id: 1,
            last_game_id: 0,
            ..SegmentEntry::default()
        };
        assert_eq!(empty.span(), 0);
        empty.validate(64).unwrap();
    }
}
