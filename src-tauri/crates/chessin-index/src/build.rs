//! Building and updating the sidecar from a database.
//!
//! Games are read from SQLite in batches, decoded in parallel (rayon), and
//! their postings go to sorted *run files* next to the sidecar; the runs are
//! then merged into the segment's blocks, so memory stays bounded however
//! large the database is. Everything is written to `<sidecar>.tmp` and
//! renamed over the sidecar at the end; a failure or a cancel leaves the old
//! sidecar untouched and removes the scratch files.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use memmap2::Mmap;
use rayon::prelude::*;
use rusqlite::{types::ValueRef, Connection, OpenFlags, Statement};
use shakmaty::{Chess, Position};

use crate::blocks::{BlockWriter, Blocks, Merge, DIR_ENTRY};
use crate::format::{self, Header, SegmentEntry, HEADER_LEN, META_LEN, SIG_LEN};
use crate::hash::{pawn_hash, position_hash, Bloom256, BLOOM_PLIES};
use crate::index::Index;
use crate::moves::{decode_move, mainline_moves, start_position};
use crate::{
    sidecar_path, Error, GameResult, IndexStats, Posting, Result, DEFAULT_MAX_PLY, MAX_SEGMENTS,
    MAX_SUPPORTED_PLY, NO_MOVE,
};

/// Games fetched from SQLite and decoded per round.
const BATCH_GAMES: usize = 2048;
/// Postings buffered in memory before they are sorted into a run file
/// (16 bytes each: 64 MiB).
const RUN_POSTINGS: usize = 4 << 20;
/// Output buffered before a write.
const FLUSH_BYTES: usize = 1 << 20;
/// How long to wait for a database lock held by the app.
const BUSY_TIMEOUT: Duration = Duration::from_secs(30);

/// Options of [`build`] and [`update`].
pub struct BuildOptions<F> {
    /// Plies indexed per game, at most [`MAX_SUPPORTED_PLY`].
    pub max_ply: u16,
    /// Called with `(games done, games total)` after every batch and once at
    /// the end with `(total, total)`.
    pub progress: F,
}

impl BuildOptions<fn(u64, u64)> {
    /// [`DEFAULT_MAX_PLY`] plies and no progress reporting.
    pub fn new(max_ply: u16) -> BuildOptions<fn(u64, u64)> {
        BuildOptions {
            max_ply,
            progress: |_, _| {},
        }
    }
}

impl Default for BuildOptions<fn(u64, u64)> {
    fn default() -> Self {
        BuildOptions::new(DEFAULT_MAX_PLY)
    }
}

impl<F> BuildOptions<F> {
    pub fn with_progress<G: FnMut(u64, u64)>(self, progress: G) -> BuildOptions<G> {
        BuildOptions {
            max_ply: self.max_ply,
            progress,
        }
    }
}

/// Indexes every game of `db_path` into a fresh sidecar, replacing any
/// existing one. `cancel` is polled between batches; when it is set the
/// build stops with [`Error::Cancelled`] and the old sidecar is kept.
pub fn build<F: FnMut(u64, u64)>(
    db_path: &Path,
    opts: BuildOptions<F>,
    cancel: &AtomicBool,
) -> Result<IndexStats> {
    build_from(db_path, opts, cancel, None)
}

/// Brings the sidecar up to date: games with an id above the indexed maximum
/// go into a new segment, and the segments are merged into one when there
/// would be more than [`MAX_SEGMENTS`]. Without a usable sidecar, or with a
/// different `max_ply`, this is a full [`build`]. Games deleted from the
/// database are not removed (see the crate documentation).
pub fn update<F: FnMut(u64, u64)>(
    db_path: &Path,
    opts: BuildOptions<F>,
    cancel: &AtomicBool,
) -> Result<IndexStats> {
    let existing = match Index::open(db_path) {
        Ok(index) if index.max_ply() == opts.max_ply => index,
        _ => return build_from(db_path, opts, cancel, None),
    };
    let conn = open_db(db_path, BUSY_TIMEOUT)?;
    let max_id: Option<i64> = conn.query_row("SELECT MAX(ID) FROM Games", [], |r| r.get(0))?;
    drop(conn);
    if max_id.is_none_or(|max| max <= i64::from(existing.max_game_id())) {
        return Ok(existing.status());
    }
    build_from(db_path, opts, cancel, Some(existing))
}

