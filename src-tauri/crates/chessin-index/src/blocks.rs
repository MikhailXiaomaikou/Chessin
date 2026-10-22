//! The posting blocks and their directory (the "blocks" and "directory"
//! regions of a segment), plus the k-way merge used by builds and updates.
//!
//! Postings arrive sorted by `(hash, game_id, ply)` and are cut into blocks
//! of [`BLOCK_POSTINGS`]. A block is:
//!
//! ```text
//! count u8            postings in the block (1..=128)
//! hw u8               byte width of the hash deltas (0..=8)
//! ga u8               byte width of absolute game ids (0..=4)
//! gd u8               byte width of game-id deltas (0..=4)
//! flags [u8; 16]      bit i set: posting i starts a new hash
//! body                per posting i:
//!                       hash delta from the previous posting  (hw bytes, only if i > 0 and new)
//!                       game id, absolute (ga bytes) if new, else delta from the previous (gd bytes)
//!                       ply u8, next move u8
//! ```
//!
//! Posting 0 is always "new"; its hash is the block's directory entry. The
//! directory is one `(first hash u64, block offset u64)` per block.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::Posting;

/// Postings per block (the flags bitmap is 16 bytes).
pub const BLOCK_POSTINGS: usize = 128;
const FLAG_BYTES: usize = BLOCK_POSTINGS / 8;
const BLOCK_HEADER: usize = 4 + FLAG_BYTES;
/// Bytes per directory entry.
pub const DIR_ENTRY: usize = 16;

fn width(v: u64) -> u8 {
    if v == 0 {
        0
    } else {
        ((64 - v.leading_zeros()) as u8).div_ceil(8)
    }
}

fn put(out: &mut Vec<u8>, v: u64, width: u8) {
    out.extend_from_slice(&v.to_le_bytes()[..usize::from(width)]);
}

fn get(bytes: &[u8], width: u8) -> u64 {
    let mut buf = [0u8; 8];
    buf[..usize::from(width)].copy_from_slice(&bytes[..usize::from(width)]);
    u64::from_le_bytes(buf)
}

/// Encodes sorted postings into blocks; the caller drains the output with
/// [`BlockWriter::take_output`] as often as it likes and finishes with
/// [`BlockWriter::finish`].
#[derive(Default)]
pub struct BlockWriter {
    pending: Vec<Posting>,
    out: Vec<u8>,
    dir: Vec<u8>,
    /// Bytes handed out through `take_output` so far: the offset of `out[0]`.
    taken: u64,
    postings: u64,
    last: Option<Posting>,
}

impl BlockWriter {
    pub fn new() -> BlockWriter {
        BlockWriter {
            pending: Vec::with_capacity(BLOCK_POSTINGS),
            ..Default::default()
        }
    }

    /// `p` must not sort before the previous posting.
    pub fn push(&mut self, p: Posting) {
        debug_assert!(
            self.last.is_none_or(|last| last <= p),
            "postings out of order"
        );
        self.last = Some(p);
        self.pending.push(p);
        self.postings += 1;
        if self.pending.len() == BLOCK_POSTINGS {
            self.encode_pending();
        }
    }

    /// The encoded bytes so far, to be written right after the previous ones.
    pub fn take_output(&mut self) -> Vec<u8> {
        self.taken += self.out.len() as u64;
        std::mem::take(&mut self.out)
    }

    pub fn pending_bytes(&self) -> usize {
        self.out.len()
    }

    /// The remaining block bytes, the directory bytes and the posting count.
    pub fn finish(mut self) -> (Vec<u8>, Vec<u8>, u64) {
        if !self.pending.is_empty() {
            self.encode_pending();
        }
        let rest = self.take_output();
        (rest, self.dir, self.postings)
    }

