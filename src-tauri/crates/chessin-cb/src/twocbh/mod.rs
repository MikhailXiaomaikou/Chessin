//! Clean-room, read-only reader for ChessBase 2CBH databases (the "version 2"
//! format introduced with ChessBase 17) that emits PGN.
//!
//! The on-disk layout follows the public description in Jimmy Mårdell's
//! Morphy format documents (`format/v2/*.md`); no code was taken from any
//! ChessBase reader, nothing is decrypted and `.cbz` archives are not
//! touched. A database is a set of files sharing one base name:
//!
//! | File | Read | Contents |
//! |---|---|---|
//! | `.2cbh` | yes | 192-byte game records, one per game, in id order |
//! | `.2cbg` | yes | moves as 16-bit words in a position-independent enumeration |
//! | `.2cba` | yes | annotations, grouped by position in PGN order |
//! | `.2lid` | yes | players (and annotators), tournaments, sources, teams, game tags |
//! | `.2lgd`, `.2lcd` | no | derived indexes: the games of each entity, sort orders |
//! | `.ini` | no | user-interface state |
//!
//! Everything is little-endian except the `.2lid` header and the checksum of
//! a `.2cbg`/`.2cba` record. Strings are UTF-8 with a byte count; annotation
//! text is UTF-8 or cp1252 without a marker, so it is decoded as UTF-8 when
//! valid and through the fallback code page otherwise.
//!
//! What is read: every game's headers (players, Elo, event, site, dates,
//! round, board, teams, result, ECO or Chess960 position, annotator, source),
//! the full move tree including set-up positions, Chess960 games and null
//! moves, and the annotations listed in [`annotations`]. Guiding texts,
//! analyses and deleted games are skipped and counted; a record whose
//! checksum does not match is skipped with a warning naming its offset.

pub mod annotations;
pub mod entities;
pub mod header;
pub mod moves;

#[cfg(test)]
mod testenc;
#[cfg(test)]
mod tests;

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::header::{EcoField, GameResult};
use crate::{
    apply_annotations, io_err, last_mainline_node, sibling, CbhImportReport, Error, Exporter, Game,
    Headers,
};
use entities::EntityTable;
use header::{GameRecord, RecordKind, RECORD_SIZE};
use moves::{RecordHead, RECORD_HEAD_SIZE, TAG_ANNOTATIONS};

/// Largest record content a reader accepts, as a guard against a damaged
/// header sending it off to read gigabytes.
const MAX_RECORD_CONTENT: u32 = 256 << 20;

/// Reads up to `buf.len()` bytes, stopping at the end of the file.
fn read_upto(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

/// Reads the framed record at `offset` and verifies its checksum.
fn read_record(file: &mut File, offset: u64) -> Result<(RecordHead, Vec<u8>), String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("record at offset {offset}: {e}"))?;
    let mut head = [0u8; RECORD_HEAD_SIZE];
    file.read_exact(&mut head)
        .map_err(|e| format!("record at offset {offset} cannot be read: {e}"))?;
    let rh =
        moves::parse_record_head(&head).map_err(|e| format!("record at offset {offset}: {e}"))?;
    if rh.content_size > MAX_RECORD_CONTENT {
        return Err(format!(
            "record at offset {offset} claims {} bytes of content",
            rh.content_size
        ));
    }
    let mut content = vec![0u8; rh.content_size as usize];
    file.read_exact(&mut content)
        .map_err(|e| format!("record at offset {offset} is truncated: {e}"))?;
    if moves::checksum(&content) != rh.checksum {
        return Err(format!(
            "record at offset {offset}: checksum mismatch (the record is damaged or the offset is wrong)"
        ));
    }
    Ok((rh, content))
}