fn build_from<F: FnMut(u64, u64)>(
    db_path: &Path,
    mut opts: BuildOptions<F>,
    cancel: &AtomicBool,
    existing: Option<Index>,
) -> Result<IndexStats> {
    if opts.max_ply > MAX_SUPPORTED_PLY {
        return Err(Error::InvalidArgument(format!(
            "max_ply {} exceeds {MAX_SUPPORTED_PLY}",
            opts.max_ply
        )));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    let sidecar = sidecar_path(db_path);
    let tmp = scratch_path(&sidecar, "tmp");
    let merged = scratch_path(&sidecar, "merge");
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&merged);

    let result = write_tmp(db_path, &sidecar, &tmp, &mut opts, cancel, existing);
    let segments = match result {
        Ok(segments) => segments,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };

    let final_src = if segments > MAX_SEGMENTS {
        if let Err(e) = merge_file(&tmp, &merged, cancel) {
            let _ = fs::remove_file(&tmp);
            let _ = fs::remove_file(&merged);
            return Err(e);
        }
        let _ = fs::remove_file(&tmp);
        merged
    } else {
        tmp
    };
    fs::rename(&final_src, &sidecar).map_err(|e| Error::io(&sidecar, e))?;
    Ok(Index::open_sidecar(&sidecar)?.status())
}

/// Writes the whole index to `tmp` and returns how many segments it has.
fn write_tmp<F: FnMut(u64, u64)>(
    db_path: &Path,
    sidecar: &Path,
    tmp: &Path,
    opts: &mut BuildOptions<F>,
    cancel: &AtomicBool,
    existing: Option<Index>,
) -> Result<usize> {
    let conn = open_db(db_path, BUSY_TIMEOUT)?;
    let after_id = existing.as_ref().map_or(0, |i| i.max_game_id());
    let (total, first, last) = count_games(&conn, after_id)?;

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(|e| Error::io(tmp, e))?;
    let io = |e: io::Error| Error::io(tmp, e);
    file.write_all(&[0u8; HEADER_LEN]).map_err(io)?;

    let mut segments: Vec<SegmentEntry> = Vec::new();
    if let Some(index) = &existing {
        // The old segments keep their absolute offsets: they are copied to
        // the same place, right after the header.
        file.write_all(index.segment_bytes()).map_err(io)?;
        segments.extend_from_slice(index.segments());
    }
    if total > 0 {
        let (first, last) = (first.expect("games exist"), last.expect("games exist"));
        let seg = write_segment(
            &mut file, tmp, sidecar, &conn, after_id, total, first, last, opts, cancel,
        )?;
        segments.push(seg);
    }
    (opts.progress)(total, total);
    drop(conn);
    // The old mapping must be gone before the rename replaces the file.
    drop(existing);
    finish_file(&mut file, tmp, &segments, opts.max_ply)?;
    Ok(segments.len())
}