    fn encode_pending(&mut self) {
        let block = &self.pending;
        let first = block[0];
        let offset = self.taken + self.out.len() as u64;
        self.dir.extend_from_slice(&first.hash.to_le_bytes());
        self.dir.extend_from_slice(&offset.to_le_bytes());

        let mut flags = [0u8; FLAG_BYTES];
        let (mut max_hd, mut max_ga, mut max_gd) = (0u64, u64::from(first.game_id), 0u64);
        flags[0] |= 1;
        for (i, w) in block.windows(2).enumerate() {
            let (prev, cur) = (w[0], w[1]);
            let i = i + 1;
            if cur.hash != prev.hash {
                flags[i / 8] |= 1 << (i % 8);
                max_hd = max_hd.max(cur.hash - prev.hash);
                max_ga = max_ga.max(u64::from(cur.game_id));
            } else {
                max_gd = max_gd.max(u64::from(cur.game_id - prev.game_id));
            }
        }
        let (hw, ga, gd) = (width(max_hd), width(max_ga), width(max_gd));

        let out = &mut self.out;
        out.push(block.len() as u8);
        out.push(hw);
        out.push(ga);
        out.push(gd);
        out.extend_from_slice(&flags);
        let mut prev = first;
        for (i, cur) in block.iter().enumerate() {
            let new = i == 0 || cur.hash != prev.hash;
            if i > 0 && new {
                put(out, cur.hash - prev.hash, hw);
            }
            if new {
                put(out, u64::from(cur.game_id), ga);
            } else {
                put(out, u64::from(cur.game_id - prev.game_id), gd);
            }
            out.push(cur.ply as u8);
            out.push(cur.next_move);
            prev = *cur;
        }
        self.pending.clear();
    }
}

/// Read access to a directory + blocks pair.
#[derive(Clone, Copy)]
pub struct Blocks<'a> {
    dir: &'a [u8],
    data: &'a [u8],
}

impl<'a> Blocks<'a> {
    /// `dir.len()` must be a multiple of [`DIR_ENTRY`]; block offsets are
    /// checked when a block is read.
    pub fn new(dir: &'a [u8], data: &'a [u8]) -> Blocks<'a> {
        debug_assert_eq!(dir.len() % DIR_ENTRY, 0);
        Blocks { dir, data }
    }

    pub fn block_count(&self) -> usize {
        self.dir.len() / DIR_ENTRY
    }

    pub fn first_hash(&self, i: usize) -> u64 {
        let at = i * DIR_ENTRY;
        u64::from_le_bytes(self.dir[at..at + 8].try_into().unwrap())
    }

    fn offset(&self, i: usize) -> u64 {
        let at = i * DIR_ENTRY + 8;
        u64::from_le_bytes(self.dir[at..at + 8].try_into().unwrap())
    }

    /// The postings of block `i`; `None` when it is out of range or corrupt.
    pub fn block(&self, i: usize) -> Option<BlockIter<'a>> {
        if i >= self.block_count() {
            return None;
        }
        let start = usize::try_from(self.offset(i)).ok()?;
        BlockIter::new(self.data.get(start..)?, self.first_hash(i))
    }

    /// Every posting, in order. Stops early at a corrupt block.
    pub fn iter_all(&self) -> AllIter<'a> {
        AllIter {
            blocks: *self,
            next_block: 0,
            current: None,
        }
    }

    /// The postings with `hash`, in `(game_id, ply)` order. Stops early at a
    /// corrupt block.
    pub fn lookup(&self, hash: u64) -> LookupIter<'a> {
        let n = self.block_count();
        // The last block whose first hash is below `hash` may hold the first
        // postings of `hash`; the run then continues through the blocks whose
        // first hash equals `hash`.
        let mut lo = 0usize;
        let mut hi = n;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if self.first_hash(mid) < hash {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let start = lo.saturating_sub(1);
        LookupIter {
            blocks: *self,
            hash,
            next_block: start,
            current: None,
            done: n == 0,
        }
    }
}

/// The postings of one block.
pub struct BlockIter<'a> {
    body: &'a [u8],
    flags: &'a [u8],
    pos: usize,
    count: usize,
    i: usize,
    hw: u8,
    ga: u8,
    gd: u8,
    hash: u64,
    game: u64,
}

impl<'a> BlockIter<'a> {
    fn new(bytes: &'a [u8], first_hash: u64) -> Option<BlockIter<'a>> {
        if bytes.len() < BLOCK_HEADER {
            return None;
        }
        let count = usize::from(bytes[0]);
        let (hw, ga, gd) = (bytes[1], bytes[2], bytes[3]);
        if count == 0 || count > BLOCK_POSTINGS || hw > 8 || ga > 4 || gd > 4 {
            return None;
        }
        let flags = &bytes[4..BLOCK_HEADER];
        // Posting 0 must be flagged new and carries no hash delta.
        if flags[0] & 1 == 0 {
            return None;
        }
        let new = (0..count)
            .filter(|i| flags[i / 8] & (1 << (i % 8)) != 0)
            .count();
        let size = (new - 1) * usize::from(hw)
            + new * usize::from(ga)
            + (count - new) * usize::from(gd)
            + 2 * count;
        let body = bytes.get(BLOCK_HEADER..BLOCK_HEADER + size)?;
        Some(BlockIter {
            body,
            flags,
            pos: 0,
            count,
            i: 0,
            hw,
            ga,
            gd,
            hash: first_hash,
            game: 0,
        })
    }

    fn read(&mut self, width: u8) -> u64 {
        let v = get(&self.body[self.pos..], width);
        self.pos += usize::from(width);
        v
    }
}

impl Iterator for BlockIter<'_> {
    type Item = Posting;

