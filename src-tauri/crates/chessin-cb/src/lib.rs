//! Clean-room, read-only reader for ChessBase CBH databases (the "version 1"
//! format written by ChessBase 6 to 16) that emits PGN.
//!
//! The on-disk layout follows the public description in Jimmy Mårdell's
//! Morphy format documents (`format/v1/*.md`); no code was taken from any
//! ChessBase reader. See `docs/chessbase-teardown.md` §4 for a summary.
//!
//! ```no_run
//! let mut db = chessin_cb::read_database("games.cbh").unwrap();
//! for game in db.games() {
//!     match game {
//!         Ok(game) => chessin_cb::write_pgn(&game, &mut std::io::stdout()).unwrap(),
//!         Err(e) => eprintln!("{e}"),
//!     }
//! }
//! ```
//!
//! What is read: the `.cbh` headers, the players, tournaments, annotators and
//! sources they point at, the moves (encoding modes 0, 4, 5 and 10, including
//! set-up positions, variations, null moves, promotions and Chess960 castling)
//! and the annotations listed in [`annotations`]. Guiding texts, deleted games
//! and games in an encoding mode whose translation table is not public are
//! skipped and counted.

#![forbid(unsafe_code)]

pub mod annotations;
mod bytes;
pub mod entities;
pub mod header;
pub mod moves;
mod pgn;
mod tables;
pub mod text;

#[cfg(test)]
mod roundtrip_tests;
#[cfg(test)]
mod testenc;

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use annotations::{Payload, RawAnnotation};
use entities::{Annotator, EntityFile, Player, Source, Tournament};
use header::{CbhFileHeader, EcoField, GameRecord, GameResult, CBH_HEADER_SIZE};
use text::TextDecoder;

pub use header::CbDate;
pub use pgn::write_pgn;

/// Errors of the reader. [`Error::Deleted`], [`Error::GuidingText`] and
/// [`Error::Game`] concern one game and leave the database usable.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path}: {message}")]
    Format { path: PathBuf, message: String },
    #[error("game {id} is a guiding text, not a game")]
    GuidingText { id: u32 },
    #[error("game {id} is marked as deleted")]
    Deleted { id: u32 },
    #[error("game {id}: {reason}")]
    Game { id: u32, reason: String },
}

fn io_err(path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// One move of the game tree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Node {
    /// SAN of the move, `--` for a null move; empty for the root.
    pub san: String,
    pub is_null: bool,
    /// Whether white made this move.
    pub white: bool,
    /// Move number of this move.
    pub fullmove: u32,
    /// Indices into `Game::nodes`: the first child is the main continuation,
    /// the others are variations.
    pub children: Vec<usize>,
    pub comment_before: Option<String>,
    pub comment_after: Option<String>,
    pub nags: Vec<u8>,
    /// `[%csl ...]`, `[%cal ...]`, `[%clk ...]`, `[%eval ...]`, … appended to
    /// the comment after the move.
    pub commands: Vec<String>,
}

/// PGN headers of a game, already formatted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers {
    pub white: String,
    pub black: String,
    pub white_elo: Option<u16>,
    pub black_elo: Option<u16>,
    pub event: String,
    pub site: String,
    pub event_date: Option<String>,
    pub round: String,
    /// `YYYY.MM.DD` with `?` for unknown parts.
    pub date: String,
    /// The PGN result token.
    pub result: String,
    pub eco: Option<String>,
    pub annotator: Option<String>,
    pub source: Option<String>,
    pub time_control: Option<String>,
    /// The Chess960 start position number, when the ECO field holds one.
    pub chess960_position: Option<u16>,
    /// The game was decided by forfeit.
    pub forfeit: bool,
}

/// A decoded game.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Game {
    /// The 1-based game id in the database.
    pub id: u32,
    pub headers: Headers,
    /// FEN of the start position when it is not the standard one.
    pub setup_fen: Option<String>,
    pub chess960: bool,
    /// `nodes[0]` is the root; see [`Node::children`].
    pub nodes: Vec<Node>,
    /// Text attached to the game as a whole (annotation position -1).
    pub game_comment: Option<String>,
    pub game_commands: Vec<String>,
    /// The game has an annotation record.
    pub has_annotations: bool,
    /// Names of the annotation types that were skipped, one per annotation.
    pub unsupported_annotations: Vec<String>,
    pub warnings: Vec<String>,
}