/// Appends the segment table and writes the header; the file is synced.
fn finish_file(
    file: &mut File,
    path: &Path,
    segments: &[SegmentEntry],
    max_ply: u16,
) -> Result<()> {
    let io = |e: io::Error| Error::io(path, e);
    let table_off = file.seek(SeekFrom::End(0)).map_err(io)?;
    let table = format::encode_table(segments);
    file.write_all(&table).map_err(io)?;
    let file_len = table_off + table.len() as u64;
    let header = Header {
        max_ply,
        segments: u16::try_from(segments.len())
            .map_err(|_| Error::InvalidArgument("too many segments".into()))?,
        max_game_id: segments.iter().map(|s| s.last_game_id).max().unwrap_or(0),
        games: segments.iter().map(|s| s.games).sum(),
        skipped: segments.iter().map(|s| s.skipped).sum(),
        postings: segments.iter().map(|s| s.postings).sum(),
        table_off,
        file_len,
        built_at: now(),
    };
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    file.write_all(&header.encode()).map_err(io)?;
    file.sync_all().map_err(io)
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn scratch_path(sidecar: &Path, suffix: &str) -> PathBuf {
    let mut name = sidecar.as_os_str().to_owned();
    name.push(".");
    name.push(suffix);
    PathBuf::from(name)
}

fn align8(n: u64) -> u64 {
    (n + 7) & !7
}

pub(crate) fn open_db(db_path: &Path, busy_timeout: Duration) -> Result<Connection> {
    if !db_path.is_file() {
        return Err(Error::io(
            db_path,
            io::Error::new(io::ErrorKind::NotFound, "no such database"),
        ));
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(busy_timeout)?;
    Ok(conn)
}

/// `(count, min id, max id)` of the games with an id above `after_id`.
fn count_games(conn: &Connection, after_id: u32) -> Result<(u64, Option<u32>, Option<u32>)> {
    let (count, min, max): (i64, Option<i64>, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), MIN(ID), MAX(ID) FROM Games WHERE ID > ?1",
        [i64::from(after_id)],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let id = |v: Option<i64>| -> Result<Option<u32>> {
        v.map(|v| {
            u32::try_from(v)
                .ok()
                .filter(|v| *v < u32::MAX)
                .ok_or_else(|| Error::InvalidArgument(format!("game id {v} out of range")))
        })
        .transpose()
    };
    Ok((count.max(0) as u64, id(min)?, id(max)?))
}

/// A `Games` row, as much of it as the index needs.
struct RawGame {
    id: u32,
    result: GameResult,
    white_elo: u16,
    black_elo: u16,
    year: u16,
    fen: Option<String>,
    moves: Vec<u8>,
}

pub(crate) fn text_of(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(bytes) => {
            let s = String::from_utf8_lossy(bytes);
            let s = s.trim();
            (!s.is_empty()).then(|| s.to_string())
        }
        _ => None,
    }
}

fn u16_of(v: ValueRef<'_>) -> u16 {
    let n = match v {
        ValueRef::Integer(i) => i,
        ValueRef::Real(f) => f as i64,
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).trim().parse().unwrap_or(0),
        _ => 0,
    };
    n.clamp(0, i64::from(u16::MAX)) as u16
}

fn year_of(v: ValueRef<'_>) -> u16 {
    match v {
        ValueRef::Text(bytes) => {
            let s = String::from_utf8_lossy(bytes);
            let digits: String = s.trim().chars().take(4).collect();
            if digits.len() == 4 {
                digits.parse().unwrap_or(0)
            } else {
                0
            }
        }
        other => u16_of(other),
    }
}

fn fetch_batch(stmt: &mut Statement<'_>, after: i64, limit: usize) -> Result<Vec<RawGame>> {
    let mut rows = stmt.query(rusqlite::params![after, limit as i64])?;
    let mut out = Vec::with_capacity(limit);
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let id = u32::try_from(id)
            .ok()
            .filter(|v| *v < u32::MAX)
            .ok_or_else(|| Error::InvalidArgument(format!("game id {id} out of range")))?;
        let result = text_of(row.get_ref(1)?);
        out.push(RawGame {
            id,
            result: GameResult::from_pgn(result.as_deref()),
            white_elo: u16_of(row.get_ref(2)?),
            black_elo: u16_of(row.get_ref(3)?),
            year: year_of(row.get_ref(4)?),
            fen: text_of(row.get_ref(5)?),
            moves: match row.get_ref(6)? {
                ValueRef::Blob(b) => b.to_vec(),
                _ => Vec::new(),
            },
        });
    }
    Ok(out)
}

/// What one game contributes: `None` when its moves do not decode.
struct Decoded {
    id: u32,
    body: Option<Body>,
}

struct Body {
    meta: [u8; META_LEN as usize],
    sig: [u8; SIG_LEN as usize],
    postings: Vec<Posting>,
}

fn decode_game(g: &RawGame, max_ply: u16) -> Decoded {
    let skipped = Decoded {
        id: g.id,
        body: None,
    };
    let Ok(mut pos) = start_position(g.fen.as_deref()) else {
        return skipped;
    };
    let codes: Vec<u8> = mainline_moves(&g.moves).collect();
    let mut postings = Vec::with_capacity((codes.len() + 1).min(usize::from(max_ply) + 1));
    let mut bloom = Bloom256::default();
    postings.push(Posting {
        hash: position_hash(&pos),
        game_id: g.id,
        ply: 0,
        next_move: codes.first().copied().unwrap_or(NO_MOVE),
    });
    for (i, code) in codes.iter().enumerate() {
        let Some(m) = decode_move(*code, &pos) else {
            return skipped;
        };
        pos.play_unchecked(&m);
        let ply = i + 1;
        if ply <= usize::from(max_ply) {
            postings.push(Posting {
                hash: position_hash(&pos),
                game_id: g.id,
                ply: ply as u16,
                next_move: codes.get(i + 1).copied().unwrap_or(NO_MOVE),
            });
        }
        if ply <= usize::from(BLOOM_PLIES[BLOOM_PLIES.len() - 1])
            && BLOOM_PLIES.contains(&(ply as u16))
        {
            bloom.insert(pawn_hash(pos.board()));
        }
    }
    Decoded {
        id: g.id,
        body: Some(Body {
            meta: encode_meta(g),
            sig: encode_signature(&pos, codes.len(), &bloom),
            postings,
        }),
    }
}

