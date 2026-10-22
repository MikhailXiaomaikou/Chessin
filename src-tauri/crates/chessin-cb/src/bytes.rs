//! Bounds-checked little helpers for the fixed-layout records of the formats.
//!
//! In CBH v1 `.cbh`, `.cbg` and `.cba` are big-endian and the entity files are
//! little-endian; 2CBH is little-endian apart from a few headers. Every accessor
//! returns `None` when the slice is too short, so a truncated or corrupt file
//! turns into a reported error instead of a panic.

/// Sequential reader over a byte slice.
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    /// Bytes consumed so far.
    pub fn position(&self) -> usize {
        self.pos
    }

    /// The bytes not consumed yet.
    pub fn rest(&self) -> &'a [u8] {
        self.data.get(self.pos..).unwrap_or(&[])
    }

    pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        if end > self.data.len() {
            return None;
        }
        let s = &self.data[self.pos..end];
        self.pos = end;
        Some(s)
    }

    pub fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }

    pub fn be_u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| u16::from_be_bytes([s[0], s[1]]))
    }

    pub fn be_u24(&mut self) -> Option<u32> {
        self.take(3)
            .map(|s| u32::from_be_bytes([0, s[0], s[1], s[2]]))
    }

    /// Signed 24-bit big-endian integer.
    pub fn be_i24(&mut self) -> Option<i32> {
        self.be_u24().map(|v| ((v << 8) as i32) >> 8)
    }

    pub fn be_u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }

    pub fn be_i32(&mut self) -> Option<i32> {
        self.be_u32().map(|v| v as i32)
    }

    pub fn le_u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }

    pub fn le_i16(&mut self) -> Option<i16> {
        self.le_u16().map(|v| v as i16)
    }

    pub fn le_u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    pub fn le_i32(&mut self) -> Option<i32> {
        self.le_u32().map(|v| v as i32)
    }

    pub fn le_u64(&mut self) -> Option<u64> {
        self.take(8)
            .map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
    }

    pub fn le_i64(&mut self) -> Option<i64> {
        self.le_u64().map(|v| v as i64)
    }

    pub fn be_u64(&mut self) -> Option<u64> {
        self.take(8)
            .map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
    }

    pub fn be_i64(&mut self) -> Option<i64> {
        self.be_u64().map(|v| v as i64)
    }
}

/// Little-endian `i32` at `offset`.
pub fn le_i32_at(data: &[u8], offset: usize) -> Option<i32> {
    let s = data.get(offset..offset.checked_add(4)?)?;
    Some(i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Little-endian `u32` at `offset`.
pub fn le_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    le_i32_at(data, offset).map(|v| v as u32)
}

/// A zero-terminated string in a fixed-size field: the bytes before the first
/// zero, or the whole field when there is none.
pub fn c_field(field: &[u8]) -> &[u8] {
    match field.iter().position(|&b| b == 0) {
        Some(i) => &field[..i],
        None => field,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_big_endian_widths() {
        let data = [0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x80];
        let mut r = Reader::new(&data);
        assert_eq!(r.be_u16(), Some(0x0102));
        assert_eq!(r.be_u24(), Some(0x0304ff));
        assert_eq!(r.be_i24(), Some(-1));
        assert_eq!(r.remaining(), 1);
        assert_eq!(r.u8(), Some(0x80));
        assert_eq!(r.u8(), None);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn signed_24_bit_sign_extends() {
        let mut r = Reader::new(&[0x80, 0x00, 0x00, 0x7f, 0xff, 0xff]);
        assert_eq!(r.be_i24(), Some(-8_388_608));
        assert_eq!(r.be_i24(), Some(8_388_607));
    }

    #[test]
    fn reads_little_endian_widths() {
        let data = [0x34, 0x12, 0xfe, 0xff, 0x78, 0x56, 0x34, 0x12];
        let mut r = Reader::new(&data);
        assert_eq!(r.le_u16(), Some(0x1234));
        assert_eq!(r.position(), 2);
        assert_eq!(r.le_i16(), Some(-2));
        assert_eq!(le_u32_at(&data, 4), Some(0x1234_5678));
        assert_eq!(le_i32_at(&data, 4), Some(0x1234_5678));
        assert_eq!(le_i32_at(&data, 6), None);
        let mut r = Reader::new(&data);
        assert_eq!(r.le_i32(), Some(-0x0001_edcc));
        assert_eq!(r.le_u32(), Some(0x1234_5678));
        assert_eq!(r.le_u32(), None);
        let wide = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut r = Reader::new(&wide);
        assert_eq!(r.le_i64(), Some(-1));
        assert_eq!(r.le_u64(), Some(1));
        let mut r = Reader::new(&wide);
        assert_eq!(r.be_i64(), Some(-1));
        assert_eq!(r.be_u64(), Some(1 << 56));
        assert_eq!(r.be_u64(), None);
    }

    #[test]
    fn c_field_stops_at_first_zero() {
        assert_eq!(c_field(b"abc\0xyz"), b"abc");
        assert_eq!(c_field(b"abc"), b"abc");
        assert_eq!(c_field(b"\0abc"), b"");
    }
}