/// An open database. Games are read one at a time.
pub struct CbhDatabase {
    cbh_path: PathBuf,
    cbh: BufReader<File>,
    cbg_path: PathBuf,
    cbg: File,
    cba: Option<(PathBuf, File)>,
    game_count: u32,
    players: EntityFile,
    tournaments: EntityFile,
    annotators: EntityFile,
    sources: EntityFile,
    decoder: TextDecoder,
    warnings: Vec<String>,
}

/// Finds a sibling file of the `.cbh`, trying the extension in lower and
/// upper case. Returns the lower-case path when neither exists.
fn sibling(cbh: &Path, ext: &str) -> PathBuf {
    let lower = cbh.with_extension(ext);
    if lower.exists() {
        return lower;
    }
    let upper = cbh.with_extension(ext.to_ascii_uppercase());
    if upper.exists() {
        return upper;
    }
    lower
}

fn load_entities(
    path: &Path,
    expected_data_size: usize,
    what: &str,
    warnings: &mut Vec<String>,
) -> EntityFile {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            warnings.push(format!("{}: {e}; {what} will be blank", path.display()));
            return EntityFile::empty();
        }
    };
    match EntityFile::parse(bytes, expected_data_size) {
        Ok(f) => f,
        Err(e) => {
            warnings.push(format!("{}: {e}; {what} will be blank", path.display()));
            EntityFile::empty()
        }
    }
}

/// Opens a database by the path of its `.cbh` file. The sibling files are
/// found next to it.
pub fn read_database(cbh_path: impl AsRef<Path>) -> Result<CbhDatabase, Error> {
    let cbh_path = cbh_path.as_ref().to_path_buf();
    let mut cbh_file = File::open(&cbh_path).map_err(|e| io_err(&cbh_path, e))?;
    let mut header = [0u8; CBH_HEADER_SIZE];
    cbh_file
        .read_exact(&mut header)
        .map_err(|e| io_err(&cbh_path, e))?;
    let CbhFileHeader { next_game_id, .. } =
        header::parse_file_header(&header).map_err(|message| Error::Format {
            path: cbh_path.clone(),
            message,
        })?;
    let len = cbh_file.metadata().map_err(|e| io_err(&cbh_path, e))?.len();
    let records = len.saturating_sub(CBH_HEADER_SIZE as u64) / CBH_HEADER_SIZE as u64;
    let mut warnings = Vec::new();
    let game_count = u32::try_from(records).unwrap_or(u32::MAX);
    if next_game_id != 0 && next_game_id.saturating_sub(1) != game_count {
        warnings.push(format!(
            "the .cbh header announces {} games but the file holds {game_count} records",
            next_game_id.saturating_sub(1)
        ));
    }

    let cbg_path = sibling(&cbh_path, "cbg");
    let cbg = File::open(&cbg_path).map_err(|e| io_err(&cbg_path, e))?;
    let cba_path = sibling(&cbh_path, "cba");
    let cba = match File::open(&cba_path) {
        Ok(f) => Some((cba_path, f)),
        Err(e) => {
            warnings.push(format!(
                "{}: {e}; annotations will be missing",
                cba_path.display()
            ));
            None
        }
    };
    let players = load_entities(
        &sibling(&cbh_path, "cbp"),
        Player::DATA_SIZE,
        "player names",
        &mut warnings,
    );
    let tournaments = load_entities(
        &sibling(&cbh_path, "cbt"),
        Tournament::DATA_SIZE,
        "events",
        &mut warnings,
    );
    let annotators = load_entities(
        &sibling(&cbh_path, "cbc"),
        Annotator::DATA_SIZE,
        "annotators",
        &mut warnings,
    );
    let sources = load_entities(
        &sibling(&cbh_path, "cbs"),
        Source::DATA_SIZE,
        "sources",
        &mut warnings,
    );
    let decoder = TextDecoder::detect(
        players
            .string_fields(Player::STRING_FIELDS)
            .chain(tournaments.string_fields(Tournament::STRING_FIELDS))
            .chain(annotators.string_fields(Annotator::STRING_FIELDS))
            .chain(sources.string_fields(Source::STRING_FIELDS)),
    );
    Ok(CbhDatabase {
        cbh: BufReader::new(cbh_file),
        cbh_path,
        cbg_path,
        cbg,
        cba,
        game_count,
        players,
        tournaments,
        annotators,
        sources,
        decoder,
        warnings,
    })
}

