//! `.2lid`: the entities a game refers to — players (who are also the
//! annotators), tournaments, sources, teams and game tags.
//!
//! The file header is big-endian; everything after it is little-endian.
//! Entities are stored in blocks: block *i* holds entity *i* of every type,
//! each in a fixed-size container whose size the header gives, so the file is
//! read in one sequential pass and only the decoded text is kept. A record
//! starts with the number of bytes that follow it; 0 marks an unused
//! container. Deleted entities keep their container and are found by
//! following the per-type linked list that starts in the header.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use crate::bytes::{le_i32_at, Reader};
use crate::header::CbDate;
use crate::text::TextDecoder;

/// Size of the file header ChessBase writes; the header names its own size.
pub const HEADER_SIZE: usize = 184;
/// Number of entity types ChessBase writes.
pub const TYPE_COUNT: usize = 6;
/// The container sizes ChessBase uses, by type. A reader takes them from the
/// header; these are for writers and tests.
pub const STANDARD_CONTAINERS: [u32; TYPE_COUNT] = [1024, 1120, 220, 1024, 314, 532];
/// The eight bytes every deleted record holds after its length.
pub const DELETED_MAGIC: [u8; 8] = [0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99];

pub const TYPE_PLAYER: usize = 0;
pub const TYPE_TOURNAMENT: usize = 1;
pub const TYPE_SOURCE: usize = 2;
pub const TYPE_TEAM: usize = 4;
pub const TYPE_GAME_TAG: usize = 5;

const TYPE_NAMES: [&str; TYPE_COUNT] = [
    "player",
    "tournament",
    "source",
    "type 3",
    "team",
    "game tag",
];

/// Largest block a reader accepts, as a guard against a corrupt header.
const MAX_BLOCK_SIZE: u64 = 64 << 20;

/// The big-endian file header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LidHeader {
    pub header_size: u32,
    pub container_sizes: Vec<u32>,
    pub counts: Vec<i64>,
    /// Id of the first deleted entity of each type, −1 if none.
    pub first_deleted: Vec<i64>,
}

impl LidHeader {
    pub fn block_size(&self) -> u64 {
        self.container_sizes.iter().map(|&c| u64::from(c)).sum()
    }

    /// Where type `t`'s container starts within a block.
    pub fn container_offset(&self, t: usize) -> u64 {
        self.container_sizes[..t]
            .iter()
            .map(|&c| u64::from(c))
            .sum()
    }
}

/// Parses the file header; `buf` must hold at least the header's own size.
pub fn parse_lid_header(buf: &[u8]) -> Result<LidHeader, String> {
    let mut r = Reader::new(buf);
    let header_size = r.be_u32().ok_or("entity file is too short for a header")?;
    let type_count = r.be_u32().ok_or("entity file is too short for a header")?;
    if !(1..=64).contains(&type_count) {
        return Err(format!(
            "entity file header names {type_count} entity types"
        ));
    }
    if header_size as usize > buf.len() || (header_size as usize) < 8 + 20 * type_count as usize {
        return Err(format!(
            "entity file header size {header_size} does not fit {type_count} types"
        ));
    }
    let mut container_sizes = Vec::with_capacity(type_count as usize);
    let mut counts = Vec::with_capacity(type_count as usize);
    let mut first_deleted = Vec::with_capacity(type_count as usize);
    for t in 0..type_count as usize {
        let container = r.be_u32().unwrap_or(0);
        let count = r.be_i64().unwrap_or(-1);
        let deleted = r.be_i64().unwrap_or(-1);
        if container == 0 || u64::from(container) > MAX_BLOCK_SIZE {
            return Err(format!(
                "entity type {t} has a container size of {container} bytes"
            ));
        }
        if count < 0 {
            return Err(format!("entity type {t} has a negative count"));
        }
        container_sizes.push(container);
        counts.push(count);
        first_deleted.push(deleted);
    }
    Ok(LidHeader {
        header_size,
        container_sizes,
        counts,
        first_deleted,
    })
}

/// What a container holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Container<'a> {
    /// Length 0: no entity with this id for this type.
    Unused,
    /// A deleted entity, with the id of the next deleted one (−1 at the end).
    Deleted { next: i64 },
    /// The bytes after the length field of a live record.
    Record(&'a [u8]),
}

/// Classifies one container by its length field.
pub fn classify(container: &[u8]) -> Result<Container<'_>, String> {
    let len = le_i32_at(container, 0).ok_or("container is shorter than a length field")?;
    if len == 0 {
        return Ok(Container::Unused);
    }
    if len < 0 || 4 + len as usize > container.len() {
        return Err(format!(
            "record length {len} does not fit a container of {} bytes",
            container.len()
        ));
    }
    let data = &container[4..4 + len as usize];
    if len == 16 && data[..8] == DELETED_MAGIC {
        let mut r = Reader::new(&data[8..]);
        return Ok(Container::Deleted {
            next: r.le_i64().unwrap_or(-1),
        });
    }
    Ok(Container::Record(data))
}