/// Checks the 12-byte header of a `.2cbg` or `.2cba` file against the file.
fn check_stream_header(file: &mut File, path: &Path, warnings: &mut Vec<String>) {
    let mut head = [0u8; 12];
    let (Ok(got), Ok(len)) = (read_upto(file, &mut head), file.metadata().map(|m| m.len())) else {
        return;
    };
    if got < 12 {
        warnings.push(format!(
            "{}: the file is shorter than its 12-byte header",
            path.display()
        ));
        return;
    }
    let size = u64::from_le_bytes(head[..8].try_into().expect("8 bytes"));
    if size != len {
        warnings.push(format!(
            "{}: the header says {size} bytes but the file holds {len}",
            path.display()
        ));
    }
}

/// An open database. Games are read one at a time.
pub struct Database2Cbh {
    cbh_path: PathBuf,
    cbh: BufReader<File>,
    cbg: File,
    cba: Option<File>,
    game_count: u32,
    entities: EntityTable,
    warnings: Vec<String>,
}

/// Opens a database by the path of its `.2cbh` file. The sibling files are
/// found next to it; the entity file is read in full at this point.
pub fn read_2cbh_database(path: impl AsRef<Path>) -> Result<Database2Cbh, Error> {
    let cbh_path = path.as_ref().to_path_buf();
    let mut cbh_file = File::open(&cbh_path).map_err(|e| io_err(&cbh_path, e))?;
    let mut head = [0u8; RECORD_SIZE];
    let got = read_upto(&mut cbh_file, &mut head).map_err(|e| io_err(&cbh_path, e))?;
    let file_header = header::parse_file_header(&head[..got]).map_err(|message| Error::Format {
        path: cbh_path.clone(),
        message,
    })?;
    let len = cbh_file.metadata().map_err(|e| io_err(&cbh_path, e))?.len();
    let records = len.saturating_sub(RECORD_SIZE as u64) / RECORD_SIZE as u64;
    let game_count = u32::try_from(records).unwrap_or(u32::MAX);
    let mut warnings = Vec::new();
    if file_header.next_game_id != 0 && file_header.next_game_id.saturating_sub(1) != game_count {
        warnings.push(format!(
            "the .2cbh header announces {} games but the file holds {game_count} records",
            file_header.next_game_id.saturating_sub(1)
        ));
    }
    let cbg_path = sibling(&cbh_path, "2cbg");
    let mut cbg = File::open(&cbg_path).map_err(|e| io_err(&cbg_path, e))?;
    check_stream_header(&mut cbg, &cbg_path, &mut warnings);
    let cba_path = sibling(&cbh_path, "2cba");
    let cba = match File::open(&cba_path) {
        Ok(mut f) => {
            check_stream_header(&mut f, &cba_path, &mut warnings);
            Some(f)
        }
        Err(e) => {
            warnings.push(format!(
                "{}: {e}; annotations will be missing",
                cba_path.display()
            ));
            None
        }
    };
    let lid_path = sibling(&cbh_path, "2lid");
    let entities = match EntityTable::load(&lid_path, &mut warnings) {
        Ok(t) => t,
        Err(e) => {
            warnings.push(format!(
                "{}: {e}; players, events and sources will be blank",
                lid_path.display()
            ));
            EntityTable::empty()
        }
    };
    Ok(Database2Cbh {
        cbh: BufReader::new(cbh_file),
        cbh_path,
        cbg,
        cba,
        game_count,
        entities,
        warnings,
    })
}

/// Iterator over the games of a database, in id order.
pub struct Games<'a> {
    db: &'a mut Database2Cbh,
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

impl Database2Cbh {
    /// Number of records in the `.2cbh` file: games, guiding texts, analyses
    /// and deleted games together.
    pub fn game_count(&self) -> u32 {
        self.game_count
    }

    /// The detected text encoding of the entity names, for the import report.
    pub fn encoding(&self) -> &str {
        self.entities.decoder.label()
    }

    /// Problems found while opening (missing optional files and the like).
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// The entities of the database.
    pub fn entities(&self) -> &EntityTable {
        &self.entities
    }