/// Bit 0 of the flags byte: the game is indexed.
pub(crate) const META_PRESENT: u8 = 1;

fn encode_meta(g: &RawGame) -> [u8; META_LEN as usize] {
    let mut out = [0u8; META_LEN as usize];
    out[0] = g.result.code();
    out[1..3].copy_from_slice(&g.white_elo.to_le_bytes());
    out[3..5].copy_from_slice(&g.black_elo.to_le_bytes());
    out[5..7].copy_from_slice(&g.year.to_le_bytes());
    out[7] = META_PRESENT;
    out
}

/// The pawn-home bits as the app computes them: white pawns still on the
/// second rank in the low byte, black pawns on the seventh in the high byte.
pub(crate) fn pawn_home(board: &shakmaty::Board) -> u16 {
    let white = (board.white() & board.pawns()).0;
    let black = (board.black() & board.pawns()).0;
    ((white >> 8) as u8) as u16 | (((black >> 48) as u8) as u16) << 8
}

fn encode_signature(pos: &Chess, final_ply: usize, bloom: &Bloom256) -> [u8; SIG_LEN as usize] {
    let board = pos.board();
    let material = board.material();
    let mut out = [0u8; SIG_LEN as usize];
    for (base, side) in [(0usize, material.white), (6, material.black)] {
        out[base] = side.pawn;
        out[base + 1] = side.knight;
        out[base + 2] = side.bishop;
        out[base + 3] = side.rook;
        out[base + 4] = side.queen;
        out[base + 5] = side.king;
    }
    out[12..14].copy_from_slice(&pawn_home(board).to_le_bytes());
    out[14..16].copy_from_slice(&(final_ply.min(usize::from(u16::MAX)) as u16).to_le_bytes());
    let weighted = |m: shakmaty::ByRole<u8>| -> u8 {
        u32::from(m.pawn)
            .saturating_add(u32::from(m.knight) * 3)
            .saturating_add(u32::from(m.bishop) * 3)
            .saturating_add(u32::from(m.rook) * 5)
            .saturating_add(u32::from(m.queen) * 9)
            .min(255) as u8
    };
    out[16] = weighted(material.white);
    out[17] = weighted(material.black);
    out[32..64].copy_from_slice(&bloom.0);
    out
}

/// Buffered positional writes into a fixed-record region indexed by game id.
struct RegionWriter {
    rec: usize,
    next_id: u32,
    buf: Vec<u8>,
    /// File offset of `buf[0]`.
    buf_at: u64,
}

impl RegionWriter {
    fn new(base: u64, rec: usize, first_id: u32) -> RegionWriter {
        RegionWriter {
            rec,
            next_id: first_id,
            buf: Vec::with_capacity(FLUSH_BYTES + rec),
            buf_at: base,
        }
    }

    /// `id` must not be below the previous one; skipped ids stay zero.
    fn put(&mut self, file: &mut File, id: u32, rec: &[u8]) -> io::Result<()> {
        debug_assert_eq!(rec.len(), self.rec);
        debug_assert!(id >= self.next_id);
        let gap = u64::from(id - self.next_id);
        if gap > 0 {
            self.flush(file)?;
            self.buf_at += gap * self.rec as u64;
        }
        self.buf.extend_from_slice(rec);
        self.next_id = id + 1;
        if self.buf.len() >= FLUSH_BYTES {
            self.flush(file)?;
        }
        Ok(())
    }

    fn flush(&mut self, file: &mut File) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.buf_at))?;
        file.write_all(&self.buf)?;
        self.buf_at += self.buf.len() as u64;
        self.buf.clear();
        Ok(())
    }
}

/// Sorted run files; removed on drop.
struct RunFiles {
    base: PathBuf,
    paths: Vec<PathBuf>,
}