/// A string as the format stores it: `int` byte count, then the bytes.
fn string<'a>(r: &mut Reader<'a>) -> Option<&'a [u8]> {
    let len = r.le_i32()?;
    if len < 0 {
        return None;
    }
    r.take(len as usize)
}

/// A player (annotators are players too). `S` is `Vec<u8>` while the file is
/// being read and `String` afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Player<S = String> {
    pub last: S,
    pub first: S,
    /// Id in ChessBase's player database: −1 not looked up, 0 no match.
    pub chessbase_id: i32,
    /// −1 not looked up, 0 none.
    pub fide_id: i64,
}

impl Player<Vec<u8>> {
    fn parse(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        let last = string(&mut r)?.to_vec();
        let first = string(&mut r)?.to_vec();
        let _ = r.le_i32()?;
        let _ = r.le_i32()?;
        let chessbase_id = r.le_i32()?;
        let _size = r.le_i32()?;
        let fide_id = r.le_i64()?;
        Some(Player {
            last,
            first,
            chessbase_id,
            fide_id,
        })
    }

    fn strings(&self) -> [&[u8]; 2] {
        [&self.last, &self.first]
    }

    fn decode(self, dec: &TextDecoder) -> Player {
        Player {
            last: dec.decode(&self.last).trim().to_string(),
            first: dec.decode(&self.first).trim().to_string(),
            chessbase_id: self.chessbase_id,
            fide_id: self.fide_id,
        }
    }
}

impl Player {
    /// `Last, First` as PGN writes names; `Last` alone when the first name is
    /// empty; `?` when both are (a placeholder entity).
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
pub struct Tournament<S = String> {
    pub title: S,
    pub place: S,
    pub start: CbDate,
    pub end: CbDate,
    /// 1 single game, 2 match, 3 round robin, 4 swiss, 5 team, 6 knockout,
    /// 7 simultaneous, 8 scheveningen.
    pub kind: u8,
    /// 0 normal, 1 blitz, 2 rapid, 3 correspondence (bits 5-7 of the type byte).
    pub time_control: u8,
    pub team_event: bool,
    /// Nation at the time of the tournament.
    pub nation: u8,
    pub category: u8,
    pub rounds: u8,
}

impl Tournament<Vec<u8>> {
    fn parse(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        let place = string(&mut r)?.to_vec();
        let title = string(&mut r)?.to_vec();
        let start = CbDate::from_packed(r.le_u32()?);
        let type_byte = r.u8()?;
        let team_event = r.u8()? & 1 != 0;
        let nation = r.u8()?;
        let _ = r.u8()?;
        let category = r.u8()?;
        let _flags = r.u8()?;
        let rounds = r.u8()?;
        let _ = r.u8()?;
        let _latitude = r.take(4)?;
        let _longitude = r.take(4)?;
        let _nation_today = r.u8()?;
        let _ = r.take(37)?;
        let tiebreaks = r.le_u16()?;
        let _rules = r.take(2 * usize::from(tiebreaks))?;
        let end = CbDate::from_packed(r.le_u32()?);
        Some(Tournament {
            title,
            place,
            start,
            end,
            kind: type_byte & 0x1f,
            time_control: type_byte >> 5,
            team_event,
            nation,
            category,
            rounds,
        })
    }

    fn strings(&self) -> [&[u8]; 2] {
        [&self.title, &self.place]
    }

    fn decode(self, dec: &TextDecoder) -> Tournament {
        Tournament {
            title: dec.decode(&self.title).trim().to_string(),
            place: dec.decode(&self.place).trim().to_string(),
            start: self.start,
            end: self.end,
            kind: self.kind,
            time_control: self.time_control,
            team_event: self.team_event,
            nation: self.nation,
            category: self.category,
            rounds: self.rounds,
        }
    }
}

/// A source: the publication the game was taken from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Source<S = String> {
    pub title: S,
    pub publisher: S,
    pub publication_date: CbDate,
    pub date: CbDate,
    pub version: i16,
    /// 0 unset, 1 high, 2 medium, 3 low.
    pub quality: i16,
}

impl Source<Vec<u8>> {
    fn parse(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        let title = string(&mut r)?.to_vec();
        let publisher = string(&mut r)?.to_vec();
        let publication_date = CbDate::from_packed(r.le_u32()?);
        let date = CbDate::from_packed(r.le_u32()?);
        let version = r.le_i16()?;
        let quality = r.le_i16()?;
        Some(Source {
            title,
            publisher,
            publication_date,
            date,
            version,
            quality,
        })
    }

