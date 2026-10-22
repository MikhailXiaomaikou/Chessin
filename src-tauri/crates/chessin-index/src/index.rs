//! Reading an index: a memory-mapped sidecar with its header and segment
//! table checked on open; the postings and records are read lazily.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use memmap2::Mmap;

use crate::blocks::{Blocks, DIR_ENTRY};
use crate::build::META_PRESENT;
use crate::format::{self, Header, SegmentEntry, HEADER_LEN, META_LEN, SIG_LEN};
use crate::hash::Bloom256;
use crate::{
    sidecar_path, Error, Filter, GameMeta, GameResult, IndexStats, MoveStats, Order, Posting,
    Result,
};

/// An open sidecar. Cheap to query from several threads; drop it before
/// replacing the file on Windows.
pub struct Index {
    path: PathBuf,
    mmap: Mmap,
    header: Header,
    segments: Vec<SegmentEntry>,
}

/// A game's signature record (see the crate documentation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signature {
    /// `[white, black]` × `[pawns, knights, bishops, rooks, queens, kings]`
    /// at the end of the game.
    pub pieces: [[u8; 6]; 2],
    /// White pawns still on the second rank (low byte) and black pawns on
    /// the seventh (high byte), as the app's `PawnHome` column.
    pub pawn_home: u16,
    /// Plies in the game's main line.
    pub final_ply: u16,
    /// `[white, black]` weighted material (P1 N3 B3 R5 Q9), as the app's
    /// `WhiteMaterial`/`BlackMaterial` columns.
    pub material: [u8; 2],
    /// Pawn structures seen at plies 10, 20, …, 60.
    pub bloom: Bloom256,
}

impl Index {
    /// Opens the sidecar of `db_path`; [`Error::Missing`] when there is none.
    pub fn open(db_path: &Path) -> Result<Index> {
        Index::open_sidecar(&sidecar_path(db_path))
    }