/// Iterator over the games of a database, in id order.
pub struct Games<'a> {
    db: &'a mut CbhDatabase,
    next: u32,
}

impl Iterator for Games<'_> {
    type Item = Result<Game, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next > self.db.game_count || self.next == 0 {
            return None;
        }
        let id = self.next;
        self.next += 1;
        Some(self.db.read_game(id))
    }
}

impl CbhDatabase {
    /// Number of records in the `.cbh` file: games, guiding texts and deleted
    /// games together.
    pub fn game_count(&self) -> u32 {
        self.game_count
    }

    /// The detected text encoding, for the import report.
    pub fn encoding(&self) -> &str {
        self.decoder.label()
    }

    /// Problems found while opening (missing optional files and the like).
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Reads the games one by one, starting from id 1.
    pub fn games(&mut self) -> Games<'_> {
        Games { db: self, next: 1 }
    }

    fn read_record(&mut self, id: u32) -> Result<GameRecord, Error> {
        if id == 0 || id > self.game_count {
            return Err(Error::Game {
                id,
                reason: format!(
                    "no such game (the database has {} records)",
                    self.game_count
                ),
            });
        }
        let offset = u64::from(id) * CBH_HEADER_SIZE as u64;
        self.cbh
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_err(&self.cbh_path, e))?;
        let mut buf = [0u8; CBH_HEADER_SIZE];
        self.cbh
            .read_exact(&mut buf)
            .map_err(|e| io_err(&self.cbh_path, e))?;
        match header::parse_game_record(&buf) {
            Ok(Some(r)) => Ok(r),
            Ok(None) => Err(Error::Game {
                id,
                reason: "empty record".to_string(),
            }),
            Err(reason) => Err(Error::Game { id, reason }),
        }
    }

    fn read_moves_record(&mut self, id: u32, offset: u32) -> Result<(u8, Vec<u8>), Error> {
        let path = self.cbg_path.clone();
        self.cbg
            .seek(SeekFrom::Start(u64::from(offset)))
            .map_err(|e| io_err(&path, e))?;
        let mut head = [0u8; 4];
        self.cbg.read_exact(&mut head).map_err(|e| Error::Game {
            id,
            reason: format!("moves record at offset {offset} cannot be read: {e}"),
        })?;
        let flags = head[0];
        let size = u32::from_be_bytes([0, head[1], head[2], head[3]]) as usize;
        if size < 4 {
            return Err(Error::Game {
                id,
                reason: format!("moves record at offset {offset} has size {size}"),
            });
        }
        let mut payload = vec![0u8; size - 4];
        self.cbg.read_exact(&mut payload).map_err(|e| Error::Game {
            id,
            reason: format!("moves record at offset {offset} is truncated: {e}"),
        })?;
        Ok((flags, payload))
    }

    fn read_annotation_record(
        &mut self,
        id: u32,
        offset: u32,
    ) -> Result<Option<Vec<RawAnnotation>>, String> {
        let Some((path, file)) = self.cba.as_mut() else {
            return Ok(None);
        };
        file.seek(SeekFrom::Start(u64::from(offset)))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let mut head = [0u8; annotations::RECORD_HEADER_SIZE];
        file.read_exact(&mut head)
            .map_err(|e| format!("annotation record at offset {offset} cannot be read: {e}"))?;
        let size = annotations::record_size(&head)? as usize;
        let mut record = head.to_vec();
        record.resize(size, 0);
        file.read_exact(&mut record[annotations::RECORD_HEADER_SIZE..])
            .map_err(|e| format!("annotation record at offset {offset} is truncated: {e}"))?;
        let (game_id, raw) = annotations::parse_record(&record)?;
        if game_id != id {
            return Err(format!(
                "annotation record at offset {offset} belongs to game {game_id}"
            ));
        }
        Ok(Some(raw))
    }

    fn headers(&self, rec: &GameRecord) -> Headers {
        let dec = &self.decoder;
        let player = |id: u32| {
            self.players
                .record_data(id)
                .and_then(|d| Player::parse(d, dec))
                .unwrap_or_default()
        };
        let tournament = self
            .tournaments
            .record_data(rec.tournament)
            .and_then(|d| Tournament::parse(d, dec))
            .unwrap_or_default();
        let annotator = self
            .annotators
            .record_data(rec.annotator)
            .and_then(|d| Annotator::parse(d, dec))
            .map(|a| a.name)
            .filter(|n| !n.is_empty());
        let source = self
            .sources
            .record_data(rec.source)
            .and_then(|d| Source::parse(d, dec))
            .map(|s| s.title)
            .filter(|t| !t.is_empty());
        let round = match (rec.round, rec.subround) {
            (0, _) => String::new(),
            (r, 0) => r.to_string(),
            (r, s) => format!("{r}.{s}"),
        };
        let (eco, chess960_position) = match &rec.eco {
            EcoField::None => (None, None),
            EcoField::Eco { code, .. } => (Some(code.clone()), None),
            EcoField::Chess960(n) => (None, Some(*n)),
        };
        Headers {
            white: player(rec.white).pgn_name(),
            black: player(rec.black).pgn_name(),
            white_elo: Some(rec.white_elo).filter(|e| *e > 0),
            black_elo: Some(rec.black_elo).filter(|e| *e > 0),
            event: tournament.title,
            site: tournament.place,
            event_date: Some(tournament.date)
                .filter(|d| !d.is_unknown())
                .map(|d| d.to_pgn()),
            round,
            date: rec.date.to_pgn(),
            result: rec.result.to_pgn().to_string(),
            eco,
            annotator,
            source,
            time_control: None,
            chess960_position,
            forfeit: rec.result.is_forfeit(),
        }
    }

    /// Reads one game by its 1-based id.
    pub fn read_game(&mut self, id: u32) -> Result<Game, Error> {
        let rec = self.read_record(id)?;
        if rec.deleted {
            return Err(Error::Deleted { id });
        }
        if rec.guiding_text {
            return Err(Error::GuidingText { id });
        }
        let headers = self.headers(&rec);
        let (flags, payload) = self.read_moves_record(id, rec.moves_offset)?;
        let decoded =
            moves::decode_moves(flags, &payload).map_err(|reason| Error::Game { id, reason })?;
        let mut game = Game {
            id,
            headers,
            setup_fen: decoded.setup_fen,
            chess960: decoded.chess960,
            nodes: decoded.nodes,
            ..Game::default()
        };
        if rec.annotations_offset != 0 {
            match self.read_annotation_record(id, rec.annotations_offset) {
                Ok(Some(raw)) => {
                    game.has_annotations = !raw.is_empty();
                    apply_annotations(&mut game, raw, &self.decoder);
                }
                Ok(None) => {}
                Err(e) => game
                    .warnings
                    .push(format!("game {id}: annotations skipped: {e}")),
            }
        }
        if rec.result == GameResult::Line && rec.line_evaluation != 0 {
            if let Some(last) = last_mainline_node(&game.nodes) {
                game.nodes[last].nags.push(rec.line_evaluation);
            }
        }
        Ok(game)
    }
}