    fn strings(&self) -> [&[u8]; 2] {
        [&self.title, &self.publisher]
    }

    fn decode(self, dec: &TextDecoder) -> Source {
        Source {
            title: dec.decode(&self.title).trim().to_string(),
            publisher: dec.decode(&self.publisher).trim().to_string(),
            publication_date: self.publication_date,
            date: self.date,
            version: self.version,
            quality: self.quality,
        }
    }
}

/// A team.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Team<S = String> {
    pub title: S,
    pub number: u8,
    /// The year denotes a season spanning two years.
    pub season: bool,
    pub year: i16,
    pub nation: u8,
}

impl Team<Vec<u8>> {
    fn parse(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        let title = string(&mut r)?.to_vec();
        let number = r.u8()?;
        let season = r.u8()? & 1 != 0;
        let year = r.le_i16()?;
        let nation = r.u8()?;
        Some(Team {
            title,
            number,
            season,
            year,
            nation,
        })
    }

    fn strings(&self) -> [&[u8]; 1] {
        [&self.title]
    }

    fn decode(self, dec: &TextDecoder) -> Team {
        Team {
            title: dec.decode(&self.title).trim().to_string(),
            number: self.number,
            season: self.season,
            year: self.year,
            nation: self.nation,
        }
    }
}

/// A game tag, or the title of a guiding text or analysis: one title per
/// language (a nation code). An entity with no titles is the placeholder a
/// game refers to when it has no tag.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GameTag<S = String> {
    pub titles: Vec<(i32, S)>,
}

impl GameTag<Vec<u8>> {
    fn parse(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        let count = r.le_i32()?;
        if count < 0 {
            return None;
        }
        let mut titles = Vec::new();
        for _ in 0..count {
            let language = r.le_i32()?;
            let title = string(&mut r)?.to_vec();
            titles.push((language, title));
        }
        Some(GameTag { titles })
    }

    fn strings(&self) -> impl Iterator<Item = &[u8]> {
        self.titles.iter().map(|(_, t)| t.as_slice())
    }

    fn decode(self, dec: &TextDecoder) -> GameTag {
        GameTag {
            titles: self
                .titles
                .into_iter()
                .map(|(l, t)| (l, dec.decode(&t).trim().to_string()))
                .collect(),
        }
    }
}

impl GameTag {
    /// The first non-empty title, in any language.
    pub fn any_title(&self) -> Option<&str> {
        self.titles
            .iter()
            .map(|(_, t)| t.as_str())
            .find(|t| !t.is_empty())
    }
}

/// Every entity of a database, by type and id. A `None` is an unused
/// container, a deleted entity or a record that could not be parsed.
#[derive(Debug, Clone)]
pub struct EntityTable {
    pub players: Vec<Option<Player>>,
    pub tournaments: Vec<Option<Tournament>>,
    pub sources: Vec<Option<Source>>,
    pub teams: Vec<Option<Team>>,
    pub game_tags: Vec<Option<GameTag>>,
    /// Decoder chosen from the entity strings; used for annotation text too.
    pub decoder: TextDecoder,
}

/// Everything of one type read in the sequential pass, before decoding.
struct RawColumn<T> {
    records: Vec<Option<T>>,
    deleted_next: HashMap<i64, i64>,
    failed: u32,
}

impl<T> RawColumn<T> {
    fn new() -> Self {
        RawColumn {
            records: Vec::new(),
            deleted_next: HashMap::new(),
            failed: 0,
        }
    }

    fn push(&mut self, id: i64, container: &[u8], parse: impl Fn(&[u8]) -> Option<T>) {
        match classify(container) {
            Ok(Container::Unused) => self.records.push(None),
            Ok(Container::Deleted { next }) => {
                self.deleted_next.insert(id, next);
                self.records.push(None);
            }
            Ok(Container::Record(data)) => match parse(data) {
                Some(rec) => self.records.push(Some(rec)),
                None => {
                    self.failed += 1;
                    self.records.push(None);
                }
            },
            Err(_) => {
                self.failed += 1;
                self.records.push(None);
            }
        }
    }

    /// Follows the deleted list from the header: everything on it is deleted,
    /// whatever its record looks like. Returns a problem with the list, if any.
    fn apply_deleted_list(&mut self, first: i64) -> Option<String> {
        let mut id = first;
        let mut steps = 0usize;
        while id != -1 {
            if id < 0 || id as usize >= self.records.len() {
                return Some(format!(
                    "deleted-entity list points at id {id}, out of range"
                ));
            }
            steps += 1;
            if steps > self.records.len() {
                return Some("deleted-entity list loops".to_string());
            }
            match self.deleted_next.get(&id) {
                Some(&next) => id = next,
                None => {
                    self.records[id as usize] = None;
                    return Some(format!(
                        "deleted-entity list reaches id {id}, which is not a deleted record"
                    ));
                }
            }
        }
        None
    }
}