    fn next(&mut self) -> Option<Posting> {
        if self.i >= self.count {
            return None;
        }
        let i = self.i;
        let new = i == 0 || self.flags[i / 8] & (1 << (i % 8)) != 0;
        if i > 0 && new {
            self.hash = self.hash.wrapping_add(self.read(self.hw));
        }
        if new {
            self.game = self.read(self.ga);
        } else {
            self.game = self.game.wrapping_add(self.read(self.gd));
        }
        let ply = u16::from(self.body[self.pos]);
        let next_move = self.body[self.pos + 1];
        self.pos += 2;
        self.i += 1;
        Some(Posting {
            hash: self.hash,
            game_id: self.game as u32,
            ply,
            next_move,
        })
    }
}

pub struct AllIter<'a> {
    blocks: Blocks<'a>,
    next_block: usize,
    current: Option<BlockIter<'a>>,
}

impl Iterator for AllIter<'_> {
    type Item = Posting;

    fn next(&mut self) -> Option<Posting> {
        loop {
            if let Some(p) = self.current.as_mut().and_then(|it| it.next()) {
                return Some(p);
            }
            if self.next_block >= self.blocks.block_count() {
                return None;
            }
            self.current = Some(self.blocks.block(self.next_block)?);
            self.next_block += 1;
        }
    }
}

pub struct LookupIter<'a> {
    blocks: Blocks<'a>,
    hash: u64,
    next_block: usize,
    current: Option<BlockIter<'a>>,
    done: bool,
}

impl Iterator for LookupIter<'_> {
    type Item = Posting;

    fn next(&mut self) -> Option<Posting> {
        loop {
            if self.done {
                return None;
            }
            if let Some(it) = self.current.as_mut() {
                for p in it.by_ref() {
                    if p.hash == self.hash {
                        return Some(p);
                    }
                    if p.hash > self.hash {
                        self.done = true;
                        return None;
                    }
                }
                self.current = None;
                // Continue only into blocks that start with this hash.
                if self.next_block >= self.blocks.block_count()
                    || self.blocks.first_hash(self.next_block) != self.hash
                {
                    self.done = true;
                    return None;
                }
            }
            match self.blocks.block(self.next_block) {
                Some(it) => self.current = Some(it),
                None => {
                    self.done = true;
                    return None;
                }
            }
            self.next_block += 1;
        }
    }
}

/// Merges sorted posting streams into one sorted stream.
pub struct Merge<I: Iterator<Item = Posting>> {
    sources: Vec<I>,
    heap: BinaryHeap<Reverse<(Posting, usize)>>,
}

impl<I: Iterator<Item = Posting>> Merge<I> {
    pub fn new(mut sources: Vec<I>) -> Merge<I> {
        let mut heap = BinaryHeap::with_capacity(sources.len());
        for (i, src) in sources.iter_mut().enumerate() {
            if let Some(p) = src.next() {
                heap.push(Reverse((p, i)));
            }
        }
        Merge { sources, heap }
    }
}

impl<I: Iterator<Item = Posting>> Iterator for Merge<I> {
    type Item = Posting;