impl RunFiles {
    fn new(sidecar: &Path) -> RunFiles {
        RunFiles {
            base: sidecar.to_path_buf(),
            paths: Vec::new(),
        }
    }

    fn write(&mut self, chunk: &mut Vec<Posting>) -> Result<()> {
        chunk.par_sort_unstable();
        let mut writer = BlockWriter::new();
        for p in chunk.drain(..) {
            writer.push(p);
        }
        let (data, dir, _) = writer.finish();
        let path = scratch_path(&self.base, &format!("run{}", self.paths.len()));
        let io = |e: io::Error| Error::io(&path, e);
        let mut file = File::create(&path).map_err(io)?;
        file.write_all(&(dir.len() as u64).to_le_bytes())
            .map_err(io)?;
        file.write_all(&dir).map_err(io)?;
        file.write_all(&data).map_err(io)?;
        self.paths.push(path.clone());
        Ok(())
    }

    fn open(&self) -> Result<Vec<Mmap>> {
        self.paths
            .iter()
            .map(|path| {
                let file = File::open(path).map_err(|e| Error::io(path, e))?;
                // The run is a private scratch file nobody else writes to.
                unsafe { Mmap::map(&file) }.map_err(|e| Error::io(path, e))
            })
            .collect()
    }
}

impl Drop for RunFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn run_blocks(run: &[u8]) -> Result<Blocks<'_>> {
    let dir_len = run
        .get(..8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .ok_or_else(|| Error::corrupt("short run file"))?;
    let dir_end = usize::try_from(8 + dir_len).map_err(|_| Error::corrupt("run file"))?;
    if dir_end > run.len() || dir_len % DIR_ENTRY as u64 != 0 {
        return Err(Error::corrupt("run file directory"));
    }
    Ok(Blocks::new(&run[8..dir_end], &run[dir_end..]))
}

/// Reads the games above `after_id`, writes a segment at the end of `file`
/// and returns its entry.
#[allow(clippy::too_many_arguments)]
fn write_segment<F: FnMut(u64, u64)>(
    file: &mut File,
    tmp: &Path,
    sidecar: &Path,
    conn: &Connection,
    after_id: u32,
    total: u64,
    first: u32,
    last: u32,
    opts: &mut BuildOptions<F>,
    cancel: &AtomicBool,
) -> Result<SegmentEntry> {
    let io = |e: io::Error| Error::io(tmp, e);
    let end = file.seek(SeekFrom::End(0)).map_err(io)?;
    let seg_off = align8(end);
    file.write_all(&vec![0u8; (seg_off - end) as usize])
        .map_err(io)?;
    let span = u64::from(last - first) + 1;
    let meta_off = seg_off;
    let sig_off = meta_off + span * META_LEN;
    let blocks_off = sig_off + span * SIG_LEN;
    file.set_len(blocks_off).map_err(io)?;

    let mut meta = RegionWriter::new(meta_off, META_LEN as usize, first);
    let mut sig = RegionWriter::new(sig_off, SIG_LEN as usize, first);
    let mut runs = RunFiles::new(sidecar);
    let mut chunk: Vec<Posting> = Vec::new();
    let (mut games, mut skipped, mut done) = (0u32, 0u32, 0u64);
    let max_ply = opts.max_ply;

    let mut stmt = conn.prepare(
        "SELECT ID, Result, WhiteElo, BlackElo, Date, FEN, Moves FROM Games \
         WHERE ID > ?1 ORDER BY ID LIMIT ?2",
    )?;
    let mut cursor = i64::from(after_id);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let raw = fetch_batch(&mut stmt, cursor, BATCH_GAMES)?;
        let Some(last_row) = raw.last() else {
            break;
        };
        cursor = i64::from(last_row.id);
        let decoded: Vec<Decoded> = raw.par_iter().map(|g| decode_game(g, max_ply)).collect();
        for d in decoded {
            match d.body {
                Some(body) => {
                    games += 1;
                    meta.put(file, d.id, &body.meta).map_err(io)?;
                    sig.put(file, d.id, &body.sig).map_err(io)?;
                    chunk.extend(body.postings);
                }
                None => skipped += 1,
            }
        }
        done += raw.len() as u64;
        (opts.progress)(done.min(total), total);
        if chunk.len() >= RUN_POSTINGS {
            runs.write(&mut chunk)?;
        }
    }
    if !chunk.is_empty() || runs.paths.is_empty() {
        runs.write(&mut chunk)?;
    }
    meta.flush(file).map_err(io)?;
    sig.flush(file).map_err(io)?;

    let maps = runs.open()?;
    let mut sources = Vec::with_capacity(maps.len());
    for m in &maps {
        sources.push(run_blocks(m)?.iter_all());
    }
    let (blocks_len, dir_off, dir_count, postings) =
        write_blocks(file, tmp, blocks_off, Merge::new(sources), cancel)?;
    let seg_len = file.stream_position().map_err(io)? - seg_off;
    drop(maps);
    drop(runs);
    Ok(SegmentEntry {
        seg_off,
        seg_len,
        meta_off,
        sig_off,
        blocks_off,
        blocks_len,
        dir_off,
        dir_count,
        postings,
        first_game_id: first,
        last_game_id: last,
        games,
        skipped,
    })
}