    /// Reads the games one by one, starting from id 1.
    pub fn games(&mut self) -> Games<'_> {
        Games { db: self, next: 1 }
    }

    fn read_record_bytes(&mut self, id: u32) -> Result<[u8; RECORD_SIZE], Error> {
        if id == 0 || id > self.game_count {
            return Err(Error::Game {
                id,
                reason: format!(
                    "no such game (the database has {} records)",
                    self.game_count
                ),
            });
        }
        let offset = u64::from(id) * RECORD_SIZE as u64;
        self.cbh
            .seek(SeekFrom::Start(offset))
            .map_err(|e| io_err(&self.cbh_path, e))?;
        let mut buf = [0u8; RECORD_SIZE];
        self.cbh
            .read_exact(&mut buf)
            .map_err(|e| io_err(&self.cbh_path, e))?;
        Ok(buf)
    }

    fn headers(&self, rec: &GameRecord) -> Headers {
        let e = &self.entities;
        let player = |id: i64| {
            e.player(id)
                .map(|p| p.pgn_name())
                .unwrap_or_else(|| "?".to_string())
        };
        let tournament = e.tournament(rec.tournament);
        let annotator = e
            .player(rec.annotator)
            .map(|p| p.pgn_name())
            .filter(|n| n != "?");
        let source = e
            .source(rec.source)
            .map(|s| s.title.clone())
            .filter(|t| !t.is_empty());
        let team = |id: i64| {
            e.team(id)
                .map(|t| t.title.clone())
                .filter(|t| !t.is_empty())
        };
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
            white: player(rec.white),
            black: player(rec.black),
            white_elo: Some(rec.white_elo).filter(|e| *e > 0),
            black_elo: Some(rec.black_elo).filter(|e| *e > 0),
            event: tournament.map(|t| t.title.clone()).unwrap_or_default(),
            site: tournament.map(|t| t.place.clone()).unwrap_or_default(),
            event_date: tournament
                .map(|t| t.start)
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
            white_team: team(rec.white_team),
            black_team: team(rec.black_team),
            board: u16::try_from(rec.board).ok().filter(|b| *b > 0),
        }
    }

    /// Reads one game by its 1-based id.
    pub fn read_game(&mut self, id: u32) -> Result<Game, Error> {
        let buf = self.read_record_bytes(id)?;
        let head = header::parse_record_head(&buf).map_err(|reason| Error::Game { id, reason })?;
        if head.deleted {
            return Err(Error::Deleted { id });
        }
        match head.kind {
            RecordKind::GuidingText => return Err(Error::GuidingText { id }),
            RecordKind::Analysis => return Err(Error::Analysis { id }),
            RecordKind::Game => {}
        }
        let rec = header::parse_game_record(&buf, &self.entities.decoder)
            .map_err(|reason| Error::Game { id, reason })?;
        let headers = self.headers(&rec);
        let (rh, content) =
            read_record(&mut self.cbg, rec.moves_offset).map_err(|reason| Error::Game {
                id,
                reason: format!("moves: {reason}"),
            })?;
        let mut warnings = Vec::new();
        let decoded = moves::decode_moves(rh.tag, &content, &mut warnings)
            .map_err(|reason| Error::Game { id, reason })?;
        let mut game = Game {
            id,
            headers,
            setup_fen: decoded.setup_fen,
            chess960: decoded.chess960,
            nodes: decoded.nodes,
            warnings: warnings
                .into_iter()
                .map(|w| format!("game {id}: {w}"))
                .collect(),
            ..Game::default()
        };
        if let Some(cba) = self.cba.as_mut() {
            match read_record(cba, rec.annotations_offset) {
                Ok((rh, _)) if rh.tag != TAG_ANNOTATIONS => game.warnings.push(format!(
                    "game {id}: annotations skipped: the record at offset {} has tag {:#06x}, not an annotation record",
                    rec.annotations_offset, rh.tag
                )),
                Ok((_, content)) => {
                    let parsed = annotations::parse_content(&content);
                    if let Some(problem) = parsed.problem {
                        game.warnings.push(format!("game {id}: {problem}"));
                    }
                    if !parsed.annotations.is_empty() {
                        game.has_annotations = true;
                        let order = annotations::pgn_order(&game.nodes);
                        let past_the_end = game.nodes.len() as i32;
                        let raw = parsed
                            .annotations
                            .into_iter()
                            .map(|mut a| {
                                if a.position >= 0 {
                                    a.position = usize::try_from(a.position)
                                        .ok()
                                        .and_then(|p| order.get(p))
                                        .map(|&node| node as i32 - 1)
                                        .unwrap_or(past_the_end);
                                }
                                a
                            })
                            .collect();
                        let dec = &self.entities.decoder;
                        apply_annotations(&mut game, raw, &|kind, data| {
                            annotations::decode(kind, data, dec)
                        });
                    }
                }
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

/// Converts a whole 2CBH database to one PGN file.
pub fn convert_2cbh_to_pgn(
    path: impl AsRef<Path>,
    out_path: impl AsRef<Path>,
) -> Result<CbhImportReport, Error> {
    let out_path = out_path.as_ref();
    let mut db = read_2cbh_database(path)?;
    let out = File::create(out_path).map_err(|e| io_err(out_path, e))?;
    let mut w = BufWriter::new(out);
    let mut exporter = Exporter::new(db.game_count(), db.encoding(), db.warnings());
    for game in db.games() {
        exporter.write(&mut w, out_path, game)?;
    }
    w.flush().map_err(|e| io_err(out_path, e))?;
    Ok(exporter.finish())
}

/// The two on-disk formats this crate reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
pub enum DbFormat {
    /// `.cbh` and siblings: ChessBase 6 to 16.
    #[serde(rename = "cbh")]
    Cbh,
    /// `.2cbh` and siblings: ChessBase 17 and later.
    #[serde(rename = "2cbh")]
    TwoCbh,
}

impl DbFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            DbFormat::Cbh => "cbh",
            DbFormat::TwoCbh => "2cbh",
        }
    }
}