    fn next(&mut self) -> Option<Posting> {
        let Reverse((p, i)) = self.heap.pop()?;
        if let Some(next) = self.sources[i].next() {
            self.heap.push(Reverse((next, i)));
        }
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moves::rng::Rng;

    fn random_postings(rng: &mut Rng, n: usize, distinct_hashes: usize) -> Vec<Posting> {
        let hashes: Vec<u64> = (0..distinct_hashes).map(|_| rng.next_u64()).collect();
        let mut v: Vec<Posting> = (0..n)
            .map(|_| Posting {
                hash: hashes[rng.below(hashes.len())],
                game_id: rng.below(5_000_000) as u32,
                ply: rng.below(41) as u16,
                next_move: rng.below(256) as u8,
            })
            .collect();
        v.sort();
        v
    }

    fn encode(postings: &[Posting]) -> (Vec<u8>, Vec<u8>, u64) {
        let mut w = BlockWriter::new();
        let mut data = Vec::new();
        for (i, p) in postings.iter().enumerate() {
            w.push(*p);
            if i % 300 == 0 {
                data.extend(w.take_output());
            }
        }
        let (rest, dir, count) = w.finish();
        data.extend(rest);
        (data, dir, count)
    }

    #[test]
    fn round_trips_and_looks_up_every_hash() {
        let mut rng = Rng(7);
        for (n, distinct) in [
            (0, 1),
            (1, 1),
            (127, 3),
            (128, 1),
            (129, 129),
            (5000, 40),
            (5000, 4000),
        ] {
            let postings = random_postings(&mut rng, n, distinct);
            let (data, dir, count) = encode(&postings);
            assert_eq!(count, n as u64);
            let blocks = Blocks::new(&dir, &data);
            assert_eq!(blocks.block_count(), n.div_ceil(BLOCK_POSTINGS));
            assert_eq!(blocks.iter_all().collect::<Vec<_>>(), postings);
            let mut hashes: Vec<u64> = postings.iter().map(|p| p.hash).collect();
            hashes.dedup();
            for h in hashes {
                let expect: Vec<Posting> =
                    postings.iter().copied().filter(|p| p.hash == h).collect();
                assert_eq!(blocks.lookup(h).collect::<Vec<_>>(), expect);
            }
            assert_eq!(blocks.lookup(0).count(), 0);
            assert_eq!(blocks.lookup(u64::MAX).count(), 0);
            for _ in 0..50 {
                let h = rng.next_u64();
                let expect = postings.iter().filter(|p| p.hash == h).count();
                assert_eq!(blocks.lookup(h).count(), expect);
            }
        }
    }

    #[test]
    fn shared_hashes_are_cheap() {
        let postings: Vec<Posting> = (0..100_000u32)
            .map(|g| Posting {
                hash: 0x463b96181691fc9c,
                game_id: g * 3 + 1,
                ply: 0,
                next_move: 12,
            })
            .collect();
        let (data, dir, _) = encode(&postings);
        let per_posting = (data.len() + dir.len()) as f64 / postings.len() as f64;
        assert!(per_posting < 3.5, "{per_posting} bytes per posting");
        let blocks = Blocks::new(&dir, &data);
        assert_eq!(blocks.lookup(0x463b96181691fc9c).count(), postings.len());
        assert_eq!(blocks.lookup(0x463b96181691fc9d).count(), 0);
        assert_eq!(blocks.lookup(0x463b96181691fc9b).count(), 0);
    }

    #[test]
    fn corrupt_blocks_end_the_iteration_instead_of_panicking() {
        let mut rng = Rng(3);
        let postings = random_postings(&mut rng, 1000, 100);
        let (data, dir, _) = encode(&postings);
        // Truncated data: the last block is unreadable, the others are fine.
        let short = &data[..data.len() - 5];
        let blocks = Blocks::new(&dir, short);
        let got = blocks.iter_all().count();
        assert!(
            got < postings.len() && got >= postings.len() - BLOCK_POSTINGS,
            "{got}"
        );
        // A directory offset past the data.
        let mut bad_dir = dir.clone();
        let last = bad_dir.len() - 8;
        bad_dir[last..].copy_from_slice(&u64::MAX.to_le_bytes());
        let blocks = Blocks::new(&bad_dir, &data);
        assert!(blocks.block(blocks.block_count() - 1).is_none());
        assert!(blocks.iter_all().count() < postings.len());
        // A corrupt width byte.
        let mut bad = data.clone();
        bad[1] = 9;
        assert!(Blocks::new(&dir, &bad).block(0).is_none());
        assert_eq!(Blocks::new(&dir, &bad).lookup(postings[0].hash).count(), 0);
    }

    #[test]
    fn merge_interleaves_sorted_streams() {
        let mut rng = Rng(11);
        let a = random_postings(&mut rng, 500, 20);
        let b = random_postings(&mut rng, 700, 20);
        let c: Vec<Posting> = Vec::new();
        let mut expect = [a.clone(), b.clone()].concat();
        expect.sort();
        let merged: Vec<Posting> =
            Merge::new(vec![a.into_iter(), b.into_iter(), c.into_iter()]).collect();
        assert_eq!(merged, expect);
    }
}