fn last_mainline_node(nodes: &[Node]) -> Option<usize> {
    let mut cur = 0;
    while let Some(&next) = nodes.get(cur)?.children.first() {
        cur = next;
    }
    (cur != 0).then_some(cur)
}

fn append_text(slot: &mut Option<String>, text: String) {
    if text.is_empty() {
        return;
    }
    match slot {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(&text);
        }
        None => *slot = Some(text),
    }
}

fn apply_evaluations(game: &mut Game, evals: &[Option<String>]) {
    let mut cur = 0;
    let mut i = 1;
    while let Some(&next) = game.nodes[cur].children.first() {
        if let Some(Some(e)) = evals.get(i) {
            let node = &mut game.nodes[next];
            if !node.commands.iter().any(|c| c.starts_with("[%eval")) {
                node.commands.push(format!("[%eval {e}]"));
            }
        }
        cur = next;
        i += 1;
    }
}

/// Attaches the annotations of a game to its nodes.
fn apply_annotations(game: &mut Game, raw: Vec<RawAnnotation>, dec: &TextDecoder) {
    let mut out_of_range = 0u32;
    for a in raw {
        let target = if a.position < 0 {
            None
        } else {
            let idx = a.position as usize + 1;
            if idx >= game.nodes.len() {
                out_of_range += 1;
                continue;
            }
            Some(idx)
        };
        match annotations::decode(a.kind, &a.data, dec) {
            Payload::Unsupported(kind) => game.unsupported_annotations.push(kind),
            Payload::TimeControl(tc) => game.headers.time_control = Some(tc),
            Payload::Evaluations(evals) => apply_evaluations(game, &evals),
            Payload::TextAfter(t) => match target {
                Some(i) => append_text(&mut game.nodes[i].comment_after, t),
                None => append_text(&mut game.game_comment, t),
            },
            Payload::TextBefore(t) => match target {
                Some(i) => append_text(&mut game.nodes[i].comment_before, t),
                None => append_text(&mut game.game_comment, t),
            },
            Payload::Symbols(nags) => {
                if let Some(i) = target {
                    game.nodes[i].nags.extend(nags);
                }
            }
            Payload::Command(c) => match target {
                Some(i) => game.nodes[i].commands.push(c),
                None => game.game_commands.push(c),
            },
        }
    }
    if out_of_range > 0 {
        game.warnings.push(format!(
            "game {}: {out_of_range} annotation(s) point past the last move",
            game.id
        ));
    }
}