/// Tells a CBH database from a 2CBH one by the header of the file at `path`
/// (a 46-byte record size and version 1 against a 192-byte record size and
/// version 5), falling back to the file extension when the header is not
/// readable as either.
pub fn detect_format(path: impl AsRef<Path>) -> Result<DbFormat, Error> {
    let path = path.as_ref();
    let mut file = File::open(path).map_err(|e| io_err(path, e))?;
    let mut head = [0u8; RECORD_SIZE];
    let got = read_upto(&mut file, &mut head).map_err(|e| io_err(path, e))?;
    let head = &head[..got];
    let v2 = header::parse_file_header(head).is_ok();
    let v1 = crate::header::parse_file_header(head).is_ok();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match (v2, v1, ext.as_deref()) {
        (true, false, _) | (true, true, Some("2cbh")) => Ok(DbFormat::TwoCbh),
        (false, true, _) | (true, true, _) => Ok(DbFormat::Cbh),
        (false, false, Some("2cbh")) => Ok(DbFormat::TwoCbh),
        (false, false, Some("cbh")) => Ok(DbFormat::Cbh),
        (false, false, _) => Err(Error::Format {
            path: path.to_path_buf(),
            message: "neither a CBH header (46-byte records, version 1) nor a 2CBH header (192-byte records, version 5)".to_string(),
        }),
    }
}

/// Converts a CBH or 2CBH database, whichever `path` is, to one PGN file.
pub fn convert_database_to_pgn(
    path: impl AsRef<Path>,
    out_path: impl AsRef<Path>,
) -> Result<CbhImportReport, Error> {
    match detect_format(&path)? {
        DbFormat::Cbh => crate::convert_to_pgn(path, out_path),
        DbFormat::TwoCbh => convert_2cbh_to_pgn(path, out_path),
    }
}