/// Writes sorted postings as blocks at `blocks_off`, then the directory;
/// returns `(blocks_len, dir_off, dir_count, postings)`.
fn write_blocks(
    file: &mut File,
    path: &Path,
    blocks_off: u64,
    postings: impl Iterator<Item = Posting>,
    cancel: &AtomicBool,
) -> Result<(u64, u64, u64, u64)> {
    let io = |e: io::Error| Error::io(path, e);
    file.seek(SeekFrom::Start(blocks_off)).map_err(io)?;
    let mut writer = BlockWriter::new();
    for (i, p) in postings.enumerate() {
        writer.push(p);
        if writer.pending_bytes() >= FLUSH_BYTES {
            file.write_all(&writer.take_output()).map_err(io)?;
        }
        if i % (1 << 20) == 0 && cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
    }
    let (rest, dir, count) = writer.finish();
    file.write_all(&rest).map_err(io)?;
    let dir_off = file.stream_position().map_err(io)?;
    file.write_all(&dir).map_err(io)?;
    Ok((
        dir_off - blocks_off,
        dir_off,
        (dir.len() / DIR_ENTRY) as u64,
        count,
    ))
}

/// Rewrites the index at `src` as a single segment at `dst`.
fn merge_file(src: &Path, dst: &Path, cancel: &AtomicBool) -> Result<()> {
    let index = Index::open_sidecar(src)?;
    let segments = index.segments();
    let io = |e: io::Error| Error::io(dst, e);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(io)?;
    file.write_all(&[0u8; HEADER_LEN]).map_err(io)?;

    let non_empty: Vec<&SegmentEntry> = segments.iter().filter(|s| s.span() > 0).collect();
    let mut entries = Vec::new();
    if let (Some(first_seg), Some(last_seg)) = (non_empty.first(), non_empty.last()) {
        let (first, last) = (first_seg.first_game_id, last_seg.last_game_id);
        let span = u64::from(last - first) + 1;
        let seg_off = align8(HEADER_LEN as u64);
        let meta_off = seg_off;
        let sig_off = meta_off + span * META_LEN;
        let blocks_off = sig_off + span * SIG_LEN;
        file.set_len(blocks_off).map_err(io)?;
        for s in &non_empty {
            let at = u64::from(s.first_game_id - first);
            file.seek(SeekFrom::Start(meta_off + at * META_LEN))
                .map_err(io)?;
            file.write_all(index.meta_bytes(s)).map_err(io)?;
            file.seek(SeekFrom::Start(sig_off + at * SIG_LEN))
                .map_err(io)?;
            file.write_all(index.sig_bytes(s)).map_err(io)?;
        }
        let sources: Vec<_> = segments
            .iter()
            .map(|s| index.blocks(s).iter_all())
            .collect();
        let (blocks_len, dir_off, dir_count, postings) =
            write_blocks(&mut file, dst, blocks_off, Merge::new(sources), cancel)?;
        let seg_len = file.stream_position().map_err(io)? - seg_off;
        entries.push(SegmentEntry {
            seg_off,
            seg_len,
            meta_off,
            sig_off,
            blocks_off,
            blocks_len,
            dir_off,
            dir_count,
            postings,
            first_game_id: first,
            last_game_id: last,
            games: segments.iter().map(|s| s.games).sum(),
            skipped: segments.iter().map(|s| s.skipped).sum(),
        });
    }
    let max_ply = index.max_ply();
    drop(index);
    finish_file(&mut file, dst, &entries, max_ply)
}