fn decode_all<R, T>(
    v: Vec<Option<R>>,
    dec: &TextDecoder,
    f: impl Fn(R, &TextDecoder) -> T,
) -> Vec<Option<T>> {
    v.into_iter().map(|e| e.map(|e| f(e, dec))).collect()
}

/// Reads as much of `buf` as the reader has. Returns the number of bytes read.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

impl EntityTable {
    /// An empty table: every lookup fails, which callers treat as "not set".
    pub fn empty() -> Self {
        EntityTable {
            players: Vec::new(),
            tournaments: Vec::new(),
            sources: Vec::new(),
            teams: Vec::new(),
            game_tags: Vec::new(),
            decoder: TextDecoder::default(),
        }
    }

    /// Loads a `.2lid` file. Problems with single records become warnings;
    /// a header that is not an entity header is an error.
    pub fn load(path: &Path, warnings: &mut Vec<String>) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        Self::read_from(std::io::BufReader::new(file), warnings)
    }

    /// Parses an in-memory `.2lid` file.
    pub fn parse(bytes: &[u8], warnings: &mut Vec<String>) -> Result<Self, String> {
        Self::read_from(bytes, warnings)
    }

    fn read_from(mut r: impl Read, warnings: &mut Vec<String>) -> Result<Self, String> {
        let mut head = [0u8; 8];
        if read_full(&mut r, &mut head).map_err(|e| e.to_string())? < 8 {
            return Err("entity file is too short for a header".to_string());
        }
        let header_size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        if !(8..=65536).contains(&header_size) {
            return Err(format!(
                "entity file header size {header_size} is not plausible"
            ));
        }
        let mut header_bytes = vec![0u8; header_size];
        header_bytes[..8].copy_from_slice(&head);
        if read_full(&mut r, &mut header_bytes[8..]).map_err(|e| e.to_string())? < header_size - 8 {
            return Err("entity file is shorter than its header".to_string());
        }
        let header = parse_lid_header(&header_bytes)?;
        let block_size = header.block_size();
        if block_size == 0 || block_size > MAX_BLOCK_SIZE {
            return Err(format!("entity block size {block_size} is not plausible"));
        }
        let block_size = block_size as usize;
        let blocks = header.counts.iter().copied().max().unwrap_or(0);
        if blocks > i64::from(u32::MAX) {
            return Err(format!("entity file announces {blocks} entities"));
        }
        let blocks = blocks as usize;
        let offsets: Vec<usize> = (0..header.container_sizes.len())
            .map(|t| header.container_offset(t) as usize)
            .collect();
        let sizes: Vec<usize> = header.container_sizes.iter().map(|&c| c as usize).collect();
        let typed = |t: usize| -> Option<(usize, usize, i64)> {
            (t < sizes.len()).then(|| (offsets[t], sizes[t], header.counts[t]))
        };

        let mut players: RawColumn<Player<Vec<u8>>> = RawColumn::new();
        let mut tournaments: RawColumn<Tournament<Vec<u8>>> = RawColumn::new();
        let mut sources: RawColumn<Source<Vec<u8>>> = RawColumn::new();
        let mut teams: RawColumn<Team<Vec<u8>>> = RawColumn::new();
        let mut game_tags: RawColumn<GameTag<Vec<u8>>> = RawColumn::new();
        let mut block = vec![0u8; block_size];
        let mut truncated_at = None;
        for i in 0..blocks {
            let got = read_full(&mut r, &mut block).map_err(|e| e.to_string())?;
            if got == 0 {
                truncated_at = Some(i);
                break;
            }
            block[got..].fill(0);
            let id = i as i64;
            let slot = |t: usize, column: &mut dyn FnMut(i64, &[u8])| {
                if let Some((off, size, count)) = typed(t) {
                    if id < count {
                        let end = (off + size).min(got);
                        if off < end {
                            column(id, &block[off..end]);
                        } else {
                            column(id, &[]);
                        }
                    }
                }
            };
            slot(TYPE_PLAYER, &mut |id, c| players.push(id, c, Player::parse));
            slot(TYPE_TOURNAMENT, &mut |id, c| {
                tournaments.push(id, c, Tournament::parse)
            });
            slot(TYPE_SOURCE, &mut |id, c| sources.push(id, c, Source::parse));
            slot(TYPE_TEAM, &mut |id, c| teams.push(id, c, Team::parse));
            slot(TYPE_GAME_TAG, &mut |id, c| {
                game_tags.push(id, c, GameTag::parse)
            });
            if got < block_size {
                truncated_at = Some(i + 1);
                break;
            }
        }
        if let Some(at) = truncated_at {
            if at < blocks {
                warnings.push(format!(
                    "the entity file ends after {at} of {blocks} blocks; later entities will be blank"
                ));
            }
        }
        for (t, (first, failed)) in [
            (
                TYPE_PLAYER,
                (header.first_deleted.get(TYPE_PLAYER), players.failed),
            ),
            (
                TYPE_TOURNAMENT,
                (
                    header.first_deleted.get(TYPE_TOURNAMENT),
                    tournaments.failed,
                ),
            ),
            (
                TYPE_SOURCE,
                (header.first_deleted.get(TYPE_SOURCE), sources.failed),
            ),
            (
                TYPE_TEAM,
                (header.first_deleted.get(TYPE_TEAM), teams.failed),
            ),
            (
                TYPE_GAME_TAG,
                (header.first_deleted.get(TYPE_GAME_TAG), game_tags.failed),
            ),
        ] {
            if failed > 0 {
                warnings.push(format!(
                    "{failed} {} record(s) could not be parsed and will be blank",
                    TYPE_NAMES[t]
                ));
            }
            let problem = match (t, first.copied().unwrap_or(-1)) {
                (_, -1) => None,
                (TYPE_PLAYER, f) => players.apply_deleted_list(f),
                (TYPE_TOURNAMENT, f) => tournaments.apply_deleted_list(f),
                (TYPE_SOURCE, f) => sources.apply_deleted_list(f),
                (TYPE_TEAM, f) => teams.apply_deleted_list(f),
                (_, f) => game_tags.apply_deleted_list(f),
            };
            if let Some(p) = problem {
                warnings.push(format!("{} entities: {p}", TYPE_NAMES[t]));
            }
        }
        let decoder = TextDecoder::detect(
            players
                .records
                .iter()
                .flatten()
                .flat_map(|p| p.strings())
                .chain(
                    tournaments
                        .records
                        .iter()
                        .flatten()
                        .flat_map(|t| t.strings()),
                )
                .chain(sources.records.iter().flatten().flat_map(|s| s.strings()))
                .chain(teams.records.iter().flatten().flat_map(|t| t.strings()))
                .chain(game_tags.records.iter().flatten().flat_map(|g| g.strings())),
        );
        Ok(EntityTable {
            players: decode_all(players.records, &decoder, Player::decode),
            tournaments: decode_all(tournaments.records, &decoder, Tournament::decode),
            sources: decode_all(sources.records, &decoder, Source::decode),
            teams: decode_all(teams.records, &decoder, Team::decode),
            game_tags: decode_all(game_tags.records, &decoder, GameTag::decode),
            decoder,
        })
    }

    fn get<T>(v: &[Option<T>], id: i64) -> Option<&T> {
        usize::try_from(id).ok().and_then(|i| v.get(i)?.as_ref())
    }

    pub fn player(&self, id: i64) -> Option<&Player> {
        Self::get(&self.players, id)
    }

    pub fn tournament(&self, id: i64) -> Option<&Tournament> {
        Self::get(&self.tournaments, id)
    }

    pub fn source(&self, id: i64) -> Option<&Source> {
        Self::get(&self.sources, id)
    }

    pub fn team(&self, id: i64) -> Option<&Team> {
        Self::get(&self.teams, id)
    }

    pub fn game_tag(&self, id: i64) -> Option<&GameTag> {
        Self::get(&self.game_tags, id)
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    /// A big-endian `.2lid` header with the given per-type counts and deleted
    /// list heads.
    pub fn lid_header(containers: &[u32], counts: &[i64], first_deleted: &[i64]) -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(&(HEADER_SIZE as u32).to_be_bytes());
        h.extend_from_slice(&(containers.len() as u32).to_be_bytes());
        for t in 0..containers.len() {
            h.extend_from_slice(&containers[t].to_be_bytes());
            h.extend_from_slice(&counts[t].to_be_bytes());
            h.extend_from_slice(&first_deleted[t].to_be_bytes());
        }
        h.resize(0x80, 0);
        for pair in [-1i32, 0, 1, 2, 3, 4, 5] {
            h.extend_from_slice(&pair.to_be_bytes());
            h.extend_from_slice(&1i32.to_be_bytes());
        }
        h.resize(HEADER_SIZE, 0);
        h
    }

    /// A record: the length field, then the bytes.
    pub fn record(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as i32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    pub fn deleted_record(next: i64) -> Vec<u8> {
        let mut body = DELETED_MAGIC.to_vec();
        body.extend_from_slice(&next.to_le_bytes());
        record(&body)
    }

    pub fn string(s: &[u8]) -> Vec<u8> {
        let mut v = (s.len() as i32).to_le_bytes().to_vec();
        v.extend_from_slice(s);
        v
    }

    pub fn player_body(last: &[u8], first: &[u8]) -> Vec<u8> {
        let mut b = string(last);
        b.extend(string(first));
        b.extend_from_slice(&0i32.to_le_bytes());
        b.extend_from_slice(&0i32.to_le_bytes());
        b.extend_from_slice(&(-1i32).to_le_bytes());
        b.extend_from_slice(&8i32.to_le_bytes());
        b.extend_from_slice(&(-1i64).to_le_bytes());
        b
    }

    pub fn tournament_body(
        title: &[u8],
        place: &[u8],
        start: u32,
        nation: u8,
        rounds: u8,
    ) -> Vec<u8> {
        let mut b = string(place);
        b.extend(string(title));
        b.extend_from_slice(&start.to_le_bytes());
        b.extend_from_slice(&[3, 0, nation, 0, 0, 3, rounds, 0]);
        b.extend_from_slice(&[0u8; 8]); // latitude, longitude
        b.push(0); // nation today
        b.extend_from_slice(&[0u8; 37]);
        b.extend_from_slice(&0u16.to_le_bytes()); // no tiebreak rules
        b.extend_from_slice(&0u32.to_le_bytes()); // end date
        b.extend_from_slice(&[0u8; 44]);
        b
    }

    pub fn source_body(title: &[u8], publisher: &[u8], date: u32) -> Vec<u8> {
        let mut b = string(title);
        b.extend(string(publisher));
        b.extend_from_slice(&date.to_le_bytes());
        b.extend_from_slice(&date.to_le_bytes());
        b.extend_from_slice(&1i16.to_le_bytes());
        b.extend_from_slice(&1i16.to_le_bytes());
        b
    }

    pub fn team_body(title: &[u8], number: u8, year: i16, nation: u8) -> Vec<u8> {
        let mut b = string(title);
        b.push(number);
        b.push(0);
        b.extend_from_slice(&year.to_le_bytes());
        b.push(nation);
        b
    }

    pub fn game_tag_body(titles: &[(i32, &[u8])]) -> Vec<u8> {
        let mut b = (titles.len() as i32).to_le_bytes().to_vec();
        for (lang, t) in titles {
            b.extend_from_slice(&lang.to_le_bytes());
            b.extend(string(t));
        }
        b
    }

    /// Lays `records[t][i]` out in blocks with the given container sizes.
    /// Each entry is a whole record (length field included) or empty for an
    /// unused container.
    pub fn lid_file(
        containers: &[u32],
        records: &[Vec<Vec<u8>>],
        first_deleted: &[i64],
    ) -> Vec<u8> {
        let counts: Vec<i64> = records.iter().map(|r| r.len() as i64).collect();
        let mut out = lid_header(containers, &counts, first_deleted);
        let blocks = counts.iter().copied().max().unwrap_or(0) as usize;
        let block_size: usize = containers.iter().map(|&c| c as usize).sum();
        for i in 0..blocks {
            let mut block = vec![0u8; block_size];
            let mut off = 0usize;
            let mut last_written = 0usize;
            for (t, &c) in containers.iter().enumerate() {
                if let Some(rec) = records.get(t).and_then(|r| r.get(i)) {
                    assert!(rec.len() <= c as usize, "record larger than its container");
                    block[off..off + rec.len()].copy_from_slice(rec);
                    last_written = off + rec.len();
                }
                off += c as usize;
            }
            // The file ends right after the last record written.
            if i + 1 == blocks {
                block.truncate(last_written.max(1));
            }
            out.extend(block);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn header_is_big_endian_with_per_type_triples() {
        let h = lid_header(&STANDARD_CONTAINERS, &[120, 52, 24, 0, 0, 9], &[-1; 6]);
        assert_eq!(h.len(), HEADER_SIZE);
        assert_eq!(&h[..8], &[0, 0, 0, 0xb8, 0, 0, 0, 6]);
        let parsed = parse_lid_header(&h).unwrap();
        assert_eq!(parsed.header_size, 184);
        assert_eq!(parsed.container_sizes, STANDARD_CONTAINERS);
        assert_eq!(parsed.counts, vec![120, 52, 24, 0, 0, 9]);
        assert_eq!(parsed.first_deleted, vec![-1; 6]);
        assert_eq!(parsed.block_size(), 4234);
        assert_eq!(parsed.container_offset(TYPE_PLAYER), 0);
        assert_eq!(parsed.container_offset(TYPE_TOURNAMENT), 1024);
        assert_eq!(parsed.container_offset(TYPE_SOURCE), 2144);
        assert_eq!(parsed.container_offset(3), 2364);
        assert_eq!(parsed.container_offset(TYPE_TEAM), 3388);
        assert_eq!(parsed.container_offset(TYPE_GAME_TAG), 3702);
        let mut bad = h.clone();
        bad[4..8].copy_from_slice(&0u32.to_be_bytes());
        assert!(parse_lid_header(&bad)
            .unwrap_err()
            .contains("0 entity types"));
        let mut bad = h.clone();
        bad[8..12].copy_from_slice(&0u32.to_be_bytes());
        assert!(parse_lid_header(&bad)
            .unwrap_err()
            .contains("container size of 0"));
        assert!(parse_lid_header(&h[..100]).is_err());
    }

    #[test]
    fn real_records_from_a_converted_database() {
        // Transcribed from a database ChessBase converted from CBH.
        let mut player = vec![0x39, 0, 0, 0, 9, 0, 0, 0];
        player.extend_from_slice(b"Zukertort");
        player.extend_from_slice(&[0x10, 0, 0, 0]);
        player.extend_from_slice(b"Johannes Hermann");
        player.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 8, 0, 0, 0]);
        player.extend_from_slice(&[0xff; 8]);
        let Container::Record(data) = classify(&player).unwrap() else {
            panic!("live record");
        };
        let p = Player::parse(data).unwrap().decode(&TextDecoder::default());
        assert_eq!(p.last, "Zukertort");
        assert_eq!(p.first, "Johannes Hermann");
        assert_eq!(p.chessbase_id, -1);
        assert_eq!(p.fide_id, -1);
        assert_eq!(p.pgn_name(), "Zukertort, Johannes Hermann");

        let mut t = vec![0x9c, 0, 0, 0, 3, 0, 0, 0];
        t.extend_from_slice(b"USA");
        t.extend_from_slice(&[0x25, 0, 0, 0]);
        t.extend_from_slice(b"World-ch01 Steinitz-Zukertort +10-5=5");
        t.extend_from_slice(&[
            0x2b, 0xbc, 0x0e, 0x00, 0x02, 0x00, 0x93, 0x00, 0x00, 0x03, 0x14, 0x00,
        ]);
        t.extend_from_slice(&[0u8; 9]); // lat, lon, nation today
        t.extend_from_slice(&[0u8; 36]);
        t.push(1); // the flag at 57
        t.extend_from_slice(&[0, 0]); // k = 0
        t.extend_from_slice(&[0u8; 4 + 44]);
        assert_eq!(t.len(), 4 + 0x9c);
        let Container::Record(data) = classify(&t).unwrap() else {
            panic!("live record");
        };
        let tr = Tournament::parse(data)
            .unwrap()
            .decode(&TextDecoder::default());
        assert_eq!(tr.title, "World-ch01 Steinitz-Zukertort +10-5=5");
        assert_eq!(tr.place, "USA");
        assert_eq!(tr.start.to_pgn(), "1886.01.11");
        assert!(tr.end.is_unknown());
        assert_eq!(tr.kind, 2, "match");
        assert_eq!(tr.time_control, 0);
        assert!(!tr.team_event);
        assert_eq!(tr.nation, 147);
        assert_eq!(tr.rounds, 20);

        let mut s = vec![0x25, 0, 0, 0, 8, 0, 0, 0];
        s.extend_from_slice(b"MainBase");
        s.extend_from_slice(&[9, 0, 0, 0]);
        s.extend_from_slice(b"ChessBase");
        s.extend_from_slice(&[0xe1, 0x9e, 0x0f, 0x00, 0xe1, 0x9e, 0x0f, 0x00, 2, 0, 1, 0]);
        let Container::Record(data) = classify(&s).unwrap() else {
            panic!("live record");
        };
        let src = Source::parse(data).unwrap().decode(&TextDecoder::default());
        assert_eq!(src.title, "MainBase");
        assert_eq!(src.publisher, "ChessBase");
        assert_eq!(src.publication_date.to_pgn(), "1999.07.01");
        assert_eq!(src.version, 2);
        assert_eq!(src.quality, 1);
    }

    #[test]
    fn classify_tells_unused_deleted_and_live_apart() {
        assert_eq!(classify(&[0; 8]).unwrap(), Container::Unused);
        assert_eq!(
            classify(&deleted_record(7)).unwrap(),
            Container::Deleted { next: 7 }
        );
        assert_eq!(
            classify(&record(b"abc")).unwrap(),
            Container::Record(&b"abc"[..])
        );
        assert!(classify(&[9, 0, 0, 0, 1, 2]).is_err());
        assert!(classify(&[0xff, 0xff, 0xff, 0xff]).is_err());
        assert!(classify(&[1, 0]).is_err());
    }

    #[test]
    fn team_and_game_tag_layouts() {
        let dec = TextDecoder::default();
        let team = Team::parse(&team_body(b"Berlin", 2, 2023, 53))
            .unwrap()
            .decode(&dec);
        assert_eq!(team.title, "Berlin");
        assert_eq!(team.number, 2);
        assert!(!team.season);
        assert_eq!(team.year, 2023);
        assert_eq!(team.nation, 53);
        let tag = GameTag::parse(&game_tag_body(&[
            (42, b""),
            (53, "Ber\u{fc}hmt".as_bytes()),
        ]))
        .unwrap()
        .decode(&dec);
        assert_eq!(tag.titles.len(), 2);
        assert_eq!(tag.any_title(), Some("Berühmt"));
        assert_eq!(
            GameTag::parse(&game_tag_body(&[]))
                .unwrap()
                .decode(&dec)
                .any_title(),
            None
        );
        assert!(GameTag::parse(&(-1i32).to_le_bytes()).is_none());
        assert!(Player::parse(&[1, 0, 0, 0]).is_none());
    }

    #[test]
    fn blocks_use_header_container_sizes_and_follow_the_deleted_list() {
        // Small, non-standard containers; player 1 and 3 deleted (3 first).
        let containers = [80u32, 160, 60, 16, 40, 40];
        let players = vec![
            record(&player_body(b"Carlsen", b"Magnus")),
            deleted_record(-1),
            record(&player_body(b"", b"")),
            deleted_record(1),
            record(&player_body("\u{4e01}\u{7acb}\u{4eba}".as_bytes(), b"")),
        ];
        let tournaments = vec![record(&tournament_body(
            b"Tata Steel",
            b"Wijk aan Zee",
            (2024 << 9) | (1 << 5) | 13,
            103,
            13,
        ))];
        let sources = vec![
            Vec::new(),
            record(&source_body(b"Mega 2026", b"ChessBase", 2025 << 9)),
        ];
        let teams = vec![record(&team_body(b"Berlin", 1, 2023, 53))];
        let tags = vec![record(&game_tag_body(&[]))];
        let file = lid_file(
            &containers,
            &[players, tournaments, sources, Vec::new(), teams, tags],
            &[3, -1, -1, -1, -1, -1],
        );
        let mut warnings = Vec::new();
        let table = EntityTable::parse(&file, &mut warnings).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(table.players.len(), 5);
        assert_eq!(table.player(0).unwrap().pgn_name(), "Carlsen, Magnus");
        assert!(table.player(1).is_none());
        assert_eq!(table.player(2).unwrap().pgn_name(), "?");
        assert!(table.player(3).is_none());
        assert_eq!(table.player(4).unwrap().pgn_name(), "丁立人");
        assert!(table.player(5).is_none());
        assert!(table.player(-1).is_none());
        let t = table.tournament(0).unwrap();
        assert_eq!(
            (t.title.as_str(), t.place.as_str()),
            ("Tata Steel", "Wijk aan Zee")
        );
        assert_eq!(t.start.to_pgn(), "2024.01.13");
        assert!(table.source(0).is_none(), "unused container");
        assert_eq!(table.source(1).unwrap().title, "Mega 2026");
        assert_eq!(table.team(0).unwrap().title, "Berlin");
        assert_eq!(table.game_tag(0).unwrap().any_title(), None);
        assert_eq!(table.decoder.label(), "utf-8");
    }

    #[test]
    fn broken_lists_truncation_and_bad_records_only_warn() {
        let containers = [64u32, 64, 64, 16, 64, 64];
        let players = vec![
            record(&player_body(b"A", b"")),
            record(&[1, 2, 3]), // too short to be a player
            record(&player_body(b"C", b"")),
        ];
        let mut file = lid_file(
            &containers,
            &[
                players,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ],
            &[2, -1, -1, -1, -1, -1],
        );
        let mut warnings = Vec::new();
        let table = EntityTable::parse(&file, &mut warnings).unwrap();
        assert_eq!(table.player(0).unwrap().last, "A");
        assert!(table.player(1).is_none());
        assert!(table.player(2).is_none(), "the list says it is deleted");
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(warnings[0].contains("1 player record(s) could not be parsed"));
        assert!(warnings[1].contains("not a deleted record"));
        // Cut the file inside the second block: player 1 and 2 are lost.
        let block_size: usize = containers.iter().map(|&c| c as usize).sum();
        file.truncate(HEADER_SIZE + block_size + 2);
        let mut warnings = Vec::new();
        let table = EntityTable::parse(&file, &mut warnings).unwrap();
        assert_eq!(table.players.len(), 2);
        assert!(table.player(1).is_none());
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("ends after 2 of 3 blocks")),
            "{warnings:?}"
        );
        assert!(EntityTable::parse(&file[..100], &mut warnings).is_err());
        assert!(EntityTable::parse(&[0; 4], &mut warnings).is_err());
    }
}