/// One kind of annotation that was not translated, and how often it occurred.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct UnsupportedAnnotation {
    pub kind: String,
    pub count: u32,
}

/// What [`convert_to_pgn`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct CbhImportReport {
    /// Records in the database: games, guiding texts and deleted games.
    pub games: u32,
    /// Games written to the PGN file.
    pub exported: u32,
    /// Records not written: deleted games, guiding texts and games that could
    /// not be decoded (each of the last has a warning).
    pub skipped: u32,
    /// Exported games that carry annotations.
    pub annotated: u32,
    /// Annotation types that were skipped, with counts.
    pub unsupported: Vec<UnsupportedAnnotation>,
    /// The detected text encoding of the database.
    pub encoding: String,
    pub warnings: Vec<String>,
}

const MAX_WARNINGS: usize = 200;

struct Warnings {
    items: Vec<String>,
    dropped: usize,
}

impl Warnings {
    fn push(&mut self, w: String) {
        if self.items.len() < MAX_WARNINGS {
            self.items.push(w);
        } else {
            self.dropped += 1;
        }
    }

    fn finish(mut self) -> Vec<String> {
        if self.dropped > 0 {
            self.items
                .push(format!("... and {} more warnings", self.dropped));
        }
        self.items
    }
}

/// Converts a whole database to one PGN file.
pub fn convert_to_pgn(
    cbh_path: impl AsRef<Path>,
    out_path: impl AsRef<Path>,
) -> Result<CbhImportReport, Error> {
    let out_path = out_path.as_ref();
    let mut db = read_database(cbh_path)?;
    let out = File::create(out_path).map_err(|e| io_err(out_path, e))?;
    let mut w = BufWriter::new(out);
    let mut report = CbhImportReport {
        games: db.game_count(),
        encoding: db.encoding().to_string(),
        ..CbhImportReport::default()
    };
    let mut warnings = Warnings {
        items: db.warnings().to_vec(),
        dropped: 0,
    };
    let mut unsupported: BTreeMap<String, u32> = BTreeMap::new();
    let mut deleted = 0u32;
    let mut texts = 0u32;
    for game in db.games() {
        match game {
            Ok(game) => {
                write_pgn(&game, &mut w).map_err(|e| io_err(out_path, e))?;
                report.exported += 1;
                if game.has_annotations {
                    report.annotated += 1;
                }
                for kind in game.unsupported_annotations {
                    *unsupported.entry(kind).or_default() += 1;
                }
                for warning in game.warnings {
                    warnings.push(warning);
                }
            }
            Err(Error::Deleted { .. }) => {
                report.skipped += 1;
                deleted += 1;
            }
            Err(Error::GuidingText { .. }) => {
                report.skipped += 1;
                texts += 1;
            }
            Err(Error::Game { id, reason }) => {
                report.skipped += 1;
                warnings.push(format!("game {id} skipped: {reason}"));
            }
            Err(e) => return Err(e),
        }
    }
    w.flush().map_err(|e| io_err(out_path, e))?;
    if deleted > 0 {
        warnings.push(format!("{deleted} deleted game(s) skipped"));
    }
    if texts > 0 {
        warnings.push(format!("{texts} guiding text(s) skipped"));
    }
    report.unsupported = unsupported
        .into_iter()
        .map(|(kind, count)| UnsupportedAnnotation { kind, count })
        .collect();
    report.warnings = warnings.finish();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotations_attach_to_stream_positions() {
        let mut game = Game {
            nodes: vec![
                Node::default(),
                Node {
                    san: "e4".into(),
                    white: true,
                    fullmove: 1,
                    ..Node::default()
                },
                Node {
                    san: "e5".into(),
                    fullmove: 1,
                    ..Node::default()
                },
            ],
            ..Game::default()
        };
        game.nodes[0].children = vec![1];
        game.nodes[1].children = vec![2];
        let dec = TextDecoder::default();
        let raw = vec![
            RawAnnotation {
                position: -1,
                kind: 0x02,
                data: b"\0\0whole game".to_vec(),
            },
            RawAnnotation {
                position: 0,
                kind: 0x82,
                data: b"\0\0before".to_vec(),
            },
            RawAnnotation {
                position: 0,
                kind: 0x03,
                data: vec![1],
            },
            RawAnnotation {
                position: 0,
                kind: 0x02,
                data: b"\0\0after".to_vec(),
            },
            RawAnnotation {
                position: 0,
                kind: 0x02,
                data: b"\0\0more".to_vec(),
            },
            RawAnnotation {
                position: 1,
                kind: 0x04,
                data: vec![2, 37],
            },
            RawAnnotation {
                position: -1,
                kind: 0x16,
                data: 6000i32.to_be_bytes().to_vec(),
            },
            RawAnnotation {
                position: -1,
                kind: 0x22,
                data: vec![0; 4],
            },
            RawAnnotation {
                position: 5,
                kind: 0x02,
                data: b"\0\0lost".to_vec(),
            },
            RawAnnotation {
                position: -1,
                kind: 0x26,
                data: vec![0, 3, 0, 1, 0, 10, 0, 1, 0, 20, 0xff, 0, 0, 0],
            },
        ];
        apply_annotations(&mut game, raw, &dec);
        assert_eq!(game.game_comment.as_deref(), Some("whole game"));
        assert_eq!(game.game_commands, vec!["[%clk 0:01:00]"]);
        assert_eq!(game.nodes[1].comment_before.as_deref(), Some("before"));
        assert_eq!(game.nodes[1].comment_after.as_deref(), Some("after more"));
        assert_eq!(game.nodes[1].nags, vec![1]);
        assert_eq!(game.nodes[1].commands, vec!["[%eval 0.20]"]);
        assert_eq!(game.nodes[2].commands, vec!["[%csl Ge5]"]);
        assert_eq!(game.unsupported_annotations, vec!["medals (22)"]);
        assert_eq!(game.warnings.len(), 1);
        assert!(game.warnings[0].contains("past the last move"));
    }

    #[test]
    fn warnings_are_capped() {
        let mut w = Warnings {
            items: Vec::new(),
            dropped: 0,
        };
        for i in 0..(MAX_WARNINGS + 5) {
            w.push(i.to_string());
        }
        let items = w.finish();
        assert_eq!(items.len(), MAX_WARNINGS + 1);
        assert_eq!(items.last().unwrap(), "... and 5 more warnings");
    }

    #[test]
    fn missing_database_is_an_io_error() {
        let Err(err) = read_database("/nonexistent/dir/x.cbh") else {
            panic!("opened a database that does not exist");
        };
        assert!(matches!(err, Error::Io { .. }));
    }
}