    /// Opens a sidecar by its own path.
    pub fn open_sidecar(path: &Path) -> Result<Index> {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(Error::Missing),
            Err(e) => return Err(Error::io(path, e)),
        };
        let len = file.metadata().map_err(|e| Error::io(path, e))?.len();
        if len < HEADER_LEN as u64 {
            return Err(Error::corrupt("file too short for a header"));
        }
        // The sidecar is only ever replaced by a rename, never written in
        // place, so the mapping stays consistent.
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| Error::io(path, e))?;
        let header = Header::decode(&mmap)?;
        if header.file_len != len {
            return Err(Error::corrupt(format!(
                "file length {len} does not match the header ({})",
                header.file_len
            )));
        }
        let table_off = usize::try_from(header.table_off)
            .ok()
            .filter(|off| *off >= HEADER_LEN && *off <= mmap.len())
            .ok_or_else(|| Error::corrupt("segment table offset out of range"))?;
        let segments = format::decode_table(&mmap[table_off..], usize::from(header.segments))?;
        let mut prev_last = 0u32;
        for (i, s) in segments.iter().enumerate() {
            s.validate(header.table_off)?;
            if s.span() > 0 && (i > 0 && s.first_game_id <= prev_last) {
                return Err(Error::corrupt("segments overlap or are out of order"));
            }
            if s.span() > 0 {
                prev_last = s.last_game_id;
            }
        }
        Ok(Index {
            path: path.to_path_buf(),
            mmap,
            header,
            segments,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> IndexStats {
        IndexStats {
            games: self.header.games,
            postings: self.header.postings,
            bytes: self.mmap.len() as u64,
            max_game_id: self.header.max_game_id,
            built_at: self.header.built_at,
            max_ply: u32::from(self.header.max_ply),
            skipped: self.header.skipped,
            segments: u32::from(self.header.segments),
        }
    }

    pub fn max_game_id(&self) -> u32 {
        self.header.max_game_id
    }

    pub fn max_ply(&self) -> u16 {
        self.header.max_ply
    }

    pub(crate) fn segments(&self) -> &[SegmentEntry] {
        &self.segments
    }

    /// Every segment's bytes, verbatim, as they sit between the header and
    /// the table.
    pub(crate) fn segment_bytes(&self) -> &[u8] {
        &self.mmap[HEADER_LEN..self.header.table_off as usize]
    }

    pub(crate) fn meta_bytes(&self, s: &SegmentEntry) -> &[u8] {
        let off = s.meta_off as usize;
        &self.mmap[off..off + (s.span() * META_LEN) as usize]
    }

    pub(crate) fn sig_bytes(&self, s: &SegmentEntry) -> &[u8] {
        let off = s.sig_off as usize;
        &self.mmap[off..off + (s.span() * SIG_LEN) as usize]
    }

    pub(crate) fn blocks(&self, s: &SegmentEntry) -> Blocks<'_> {
        let dir = s.dir_off as usize;
        let blocks = s.blocks_off as usize;
        Blocks::new(
            &self.mmap[dir..dir + (s.dir_count as usize) * DIR_ENTRY],
            &self.mmap[blocks..blocks + s.blocks_len as usize],
        )
    }

    /// The segment holding `game_id` and the id's index within it.
    fn locate(&self, game_id: u32) -> Option<(&SegmentEntry, usize)> {
        let s = self
            .segments
            .iter()
            .find(|s| s.span() > 0 && game_id >= s.first_game_id && game_id <= s.last_game_id)?;
        Some((s, (game_id - s.first_game_id) as usize))
    }

    /// The meta of an indexed game; `None` for an unknown or skipped id.
    pub fn meta(&self, game_id: u32) -> Option<GameMeta> {
        let (s, i) = self.locate(game_id)?;
        let rec = &self.meta_bytes(s)[i * META_LEN as usize..(i + 1) * META_LEN as usize];
        if rec[7] & META_PRESENT == 0 {
            return None;
        }
        Some(GameMeta {
            result: GameResult::from_code(rec[0]),
            white_elo: u16::from_le_bytes([rec[1], rec[2]]),
            black_elo: u16::from_le_bytes([rec[3], rec[4]]),
            year: u16::from_le_bytes([rec[5], rec[6]]),
        })
    }

    /// The signature of an indexed game; `None` for an unknown or skipped id.
    pub fn signature(&self, game_id: u32) -> Option<Signature> {
        self.meta(game_id)?;
        let (s, i) = self.locate(game_id)?;
        let rec = &self.sig_bytes(s)[i * SIG_LEN as usize..(i + 1) * SIG_LEN as usize];
        let mut bloom = [0u8; 32];
        bloom.copy_from_slice(&rec[32..64]);
        Some(Signature {
            pieces: [
                rec[0..6].try_into().unwrap(),
                rec[6..12].try_into().unwrap(),
            ],
            pawn_home: u16::from_le_bytes([rec[12], rec[13]]),
            final_ply: u16::from_le_bytes([rec[14], rec[15]]),
            material: [rec[16], rec[17]],
            bloom: Bloom256(bloom),
        })
    }

    /// Every posting with `hash`, in `(game_id, ply)` order.
    pub fn lookup(&self, hash: u64) -> impl Iterator<Item = Posting> + '_ {
        self.segments
            .iter()
            .flat_map(move |s| self.blocks(s).lookup(hash))
    }

    /// The postings of `hash` that pass `filter`, one per game (the first
    /// occurrence when a game repeats the position), with the game's meta.
    fn matching<'a>(
        &'a self,
        hash: u64,
        filter: &'a Filter,
    ) -> impl Iterator<Item = (Posting, GameMeta)> + 'a {
        let mut last_game = None;
        self.lookup(hash).filter_map(move |p| {
            if last_game == Some(p.game_id) {
                return None;
            }
            last_game = Some(p.game_id);
            let meta = self.meta(p.game_id)?;
            filter.accepts(&meta).then_some((p, meta))
        })
    }

    /// How many games that pass `filter` reached the position.
    pub fn count(&self, hash: u64, filter: &Filter) -> u32 {
        self.matching(hash, filter).count() as u32
    }

    /// The moves played from the position by the games that pass `filter`,
    /// most played first. Games that ended there are the entry with
    /// [`NO_MOVE`](crate::NO_MOVE).
    pub fn tree(&self, hash: u64, filter: &Filter) -> Vec<MoveStats> {
        let mut acc: Vec<Option<MoveStats>> = vec![None; 256];
        for (p, meta) in self.matching(hash, filter) {
            let s = acc[usize::from(p.next_move)].get_or_insert_with(|| MoveStats {
                move_code: p.next_move,
                ..MoveStats::default()
            });
            s.games += 1;
            match meta.result {
                GameResult::WhiteWin => s.white += 1,
                GameResult::BlackWin => s.black += 1,
                _ => s.draw += 1,
            }
            match (meta.white_elo, meta.black_elo) {
                (0, 0) => {}
                (w, 0) | (0, w) => {
                    s.elo_sum += u64::from(w);
                    s.elo_games += 1;
                }
                (w, b) => {
                    s.elo_sum += (u64::from(w) + u64::from(b)) / 2;
                    s.elo_games += 1;
                }
            }
            s.last_year = s.last_year.max(meta.year);
        }
        let mut out: Vec<MoveStats> = acc.into_iter().flatten().collect();
        out.sort_by(|a, b| b.games.cmp(&a.games).then(a.move_code.cmp(&b.move_code)));
        out
    }

    /// Up to `limit` games that reached the position and pass `filter`,
    /// best first by `order` (ties: the newest game id first).
    pub fn sample_games(
        &self,
        hash: u64,
        filter: &Filter,
        limit: usize,
        order: Order,
    ) -> Vec<Posting> {
        if limit == 0 {
            return Vec::new();
        }
        let key = |meta: &GameMeta| -> u32 {
            match order {
                Order::ByElo => u32::from(meta.white_elo.max(meta.black_elo)),
                Order::ByYear => u32::from(meta.year),
            }
        };
        let mut heap: BinaryHeap<Reverse<(u32, u32, PostingKey)>> =
            BinaryHeap::with_capacity(limit + 1);
        for (p, meta) in self.matching(hash, filter) {
            let entry = Reverse((key(&meta), p.game_id, PostingKey(p)));
            if heap.len() < limit {
                heap.push(entry);
            } else if heap.peek().is_some_and(|min| entry < *min) {
                heap.pop();
                heap.push(entry);
            }
        }
        let mut best: Vec<_> = heap.into_iter().map(|Reverse(e)| e).collect();
        best.sort_by(|a, b| b.cmp(a));
        best.into_iter().map(|(_, _, PostingKey(p))| p).collect()
    }

    /// The ids of the games whose pawn-structure bloom filter may contain
    /// `pawn_hash` (see [`crate::hash::pawn_hash`]). False positives happen;
    /// a structure that only existed between the sampled plies is missed.
    pub fn pawn_candidates(&self, pawn_hash: u64) -> impl Iterator<Item = u32> + '_ {
        self.segments
            .iter()
            .filter(|s| s.span() > 0)
            .flat_map(move |s| {
                let meta = self.meta_bytes(s);
                let sigs = self.sig_bytes(s);
                (0..s.span() as usize).filter_map(move |i| {
                    if meta[i * META_LEN as usize + 7] & META_PRESENT == 0 {
                        return None;
                    }
                    let rec = &sigs[i * SIG_LEN as usize..(i + 1) * SIG_LEN as usize];
                    let mut bloom = [0u8; 32];
                    bloom.copy_from_slice(&rec[32..64]);
                    Bloom256(bloom)
                        .may_contain(pawn_hash)
                        .then_some(s.first_game_id + i as u32)
                })
            })
    }
}

/// A posting ordered only by its game id, so the sample heap ignores the
/// hash and move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PostingKey(Posting);

impl PartialOrd for PostingKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PostingKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.game_id.cmp(&other.0.game_id)
    }
}
