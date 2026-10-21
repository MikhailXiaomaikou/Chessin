mod encoding;
mod migrate;
mod models;
mod ops;
mod schema;
mod search;
mod search_index;

use crate::{
    db::{
        encoding::{decode_game_to_movetext, decode_move, iter_mainline_move_bytes},
        models::*,
        ops::*,
        schema::*,
    },
    error::Error,
    opening::get_opening_from_setup,
    AppState,
};
use chrono::{NaiveDate, NaiveTime};
use dashmap::DashMap;
use diesel::{
    connection::{DefaultLoadingMode, SimpleConnection},
    prelude::*,
    r2d2::{ConnectionManager, Pool},
    result::{ConnectionError, DatabaseErrorKind},
    sql_query,
    sql_types::{Integer, Text},
};
use pgn_reader::{BufferedReader, Nag, RawHeader, SanPlus, Skip, Visitor};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, Board, ByColor, CastlingMode, Chess, EnPassantMode, FromSetup, Piece, Position,
    PositionError,
};
use specta::Type;
use std::{
    fs::{remove_file, File, OpenOptions},
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use std::{
    io::{BufWriter, Write},
    str::FromStr,
};
use tauri::{Emitter, State};

use log::{info, warn};
use tauri_specta::Event as _;

use self::encoding::{
    encode_comment, encode_move, encode_nag, VARIATION_END_MARKER, VARIATION_START_MARKER,
};
pub use self::search_index::{get_index_path, MmapSearchIndex, SearchGameEntry, SearchIndex};

pub use self::models::NormalizedGame;
pub use self::models::Puzzle;
pub use self::schema::puzzle_themes;
pub use self::schema::puzzles;
pub use self::schema::themes;
pub use self::search::{is_position_in_db, search_position, PositionQueryJs, PositionStats};

const DATABASE_VERSION: &str = "1.0.0";

const INDEXES_SQL: &str = include_str!("indexes.sql");

const DELETE_INDEXES_SQL: &str = include_str!("delete_indexes.sql");

const CREATE_TABLES_SQL: &str = include_str!("create.sql");

const WHITE_PAWN: Piece = Piece {
    color: shakmaty::Color::White,
    role: shakmaty::Role::Pawn,
};

const BLACK_PAWN: Piece = Piece {
    color: shakmaty::Color::Black,
    role: shakmaty::Role::Pawn,
};

type MaterialCount = ByColor<u8>;

fn get_material_count(board: &Board) -> MaterialCount {
    board.material().map(|material| {
        material.pawn
            + material.knight * 3
            + material.bishop * 3
            + material.rook * 5
            + material.queen * 9
    })
}

/// Returns the bit representation of the pawns on the second and seventh rank
/// of the given board.
fn get_pawn_home(board: &Board) -> u16 {
    let white_pawns = board.by_piece(WHITE_PAWN);
    let black_pawns = board.by_piece(BLACK_PAWN);
    let second_rank_pawns = (white_pawns.0 >> 8) as u8;
    let seventh_rank_pawns = (black_pawns.0 >> 48) as u8;
    (second_rank_pawns as u16) | ((seventh_rank_pawns as u16) << 8)
}

type DbPool = Pool<ConnectionManager<SqliteConnection>>;
type PooledDb = diesel::r2d2::PooledConnection<ConnectionManager<SqliteConnection>>;

/// How long a connection waits for a lock held by another connection or
/// process before giving up with "database is locked".
const BUSY_TIMEOUT: Duration = Duration::from_secs(30);

/// Settings for every connection handed out by the shared per-database pool.
///
/// There are deliberately no per-call fields. The pool is cached per path, so
/// it would otherwise keep whatever the first caller asked for: upstream
/// opened the pool with journaling off for import, and every later edit on
/// that database ran unjournaled, so a crash could corrupt it. Every pooled
/// connection now runs with WAL journaling, `synchronous = NORMAL`, foreign
/// keys on and a busy timeout. Bulk import never uses the pool; see
/// [`open_bulk_import_connection`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ConnectionOptions {}

impl diesel::r2d2::CustomizeConnection<SqliteConnection, diesel::r2d2::Error>
    for ConnectionOptions
{
    fn on_acquire(&self, conn: &mut SqliteConnection) -> Result<(), diesel::r2d2::Error> {
        configure_pooled_connection(conn).map_err(diesel::r2d2::Error::QueryError)
    }
}

fn configure_pooled_connection(conn: &mut SqliteConnection) -> QueryResult<()> {
    // The busy timeout goes first: switching to WAL may have to wait for a
    // sibling connection that is doing the same.
    conn.batch_execute(&format!(
        "PRAGMA busy_timeout = {};",
        BUSY_TIMEOUT.as_millis()
    ))?;
    enable_wal(conn)?;
    conn.batch_execute("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
    Ok(())
}

#[derive(QueryableByName)]
struct JournalModeRow {
    #[diesel(sql_type = Text)]
    journal_mode: String,
}

/// Switches the database file to write-ahead logging. WAL is persistent, so
/// this is a no-op after the first connection. Where WAL is impossible (a
/// read-only file, a filesystem without shared memory) the connection stays
/// usable with the file's existing journal mode and a warning is logged;
/// `journal_mode = OFF` is never used.
fn enable_wal(conn: &mut SqliteConnection) -> QueryResult<()> {
    match sql_query("PRAGMA journal_mode = WAL;").get_result::<JournalModeRow>(conn) {
        Ok(row) if row.journal_mode.eq_ignore_ascii_case("wal") => Ok(()),
        Ok(row) => {
            warn!(
                "could not enable WAL journaling, database stays in {} mode",
                row.journal_mode
            );
            Ok(())
        }
        Err(e) if migrate::is_readonly_error(&e) => {
            warn!("database is read-only, journaling left unchanged");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn get_db_or_create(
    state: &State<AppState>,
    db_path: &str,
    options: ConnectionOptions,
) -> Result<PooledDb, Error> {
    open_pooled(&state.connection_pool, db_path, options)
}

/// Returns a connection from the pool for `db_path`, creating the pool (and
/// migrating or creating the schema) on first use.
fn open_pooled(
    pools: &DashMap<String, DbPool>,
    db_path: &str,
    options: ConnectionOptions,
) -> Result<PooledDb, Error> {
    // Clone the pool out of the map so no shard lock is held while waiting
    // for a free connection.
    let existing = pools.get(db_path).map(|pool| pool.clone());
    if let Some(pool) = existing {
        return Ok(pool.get()?);
    }

    let pool = Pool::builder()
        .max_size(16)
        .connection_customizer(Box::new(options))
        .build(ConnectionManager::<SqliteConnection>::new(db_path))?;

    // Bring the schema up to date before the pool becomes visible to anyone.
    {
        let mut conn = pool.get()?;
        let outcome = migrate::migrate(&mut conn)?;
        info!("opened {db_path}: schema {outcome:?}");
    }

    // If another thread built a pool for the same path in the meantime, keep
    // theirs: its connections are already handed out.
    let pool = pools
        .entry(db_path.to_string())
        .or_insert(pool)
        .value()
        .clone();
    Ok(pool.get()?)
}

fn connection_error(e: ConnectionError) -> Error {
    // `Error` has no variant for diesel's connection errors; keep the message.
    Error::Diesel(Box::new(diesel::result::Error::DatabaseError(
        DatabaseErrorKind::Unknown,
        Box::new(e.to_string()),
    )))
}

/// Opens a connection for bulk writes that bypasses the shared pool, so the
/// relaxed settings used during import can never leak into ordinary edits.
/// It starts with the same durability as a pooled connection; call
/// [`begin_bulk_import`] and [`finish_bulk_import`] around the import itself.
/// Foreign keys stay off, as upstream had them for import: `insert_to_db`
/// creates every referenced row before the game.
fn open_bulk_import_connection(db_path: &str) -> Result<SqliteConnection, Error> {
    let mut conn = SqliteConnection::establish(db_path).map_err(connection_error)?;
    conn.batch_execute(&format!(
        "PRAGMA busy_timeout = {};",
        BUSY_TIMEOUT.as_millis()
    ))?;
    enable_wal(&mut conn)?;
    conn.batch_execute("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;")?;
    Ok(conn)
}

/// Turns off fsync for the duration of a bulk import. In WAL mode this keeps
/// the database consistent across an application crash; only a power loss or
/// OS crash can lose the import, which is simply re-run.
fn begin_bulk_import(conn: &mut SqliteConnection) -> QueryResult<()> {
    conn.batch_execute("PRAGMA synchronous = OFF;")
}

#[derive(QueryableByName)]
struct WalCheckpointRow {
    #[diesel(sql_type = Integer)]
    busy: i32,
}

/// Restores normal durability and folds the WAL back into the main file so
/// the import is on disk and the `-wal` file is truncated.
fn finish_bulk_import(conn: &mut SqliteConnection) -> QueryResult<()> {
    conn.batch_execute("PRAGMA synchronous = NORMAL;")?;
    let row: WalCheckpointRow = sql_query("PRAGMA wal_checkpoint(TRUNCATE);").get_result(conn)?;
    if row.busy != 0 {
        warn!("WAL checkpoint after import could not complete: another connection is busy");
    }
    Ok(())
}

fn update_info_count(
    db: &mut SqliteConnection,
    name: &str,
    value: i64,
) -> Result<(), diesel::result::Error> {
    set_info_value(db, name, &value.to_string())
}

fn set_info_value(
    db: &mut SqliteConnection,
    name: &str,
    value: &str,
) -> Result<(), diesel::result::Error> {
    diesel::insert_into(info::table)
        .values((info::name.eq(name), info::value.eq(value)))
        .on_conflict(info::name)
        .do_update()
        .set(info::value.eq(value))
        .execute(db)?;
    Ok(())
}

#[derive(Debug)]
pub struct MaterialColor {
    white: u8,
    black: u8,
}

impl Default for MaterialColor {
    fn default() -> Self {
        Self {
            white: 39,
            black: 39,
        }
    }
}

#[derive(Default, Debug)]
pub struct TempGame {
    pub event_name: Option<String>,
    pub site_name: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub round: Option<String>,
    pub white_name: Option<String>,
    pub white_elo: Option<i32>,
    pub black_name: Option<String>,
    pub black_elo: Option<i32>,
    pub result: Option<String>,
    pub time_control: Option<String>,
    pub eco: Option<String>,
    pub fen: Option<String>,
    pub moves: Vec<u8>,
    pub position: Chess,
    pub material_count: MaterialColor,
}

impl TempGame {
    pub fn insert_to_db(&self, db: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
        let pawn_home = get_pawn_home(self.position.board());

        let white_id = if let Some(name) = &self.white_name {
            create_player(db, name)?.id
        } else {
            0
        };
        let black_id = if let Some(name) = &self.black_name {
            create_player(db, name)?.id
        } else {
            0
        };

        let event_id = if let Some(name) = &self.event_name {
            create_event(db, name)?.id
        } else {
            0
        };

        let site_id = if let Some(name) = &self.site_name {
            create_site(db, name)?.id
        } else {
            0
        };

        let ply_count = iter_mainline_move_bytes(&self.moves).count() as i32;
        let final_material = get_material_count(self.position.board());
        let minimal_white_material = self.material_count.white.min(final_material.white) as i32;
        let minimal_black_material = self.material_count.black.min(final_material.black) as i32;

        let new_game = NewGame {
            white_id,
            black_id,
            ply_count,
            eco: self.eco.as_deref(),
            round: self.round.as_deref(),
            white_elo: self.white_elo,
            black_elo: self.black_elo,
            white_material: minimal_white_material,
            black_material: minimal_black_material,
            // max_rating: self.game.white.rating.max(self.game.black.rating),
            date: self.date.as_deref(),
            time: self.time.as_deref(),
            time_control: self.time_control.as_deref(),
            site_id,
            event_id,
            fen: self.fen.as_deref(),
            result: self.result.as_deref(),
            moves: self.moves.as_slice(),
            pawn_home: pawn_home as i32,
        };

        create_game(db, new_game)?;
        Ok(())
    }
}

struct Importer {
    game: TempGame,
    timestamp: Option<i64>,
    skip: bool,
    frames: Vec<ImportFrame>,
}

struct ImportFrame {
    position: Chess,
    pre_move_positions: Vec<Chess>,
}

impl ImportFrame {
    fn new(position: Chess) -> Self {
        Self {
            position,
            pre_move_positions: Vec::new(),
        }
    }
}

impl Importer {
    fn new(timestamp: Option<i64>) -> Importer {
        Importer {
            game: TempGame::default(),
            timestamp,
            skip: false,
            frames: Vec::new(),
        }
    }
}

impl Visitor for Importer {
    type Result = Option<TempGame>;

    fn begin_game(&mut self) {
        self.game = TempGame::default();
        self.skip = false;
        self.frames.clear();
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        if key == b"White" {
            self.game.white_name = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Black" {
            self.game.black_name = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"WhiteElo" {
            if value.as_bytes() == b"-" {
                self.game.white_elo = Some(0);
            } else {
                self.game.white_elo = btoi::btoi(value.as_bytes()).ok();
            }
        } else if key == b"BlackElo" {
            if value.as_bytes() == b"-" {
                self.game.black_elo = Some(0);
            } else {
                self.game.black_elo = btoi::btoi(value.as_bytes()).ok();
            }
        } else if key == b"TimeControl" {
            self.game.time_control = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"ECO" {
            self.game.eco = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Round" {
            self.game.round = Some(value.decode_utf8_lossy().into_owned());
        } else if key == b"Date" || key == b"UTCDate" {
            self.game.date = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"UTCTime" {
            self.game.time = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Site" {
            self.game.site_name = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Event" {
            self.game.event_name = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"Result" {
            self.game.result = Some(String::from_utf8_lossy(value.as_bytes()).to_string());
        } else if key == b"FEN" {
            if value.as_bytes() == b"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" {
                self.game.fen = None;
            } else {
                let fen = Fen::from_ascii(value.as_bytes());
                if let Ok(fen) = fen {
                    self.game.fen = Some(value.decode_utf8_lossy().into_owned());
                    let setup = fen.into_setup();
                    let castling_mode = CastlingMode::detect(&setup);
                    if let Ok(setup) = Chess::from_setup(setup, castling_mode)
                        .or_else(PositionError::ignore_too_much_material)
                    {
                        self.game.position = setup;
                    } else {
                        self.skip = true;
                    }
                } else {
                    self.skip = true;
                }
            }
        }
    }

    fn end_headers(&mut self) -> Skip {
        // Skip games with timestamp before
        let cur_timestamp = self.game.date.as_ref().and_then(|date| {
            let date = NaiveDate::parse_from_str(date, "%Y.%m.%d").ok()?;
            let time = self
                .game
                .time
                .as_ref()
                .and_then(|time| NaiveTime::parse_from_str(time, "%H:%M:%S").ok())?;
            Some(date.and_time(time).and_utc().timestamp())
        });

        if let (Some(cur_timestamp), Some(timestamp)) = (cur_timestamp, self.timestamp) {
            if cur_timestamp <= timestamp {
                self.skip = true;
            }
        }

        // Skip games without ELO
        // self.skip |= self.current.white_elo.is_none() || self.current.black_elo.is_none();

        self.frames.clear();
        self.frames
            .push(ImportFrame::new(self.game.position.clone()));

        Skip(self.skip)
    }

    fn san(&mut self, san: SanPlus) {
        if self.frames.is_empty() {
            self.frames
                .push(ImportFrame::new(self.game.position.clone()));
        }

        let is_mainline = self.frames.len() == 1;
        let frame = self.frames.last_mut().unwrap();
        let pre_move_position = frame.position.clone();

        let m = san.san.to_move(&frame.position).ok();
        if let Some(m) = m {
            if is_mainline && m.is_promotion() {
                let cur_material = get_material_count(frame.position.board());
                if cur_material.white < self.game.material_count.white {
                    self.game.material_count.white = cur_material.white;
                }
                if cur_material.black < self.game.material_count.black {
                    self.game.material_count.black = cur_material.black;
                }
            }
            self.game
                .moves
                .push(encode_move(&m, &frame.position).unwrap());
            frame.pre_move_positions.push(pre_move_position);
            frame.position.play_unchecked(&m);

            if is_mainline {
                self.game.position = frame.position.clone();
            }
        } else {
            self.skip = true;
        }
    }

    fn begin_variation(&mut self) -> Skip {
        if self.frames.is_empty() {
            self.frames
                .push(ImportFrame::new(self.game.position.clone()));
        }

        let parent = self.frames.last().unwrap();
        let variation_start = parent
            .pre_move_positions
            .last()
            .cloned()
            .unwrap_or_else(|| parent.position.clone());

        self.game.moves.push(VARIATION_START_MARKER);
        self.frames.push(ImportFrame::new(variation_start));
        Skip(false)
    }

    fn end_variation(&mut self) {
        self.game.moves.push(VARIATION_END_MARKER);
        if self.frames.len() > 1 {
            self.frames.pop();
        } else {
            self.skip = true;
        }

        if let Some(root) = self.frames.first() {
            self.game.position = root.position.clone();
        }
    }

    fn comment(&mut self, comment: pgn_reader::RawComment<'_>) {
        let comment = String::from_utf8_lossy(comment.as_bytes());
        encode_comment(comment.as_ref(), &mut self.game.moves);
    }

    fn nag(&mut self, nag: Nag) {
        encode_nag(&nag.to_string(), &mut self.game.moves);
    }

    fn end_game(&mut self) -> Self::Result {
        self.frames.clear();
        if self.skip {
            self.game = TempGame::default();
            None
        } else {
            Some(std::mem::take(&mut self.game))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn convert_pgn(
    files: Vec<PathBuf>,
    db_path: PathBuf,
    timestamp: Option<i32>,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
) -> Result<(), Error> {
    if files.is_empty() {
        return Ok(());
    }

    let description = description.unwrap_or_default();

    // Bulk import gets its own connection: the pool would cache whatever
    // settings it was opened with for every later edit on this database.
    let mut db = open_bulk_import_connection(db_path.to_str().unwrap())?;

    // Creates the schema for a new file, stamps or upgrades an existing one.
    // This runs with normal durability so the schema is on disk before the
    // unsynced import starts.
    let outcome = migrate::migrate(&mut db)?;
    let is_new = outcome == migrate::MigrationOutcome::Created;
    if is_new {
        set_info_value(&mut db, "Version", DATABASE_VERSION)?;
        set_info_value(&mut db, "Title", &title)?;
        set_info_value(&mut db, "Description", &description)?;
    }

    // start counting time
    let start = Instant::now();

    let imported = bulk_import(
        &mut db,
        &files,
        timestamp.map(i64::from),
        is_new,
        |count, current_file_name| {
            let elapsed = start.elapsed().as_millis() as u32;
            app.emit("convert_progress", (count, elapsed, current_file_name))
                .unwrap();
        },
    );
    // Restore durability even when the import failed part-way.
    let finished = finish_bulk_import(&mut db);
    imported?;
    finished?;

    Ok(())
}

/// Runs the unsynced part of an import on a connection from
/// [`open_bulk_import_connection`]: inserts every game in `files`, builds the
/// indexes when `create_indexes` is set (a fresh database imports faster
/// without them) and refreshes the counts in the `Info` table. The caller
/// must follow up with [`finish_bulk_import`].
fn bulk_import(
    db: &mut SqliteConnection,
    files: &[PathBuf],
    timestamp: Option<i64>,
    create_indexes: bool,
    on_progress: impl FnMut(usize, Option<&str>),
) -> Result<(), Error> {
    begin_bulk_import(db)?;

    import_pgn_files(db, files, timestamp, on_progress)?;

    if create_indexes {
        // Create all the necessary indexes
        db.batch_execute(INDEXES_SQL)?;
    }

    // get game, player, event and site counts and to the info table
    let game_count: i64 = games::table.count().get_result(db)?;
    let player_count: i64 = players::table.count().get_result(db)?;
    let event_count: i64 = events::table.count().get_result(db)?;
    let site_count: i64 = sites::table.count().get_result(db)?;

    update_info_count(db, "GameCount", game_count)?;
    update_info_count(db, "PlayerCount", player_count)?;
    update_info_count(db, "EventCount", event_count)?;
    update_info_count(db, "SiteCount", site_count)?;

    Ok(())
}

/// Parses every PGN (optionally bz2 or zstd compressed) file in `files` and
/// inserts its games, one transaction per file: a failure leaves earlier
/// files committed and the failing file untouched. `on_progress` is called
/// every 1000 games with the running total and the current file name.
/// Returns the number of games inserted.
fn import_pgn_files(
    db: &mut SqliteConnection,
    files: &[PathBuf],
    timestamp: Option<i64>,
    mut on_progress: impl FnMut(usize, Option<&str>),
) -> Result<usize, Error> {
    let mut imported_games = 0usize;

    for file_path in files {
        let current_file_name = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let extension = file_path.extension();
        let file = File::open(file_path)?;

        let uncompressed: Box<dyn std::io::Read + Send> = if extension == Some("bz2".as_ref()) {
            Box::new(bzip2::read::MultiBzDecoder::new(file))
        } else if extension == Some("zst".as_ref()) {
            Box::new(zstd::Decoder::new(file)?)
        } else {
            Box::new(file)
        };

        let mut importer = Importer::new(timestamp);
        let mut file_imported_games = 0usize;

        db.transaction::<_, diesel::result::Error, _>(|db| {
            for game in BufferedReader::new(uncompressed)
                .into_iter(&mut importer)
                .flatten()
                .flatten()
            {
                if (imported_games + file_imported_games).is_multiple_of(1000) {
                    on_progress(
                        imported_games + file_imported_games,
                        current_file_name.as_deref(),
                    );
                }
                game.insert_to_db(db)?;
                file_imported_games += 1;
            }
            Ok(())
        })?;

        imported_games += file_imported_games;
    }

    Ok(imported_games)
}

pub fn generate_search_index(
    db_path: &Path,
    state: &tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(
        state,
        db_path.to_str().unwrap(),
        ConnectionOptions::default(),
    )?;
    let index_path = get_index_path(db_path);

    info!("Generating search index at {:?}", index_path);
    let start = Instant::now();

    #[allow(clippy::type_complexity)]
    let games: Vec<(
        i32,
        i32,
        i32,
        Option<String>,
        Option<String>,
        Vec<u8>,
        Option<String>,
        i32,
        i32,
        i32,
        Option<i32>,
        Option<i32>,
    )> = games::table
        .select((
            games::id,
            games::white_id,
            games::black_id,
            games::date,
            games::result,
            games::moves,
            games::fen,
            games::pawn_home,
            games::white_material,
            games::black_material,
            games::white_elo,
            games::black_elo,
        ))
        .load(db)?;

    let mut writer = SearchIndex::with_capacity(games.len());
    for (
        id,
        white_id,
        black_id,
        date,
        result,
        moves,
        fen,
        pawn_home,
        white_material,
        black_material,
        white_elo,
        black_elo,
    ) in games
    {
        let entry = SearchGameEntry::from_game_data(
            id,
            white_id,
            black_id,
            date,
            result,
            moves,
            fen,
            pawn_home,
            white_material,
            black_material,
            white_elo,
            black_elo,
        );
        writer.push(entry);
    }
    writer.write_to(&index_path)?;

    info!("Search index generated in {:?}", start.elapsed());
    Ok(())
}

#[derive(Serialize, Type)]
pub struct DatabaseInfo {
    title: String,
    description: String,
    player_count: i32,
    event_count: i32,
    game_count: i32,
    storage_size: u64,
    filename: String,
    indexed: bool,
}

#[derive(QueryableByName, Debug, Serialize)]
struct IndexInfo {
    #[diesel(sql_type = Text, column_name = "name")]
    _name: String,
}

fn check_index_exists(conn: &mut SqliteConnection) -> Result<bool, Error> {
    let query = sql_query("SELECT name FROM pragma_index_list('Games');");
    let indexes: Vec<IndexInfo> = query.load(conn)?;
    Ok(!indexes.is_empty())
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_info(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<DatabaseInfo, Error> {
    info!("get_db_info {:?}", file);

    let path = file;

    let db = &mut get_db_or_create(&state, path.to_str().unwrap(), ConnectionOptions::default())?;

    let info_records: Vec<Info> = info::table.load(db)?;

    let get_info_value = |key: &str| -> Option<String> {
        info_records
            .iter()
            .find(|i| i.name == key)
            .and_then(|i| i.value.clone())
    };

    let title = get_info_value("Title").unwrap_or_else(|| "Untitled".to_string());
    let description = get_info_value("Description").unwrap_or_default();
    let player_count = get_info_value("PlayerCount")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    let game_count = get_info_value("GameCount")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);
    let event_count = get_info_value("EventCount")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);

    let storage_size = path.metadata()?.len();
    let filename = path.file_name().expect("get filename").to_string_lossy();

    let is_indexed = check_index_exists(db)?;
    Ok(DatabaseInfo {
        title,
        description,
        player_count,
        game_count,
        event_count,
        storage_size,
        filename: filename.to_string(),
        indexed: is_indexed,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_indexes(file: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(INDEXES_SQL)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_indexes(file: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(DELETE_INDEXES_SQL)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn edit_db_info(
    file: PathBuf,
    title: Option<String>,
    description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    if let Some(title) = title {
        diesel::insert_into(info::table)
            .values((info::name.eq("Title"), info::value.eq(title.clone())))
            .on_conflict(info::name)
            .do_update()
            .set(info::value.eq(title))
            .execute(db)?;
    }

    if let Some(description) = description {
        diesel::insert_into(info::table)
            .values((
                info::name.eq("Description"),
                info::value.eq(description.clone()),
            ))
            .on_conflict(info::name)
            .do_update()
            .set(info::value.eq(description))
            .execute(db)?;
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum Sides {
    BlackWhite,
    WhiteBlack,
    Any,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum GameSort {
    #[default]
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "whiteElo")]
    WhiteElo,
    #[serde(rename = "blackElo")]
    BlackElo,
    #[serde(rename = "ply_count")]
    PlyCount,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum SortDirection {
    #[serde(rename = "asc")]
    Asc,
    #[default]
    #[serde(rename = "desc")]
    Desc,
}

#[derive(Default, Debug, Clone, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions<SortT> {
    pub skip_count: bool,
    #[specta(optional)]
    pub page: Option<i32>,
    #[specta(optional)]
    pub page_size: Option<i32>,
    pub sort: SortT,
    pub direction: SortDirection,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Hash, Type)]
pub struct GameQuery {
    #[specta(optional)]
    pub options: Option<QueryOptions<GameSort>>,
    #[specta(optional)]
    pub player1: Option<i32>,
    #[specta(optional)]
    pub player2: Option<i32>,
    #[specta(optional)]
    pub tournament_id: Option<i32>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub range1: Option<(i32, i32)>,
    #[specta(optional)]
    pub range2: Option<(i32, i32)>,
    #[specta(optional)]
    pub sides: Option<Sides>,
    #[specta(optional)]
    pub outcome: Option<String>,
    #[specta(optional)]
    pub position: Option<PositionQueryJs>,
    #[specta(optional)]
    pub wanted_result: Option<String>,
}

impl GameQuery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn position(mut self, position: PositionQueryJs) -> Self {
        self.position = Some(position);
        self
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct QueryResponse<T> {
    pub data: T,
    pub count: Option<i32>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_games(
    file: PathBuf,
    query: GameQuery,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let mut count: Option<i64> = None;
    let query_options = query.options.unwrap_or_default();

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let mut sql_query = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .into_boxed();
    let mut count_query = games::table.into_boxed();

    // if let Some(speed) = query.speed {
    //     sql_query = sql_query.filter(games::speed.eq(speed as i32));
    //     count_query = count_query.filter(games::speed.eq(speed as i32));
    // }

    if let Some(outcome) = query.outcome {
        sql_query = sql_query.filter(games::result.eq(outcome.clone()));
        count_query = count_query.filter(games::result.eq(outcome));
    }

    if let Some(start_date) = query.start_date {
        sql_query = sql_query.filter(games::date.ge(start_date.clone()));
        count_query = count_query.filter(games::date.ge(start_date));
    }

    if let Some(end_date) = query.end_date {
        sql_query = sql_query.filter(games::date.le(end_date.clone()));
        count_query = count_query.filter(games::date.le(end_date));
    }

    if let Some(tournament_id) = query.tournament_id {
        sql_query = sql_query.filter(games::event_id.eq(tournament_id));
        count_query = count_query.filter(games::event_id.eq(tournament_id));
    }

    if let Some(limit) = query_options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query_options.page {
        sql_query = sql_query.offset(((page - 1) * query_options.page_size.unwrap_or(10)) as i64);
    }

    match query.sides {
        Some(Sides::BlackWhite) => {
            if let Some(player1) = query.player1 {
                sql_query = sql_query.filter(games::black_id.eq(player1));
                count_query = count_query.filter(games::black_id.eq(player1));
            }
            if let Some(player2) = query.player2 {
                sql_query = sql_query.filter(games::white_id.eq(player2));
                count_query = count_query.filter(games::white_id.eq(player2));
            }

            if let Some(range1) = query.range1 {
                sql_query = sql_query.filter(games::black_elo.between(range1.0, range1.1));
                count_query = count_query.filter(games::black_elo.between(range1.0, range1.1));
            }

            if let Some(range2) = query.range2 {
                sql_query = sql_query.filter(games::white_elo.between(range2.0, range2.1));
                count_query = count_query.filter(games::white_elo.between(range2.0, range2.1));
            }
        }
        Some(Sides::WhiteBlack) => {
            if let Some(player1) = query.player1 {
                sql_query = sql_query.filter(games::white_id.eq(player1));
                count_query = count_query.filter(games::white_id.eq(player1));
            }
            if let Some(player2) = query.player2 {
                sql_query = sql_query.filter(games::black_id.eq(player2));
                count_query = count_query.filter(games::black_id.eq(player2));
            }

            if let Some(range1) = query.range1 {
                sql_query = sql_query.filter(games::white_elo.between(range1.0, range1.1));
                count_query = count_query.filter(games::white_elo.between(range1.0, range1.1));
            }

            if let Some(range2) = query.range2 {
                sql_query = sql_query.filter(games::black_elo.between(range2.0, range2.1));
                count_query = count_query.filter(games::black_elo.between(range2.0, range2.1));
            }
        }
        Some(Sides::Any) => {
            if let Some(player1) = query.player1 {
                sql_query =
                    sql_query.filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
                count_query =
                    count_query.filter(games::white_id.eq(player1).or(games::black_id.eq(player1)));
            }
            if let Some(player2) = query.player2 {
                sql_query =
                    sql_query.filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
                count_query =
                    count_query.filter(games::white_id.eq(player2).or(games::black_id.eq(player2)));
            }

            if let (Some(range1), Some(range2)) = (query.range1, query.range2) {
                sql_query = sql_query.filter(
                    games::white_elo
                        .between(range1.0, range1.1)
                        .or(games::black_elo.between(range1.0, range1.1))
                        .or(games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1))),
                );
                count_query = count_query.filter(
                    games::white_elo
                        .between(range1.0, range1.1)
                        .or(games::black_elo.between(range1.0, range1.1))
                        .or(games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1))),
                );
            } else {
                if let Some(range1) = query.range1 {
                    sql_query = sql_query.filter(
                        games::white_elo
                            .between(range1.0, range1.1)
                            .or(games::black_elo.between(range1.0, range1.1)),
                    );
                    count_query = count_query.filter(
                        games::white_elo
                            .between(range1.0, range1.1)
                            .or(games::black_elo.between(range1.0, range1.1)),
                    );
                }

                if let Some(range2) = query.range2 {
                    sql_query = sql_query.filter(
                        games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1)),
                    );
                    count_query = count_query.filter(
                        games::white_elo
                            .between(range2.0, range2.1)
                            .or(games::black_elo.between(range2.0, range2.1)),
                    );
                }
            }
        }
        None => {}
    }

    sql_query = match query_options.sort {
        GameSort::Id => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::id.asc()),
            SortDirection::Desc => sql_query.order(games::id.desc()),
        },
        GameSort::Date => match query_options.direction {
            SortDirection::Asc => sql_query.order((games::date.asc(), games::time.asc())),
            SortDirection::Desc => sql_query.order((games::date.desc(), games::time.desc())),
        },
        GameSort::WhiteElo => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::white_elo.asc()),
            SortDirection::Desc => sql_query.order(games::white_elo.desc()),
        },
        GameSort::BlackElo => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::black_elo.asc()),
            SortDirection::Desc => sql_query.order(games::black_elo.desc()),
        },
        GameSort::PlyCount => match query_options.direction {
            SortDirection::Asc => sql_query.order(games::ply_count.asc()),
            SortDirection::Desc => sql_query.order(games::ply_count.desc()),
        },
    };

    if !query_options.skip_count {
        count = Some(
            count_query
                .select(diesel::dsl::count(games::id))
                .first(db)?,
        );
    }

    // println!(
    //     "{:?}\n",
    //     diesel::debug_query::<diesel::sqlite::Sqlite, _>(&sql_query)
    // );

    let games: Vec<(Game, Player, Player, Event, Site)> = sql_query.load(db)?;
    let normalized_games = normalize_games(games);

    Ok(QueryResponse {
        data: normalized_games,
        count: count.map(|c| c as i32),
    })
}

fn normalize_games(games: Vec<(Game, Player, Player, Event, Site)>) -> Vec<NormalizedGame> {
    games
        .into_iter()
        .map(|(game, white, black, event, site)| {
            let fen: Fen = game
                .fen
                .map(|f| Fen::from_ascii(f.as_bytes()).unwrap())
                .unwrap_or_default();
            let game_result = game.result.clone().unwrap_or_default();
            let result_token = if game_result.is_empty() {
                "*".to_string()
            } else {
                game_result.clone()
            };

            NormalizedGame {
                id: game.id,
                event: event.name.unwrap_or_default(),
                event_id: event.id,
                site: site.name.unwrap_or_default(),
                site_id: site.id,
                date: game.date,
                time: game.time,
                round: game.round,
                white: white.name.unwrap_or_default(),
                white_id: game.white_id,
                white_elo: game.white_elo,
                black: black.name.unwrap_or_default(),
                black_id: game.black_id,
                black_elo: game.black_elo,
                result: Outcome::from_str(&game_result).unwrap_or_default(),
                time_control: game.time_control,
                eco: game.eco,
                ply_count: game.ply_count,
                fen: fen.to_string(),
                moves: {
                    let movetext = decode_game_to_movetext(&game.moves, fen).unwrap_or_default();
                    if movetext.is_empty() {
                        result_token
                    } else {
                        format!("{} {}", movetext, result_token)
                    }
                },
            }
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct PlayerQuery {
    pub options: QueryOptions<PlayerSort>,
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub range: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum PlayerSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "elo")]
    Elo,
}

#[tauri::command]
#[specta::specta]
pub async fn get_player(
    file: PathBuf,
    id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Player>, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let player = players::table
        .filter(players::id.eq(id))
        .first::<Player>(db)
        .optional()?;
    Ok(player)
}

#[tauri::command]
#[specta::specta]
pub async fn get_players(
    file: PathBuf,
    query: PlayerQuery,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Player>>, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let mut count: Option<i64> = None;

    let mut sql_query = players::table.into_boxed();
    let mut count_query = players::table.into_boxed();
    sql_query = sql_query.filter(players::name.is_not("Unknown"));
    count_query = count_query.filter(players::name.is_not("Unknown"));

    if let Some(name) = query.name {
        sql_query = sql_query.filter(players::name.like(format!("%{}%", name)));
        count_query = count_query.filter(players::name.like(format!("%{}%", name)));
    }

    if let Some(range) = query.range {
        sql_query = sql_query.filter(players::elo.between(range.0, range.1));
        count_query = count_query.filter(players::elo.between(range.0, range.1));
    }

    if !query.options.skip_count {
        count = Some(count_query.count().get_result(db)?);
    }

    if let Some(limit) = query.options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query.options.page {
        sql_query = sql_query.offset(((page - 1) * query.options.page_size.unwrap_or(10)) as i64);
    }

    sql_query = match query.options.sort {
        PlayerSort::Id => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::id.asc()),
            SortDirection::Desc => sql_query.order(players::id.desc()),
        },
        PlayerSort::Name => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::name.asc()),
            SortDirection::Desc => sql_query.order(players::name.desc()),
        },
        PlayerSort::Elo => match query.options.direction {
            SortDirection::Asc => sql_query.order(players::elo.asc()),
            SortDirection::Desc => sql_query.order(players::elo.desc()),
        },
    };

    let players = sql_query.load::<Player>(db)?;

    Ok(QueryResponse {
        data: players,
        count: count.map(|c| c as i32),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TournamentSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct TournamentQuery {
    pub options: QueryOptions<TournamentSort>,
    pub name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_tournaments(
    file: PathBuf,
    query: TournamentQuery,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Event>>, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let mut count: Option<i64> = None;

    let mut sql_query = events::table.into_boxed();
    let mut count_query = events::table.into_boxed();
    sql_query = sql_query.filter(events::name.is_not("Unknown").and(events::name.is_not("")));
    count_query = count_query.filter(events::name.is_not("Unknown").and(events::name.is_not("")));

    if let Some(name) = query.name {
        sql_query = sql_query.filter(events::name.like(format!("%{}%", name)));
        count_query = count_query.filter(events::name.like(format!("%{}%", name)));
    }

    if !query.options.skip_count {
        count = Some(count_query.count().get_result(db)?);
    }

    if let Some(limit) = query.options.page_size {
        sql_query = sql_query.limit(limit as i64);
    }

    if let Some(page) = query.options.page {
        sql_query = sql_query.offset(((page - 1) * query.options.page_size.unwrap_or(10)) as i64);
    }

    sql_query = match query.options.sort {
        TournamentSort::Id => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::id.asc()),
            SortDirection::Desc => sql_query.order(events::id.desc()),
        },
        TournamentSort::Name => match query.options.direction {
            SortDirection::Asc => sql_query.order(events::name.asc()),
            SortDirection::Desc => sql_query.order(events::name.desc()),
        },
    };

    let events = sql_query.load::<Event>(db)?;

    Ok(QueryResponse {
        data: events,
        count: count.map(|c| c as i32),
    })
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct PlayerGameInfo {
    pub site_stats_data: Vec<SiteStatsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[repr(u8)] // Ensure minimal memory usage (as u8)
pub enum GameOutcome {
    #[default]
    Won = 0,
    Drawn = 1,
    Lost = 2,
}

impl GameOutcome {
    pub fn from_str(result_str: &str, is_white: bool) -> Option<Self> {
        match result_str {
            "1-0" => Some(if is_white {
                GameOutcome::Won
            } else {
                GameOutcome::Lost
            }),
            "1/2-1/2" => Some(GameOutcome::Drawn),
            "0-1" => Some(if is_white {
                GameOutcome::Lost
            } else {
                GameOutcome::Won
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct SiteStatsData {
    pub site: String,
    pub player: String,
    pub data: Vec<StatsData>,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct StatsData {
    pub date: String,
    pub is_player_white: bool,
    pub player_elo: i32,
    pub result: GameOutcome,
    pub time_control: String,
    pub opening: String,
}

#[derive(Serialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct DatabaseProgress {
    pub id: String,
    pub progress: f64,
}

#[tauri::command]
#[specta::specta]
pub async fn get_players_game_info(
    file: PathBuf,
    id: i32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PlayerGameInfo, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let timer = Instant::now();

    let sql_query = games::table
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .inner_join(players::table.on(players::id.eq(id)))
        .select((
            games::white_id,
            games::black_id,
            games::result,
            games::date,
            games::moves,
            games::white_elo,
            games::black_elo,
            games::time_control,
            sites::name,
            players::name,
        ))
        .filter(games::white_id.eq(id).or(games::black_id.eq(id)))
        .filter(games::fen.is_null());

    type GameInfo = (
        i32,
        i32,
        Option<String>,
        Option<String>,
        Vec<u8>,
        Option<i32>,
        Option<i32>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let info: Vec<GameInfo> = sql_query.load(db)?;

    let mut game_info = PlayerGameInfo::default();
    let progress = AtomicUsize::new(0);
    game_info.site_stats_data = info
        .par_iter()
        .filter_map(
            |(
                white_id,
                black_id,
                outcome,
                date,
                moves,
                white_elo,
                black_elo,
                time_control,
                site,
                player,
            )| {
                let is_white = *white_id == id;
                let is_black = *black_id == id;
                let result = GameOutcome::from_str(outcome.as_deref()?, is_white);

                if !is_white && !is_black
                    || is_white && white_elo.is_none()
                    || is_black && black_elo.is_none()
                    || result.is_none()
                    || date.is_none()
                    || site.is_none()
                    || player.is_none()
                {
                    return None;
                }

                let site = site.as_deref().map(|s| {
                    if s.starts_with("https://lichess.org/") {
                        "Lichess".to_string()
                    } else {
                        s.to_string()
                    }
                })?;

                let mut setups = vec![];
                let mut chess = Chess::default();
                for (i, byte) in iter_mainline_move_bytes(moves).enumerate() {
                    if i > 54 {
                        // max length of opening in data
                        break;
                    }
                    let Some(m) = decode_move(byte, &chess) else {
                        break;
                    };
                    chess.play_unchecked(&m);
                    setups.push(chess.clone().into_setup(EnPassantMode::Legal));
                }

                setups.reverse();
                let opening = setups
                    .iter()
                    .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
                    .unwrap_or_default();

                let p = progress.fetch_add(1, Ordering::Relaxed);
                if p.is_multiple_of(1000) || p == info.len() - 1 {
                    let _ = DatabaseProgress {
                        id: id.to_string(),
                        progress: (p as f64 / info.len() as f64) * 100_f64,
                    }
                    .emit(&app);
                }

                Some(SiteStatsData {
                    site: site.clone(),
                    player: player.clone().unwrap(),
                    data: vec![StatsData {
                        date: date.clone().unwrap(),
                        is_player_white: is_white,
                        player_elo: if is_white {
                            white_elo.unwrap()
                        } else {
                            black_elo.unwrap()
                        },
                        result: result.unwrap(),
                        time_control: time_control.clone().unwrap_or_default(),
                        opening,
                    }],
                })
            },
        )
        .fold(DashMap::new, |acc, data| {
            acc.entry((data.site.clone(), data.player.clone()))
                .or_insert_with(Vec::new)
                .extend(data.data);
            acc
        })
        .reduce(DashMap::new, |acc1, acc2| {
            for ((site, player), data) in acc2 {
                acc1.entry((site, player))
                    .or_insert_with(Vec::new)
                    .extend(data);
            }
            acc1
        })
        .into_iter()
        .map(|((site, player), data)| SiteStatsData { site, player, data })
        .collect();

    println!("get_players_game_info {:?}: {:?}", file, timer.elapsed());

    Ok(game_info)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_database(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let pool = &state.connection_pool;
    let path_str = file.to_str().unwrap();
    pool.remove(path_str);

    // delete file
    remove_file(path_str)?;
    // A stale WAL next to a new database of the same name would be replayed
    // into it, so remove the WAL side files too (absent when SQLite already
    // cleaned up on close).
    for suffix in ["-wal", "-shm"] {
        let _ = remove_file(format!("{path_str}{suffix}"));
    }
    remove_file(get_index_path(&PathBuf::from(path_str)))?;
    Ok(())
}

fn delete_orphaned_data(db: &mut SqliteConnection) -> Result<(), Error> {
    db.batch_execute(
        "
        DELETE FROM Players WHERE ID != 0 AND ID NOT IN (
            SELECT WhiteID FROM Games UNION SELECT BlackID FROM Games
        );
        DELETE FROM Events WHERE ID != 0 AND ID NOT IN (
            SELECT EventID FROM Games
        );
        DELETE FROM Sites WHERE ID != 0 AND ID NOT IN (
            SELECT SiteID FROM Games
        );
        ",
    )?;

    let player_count: i64 = players::table.count().get_result(db)?;
    update_info_count(db, "PlayerCount", player_count)?;

    let event_count: i64 = events::table.count().get_result(db)?;
    update_info_count(db, "EventCount", event_count)?;

    let site_count: i64 = sites::table.count().get_result(db)?;
    update_info_count(db, "SiteCount", site_count)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_duplicated_games(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    db.batch_execute(
        "
        DELETE FROM Games
        WHERE ID IN (
            SELECT ID
            FROM (
                SELECT ID,
                    ROW_NUMBER() OVER (PARTITION BY EventID, SiteID, Round, WhiteID, BlackID, Moves, Date, UTCTime ORDER BY ID) AS RowNum
                FROM Games
            ) AS Subquery
            WHERE RowNum > 1
        );
        ",
    )?;

    let game_count: i64 = games::table.count().get_result(db)?;
    update_info_count(db, "GameCount", game_count)?;
    delete_orphaned_data(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_empty_games(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    diesel::delete(games::table.filter(games::ply_count.eq(0))).execute(db)?;

    let game_count: i64 = games::table.count().get_result(db)?;
    update_info_count(db, "GameCount", game_count)?;
    delete_orphaned_data(db)?;

    Ok(())
}

struct PgnGame {
    event: Option<String>,
    site: Option<String>,
    date: Option<String>,
    round: Option<String>,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    time_control: Option<String>,
    eco: Option<String>,
    white_elo: Option<String>,
    black_elo: Option<String>,
    ply_count: Option<String>,
    fen: Option<String>,
    moves: Option<String>,
}

impl PgnGame {
    fn write(&self, writer: &mut impl Write) -> Result<(), Error> {
        writeln!(
            writer,
            "[Event \"{}\"]",
            self.event.as_deref().unwrap_or("")
        )?;
        writeln!(writer, "[Site \"{}\"]", self.site.as_deref().unwrap_or(""))?;
        writeln!(writer, "[Date \"{}\"]", self.date.as_deref().unwrap_or(""))?;
        writeln!(
            writer,
            "[Round \"{}\"]",
            self.round.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[White \"{}\"]",
            self.white.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[Black \"{}\"]",
            self.black.as_deref().unwrap_or("")
        )?;
        writeln!(
            writer,
            "[Result \"{}\"]",
            self.result.as_deref().unwrap_or("*")
        )?;
        if let Some(time_control) = self.time_control.as_deref() {
            writeln!(writer, "[TimeControl \"{}\"]", time_control)?;
        }
        if let Some(eco) = self.eco.as_deref() {
            writeln!(writer, "[ECO \"{}\"]", eco)?;
        }
        if let Some(white_elo) = self.white_elo.as_deref() {
            if white_elo == "0" {
                writeln!(writer, "[WhiteElo \"-\"]")?;
            } else {
                writeln!(writer, "[WhiteElo \"{}\"]", white_elo)?;
            }
        }
        if let Some(black_elo) = self.black_elo.as_deref() {
            if black_elo == "0" {
                writeln!(writer, "[BlackElo \"-\"]")?;
            } else {
                writeln!(writer, "[BlackElo \"{}\"]", black_elo)?;
            }
        }
        if let Some(ply_count) = self.ply_count.as_deref() {
            writeln!(writer, "[PlyCount \"{}\"]", ply_count)?;
        }
        if let Some(fen) = self.fen.as_deref() {
            writeln!(writer, "[SetUp \"1\"]")?;
            writeln!(writer, "[FEN \"{}\"]", fen)?;
        }
        writeln!(writer)?;
        if let Some(moves) = self.moves.as_deref() {
            if !moves.is_empty() {
                write!(writer, "{} ", moves)?;
            }
        }
        match self.result.as_deref() {
            Some("1-0") => writeln!(writer, "1-0"),
            Some("0-1") => writeln!(writer, "0-1"),
            Some("1/2-1/2") => writeln!(writer, "1/2-1/2"),
            _ => writeln!(writer, "*"),
        }?;
        writeln!(writer)?;
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn export_to_pgn(
    file: PathBuf,
    dest_file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dest_file)?;

    let mut writer = BufWriter::new(file);

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?
        .flatten()
        .map(|(game, white, black, event, site)| {
            let pgn = PgnGame {
                event: event.name,
                site: site.name,
                date: game.date,
                round: game.round,
                white: white.name,
                black: black.name,
                result: game.result,
                time_control: game.time_control,
                eco: game.eco,
                white_elo: game.white_elo.map(|e| e.to_string()),
                black_elo: game.black_elo.map(|e| e.to_string()),
                ply_count: game.ply_count.map(|e| e.to_string()),
                fen: game.fen.clone(),
                moves: decode_game_to_movetext(
                    &game.moves,
                    if let Some(fen) = game.fen {
                        Fen::from_ascii(fen.as_bytes()).unwrap_or_default()
                    } else {
                        Fen::default()
                    },
                )
                .ok(),
            };

            pgn.write(&mut writer)?;

            Ok(())
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_db_game(
    file: PathBuf,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    diesel::delete(games::table.filter(games::id.eq(game_id))).execute(db)?;

    let game_count: i64 = games::table.count().get_result(db)?;
    update_info_count(db, "GameCount", game_count)?;
    delete_orphaned_data(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn write_db_game(
    file: PathBuf,
    game_id: i32,
    pgn: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    let mut importer = Importer::new(None);
    let mut parsed = BufferedReader::new(pgn.as_bytes())
        .into_iter(&mut importer)
        .flatten()
        .flatten();
    let temp_game = parsed.next().ok_or(Error::NoMovesFound)?;

    let white_id = if let Some(name) = temp_game.white_name.as_deref() {
        create_player(db, name)?.id
    } else {
        0
    };
    let black_id = if let Some(name) = temp_game.black_name.as_deref() {
        create_player(db, name)?.id
    } else {
        0
    };
    let event_id = if let Some(name) = temp_game.event_name.as_deref() {
        create_event(db, name)?.id
    } else {
        0
    };
    let site_id = if let Some(name) = temp_game.site_name.as_deref() {
        create_site(db, name)?.id
    } else {
        0
    };

    let final_material = get_material_count(temp_game.position.board());
    let minimal_white_material = temp_game.material_count.white.min(final_material.white) as i32;
    let minimal_black_material = temp_game.material_count.black.min(final_material.black) as i32;
    let pawn_home = get_pawn_home(temp_game.position.board()) as i32;
    let ply_count = iter_mainline_move_bytes(&temp_game.moves).count() as i32;

    let updated_rows = diesel::update(games::table.filter(games::id.eq(game_id)))
        .set((
            games::event_id.eq(event_id),
            games::site_id.eq(site_id),
            games::date.eq(temp_game.date),
            games::time.eq(temp_game.time),
            games::round.eq(temp_game.round),
            games::white_id.eq(white_id),
            games::white_elo.eq(temp_game.white_elo),
            games::black_id.eq(black_id),
            games::black_elo.eq(temp_game.black_elo),
            games::white_material.eq(minimal_white_material),
            games::black_material.eq(minimal_black_material),
            games::result.eq(temp_game.result),
            games::time_control.eq(temp_game.time_control),
            games::eco.eq(temp_game.eco),
            games::ply_count.eq(ply_count),
            games::fen.eq(temp_game.fen),
            games::moves.eq(temp_game.moves),
            games::pawn_home.eq(pawn_home),
        ))
        .execute(db)?;

    if updated_rows == 0 {
        return Err(Error::GameNotFound(game_id.to_string()));
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn merge_players(
    file: PathBuf,
    player1: i32,
    player2: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;

    // Check if the players never played against each other
    let count: i64 = games::table
        .filter(games::white_id.eq(player1).and(games::black_id.eq(player2)))
        .or_filter(games::white_id.eq(player2).and(games::black_id.eq(player1)))
        .limit(1)
        .count()
        .get_result(db)?;

    if count > 0 {
        return Err(Error::NotDistinctPlayers);
    }

    diesel::update(games::table.filter(games::white_id.eq(player1)))
        .set(games::white_id.eq(player2))
        .execute(db)?;
    diesel::update(games::table.filter(games::black_id.eq(player1)))
        .set(games::black_id.eq(player2))
        .execute(db)?;

    diesel::delete(players::table.filter(players::id.eq(player1))).execute(db)?;

    let player_count: i64 = players::table.count().get_result(db)?;
    update_info_count(db, "PlayerCount", player_count)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_games(state: tauri::State<'_, AppState>) {
    let mut state = state.db_cache.lock().unwrap();
    *state = None;
}

#[tauri::command]
#[specta::specta]
pub async fn preload_reference_db(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let index_path = get_index_path(&file);

    if !MmapSearchIndex::is_valid(&index_path) {
        info!("Search index not found for reference database, generating...");
        generate_search_index(&file, &state)?;
    }

    let mut cache = state.db_cache.lock().unwrap();
    if cache.is_none() {
        info!("Preloading reference database from {:?}", index_path);
        match MmapSearchIndex::open(&index_path) {
            Ok(index) => {
                info!("Preloaded reference database with {} games", index.len());
                *cache = Some(index);
            }
            Err(e) => {
                return Err(Error::from(e));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgn_reader::BufferedReader;

    #[test]
    fn home_row() {
        use shakmaty::Board;

        let pawn_home = get_pawn_home(&Board::default());
        assert_eq!(pawn_home, 0b1111111111111111);

        let pawn_home = get_pawn_home(
            &Board::from_ascii_board_fen(b"8/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/8").unwrap(),
        );
        assert_eq!(pawn_home, 0b1110111111101111);

        let pawn_home = get_pawn_home(&Board::from_ascii_board_fen(b"8/8/8/8/8/8/8/8").unwrap());
        assert_eq!(pawn_home, 0b0000000000000000);
    }

    #[test]
    fn importer_handles_nested_variations() {
        let pgn = r#"[Event "T"]
[Site "S"]
[Date "2026.02.27"]
[UTCTime "12:00:00"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4 (1. d4 d5 (1... Nf6) {inner}) e5 *
"#;

        let mut importer = Importer::new(None);
        let games: Vec<TempGame> = BufferedReader::new(pgn.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .collect();

        assert_eq!(games.len(), 1);
        let movetext = decode_game_to_movetext(&games[0].moves, Fen::default()).unwrap();

        assert_eq!(movetext, "1. e4 (1. d4 d5 (1... Nf6) {inner}) 1... e5");
    }

    #[test]
    fn importer_handles_symbolic_and_numeric_nags() {
        let pgn = r#"[Event "T"]
[Site "S"]
[Date "2026.02.27"]
[UTCTime "12:00:00"]
[White "W"]
[Black "B"]
[Result "*"]

1. e4! (1. d4 $2) e5 $1 *
"#;

        let mut importer = Importer::new(None);
        let games: Vec<TempGame> = BufferedReader::new(pgn.as_bytes())
            .into_iter(&mut importer)
            .flatten()
            .flatten()
            .collect();

        assert_eq!(games.len(), 1);
        let movetext = decode_game_to_movetext(&games[0].moves, Fen::default()).unwrap();
        assert_eq!(movetext, "1. e4! (1. d4?) 1... e5!");
    }

    fn setup_test_db() -> SqliteConnection {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute("PRAGMA foreign_keys = ON;").unwrap();
        conn.batch_execute(CREATE_TABLES_SQL).unwrap();
        conn
    }

    #[test]
    fn set_info_value_stores_title_containing_quotes() {
        let db = &mut setup_test_db();
        set_info_value(db, "Title", r#"A "quoted" title"#).unwrap();
        let stored: Option<String> = info::table
            .filter(info::name.eq("Title"))
            .select(info::value)
            .first(db)
            .unwrap();
        assert_eq!(stored.as_deref(), Some(r#"A "quoted" title"#));
    }

    #[test]
    fn delete_orphaned_data_removes_unreferenced_players_events_sites() {
        let db = &mut setup_test_db();

        // Create players, events, sites
        let player1 = create_player(db, "Magnus").unwrap();
        let player2 = create_player(db, "Hikaru").unwrap();
        let event = create_event(db, "World Championship").unwrap();
        let site = create_site(db, "Reykjavik").unwrap();

        // Insert a game referencing them
        let game = create_game(
            db,
            NewGame {
                event_id: event.id,
                site_id: site.id,
                white_id: player1.id,
                black_id: player2.id,
                white_elo: None,
                black_elo: None,
                white_material: 0,
                black_material: 0,
                date: None,
                time: None,
                round: None,
                result: None,
                time_control: None,
                eco: None,
                ply_count: 10,
                fen: None,
                moves: &[],
                pawn_home: 0,
            },
        )
        .unwrap();

        // Verify everything exists: 3 players (Unknown + 2), 2 events, 2 sites
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 3);
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 2);
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 2);

        // Delete the game
        diesel::delete(games::table.filter(games::id.eq(game.id)))
            .execute(db)
            .unwrap();

        // Before fix: orphans would remain. Call our cleanup function.
        delete_orphaned_data(db).unwrap();

        // Players: only the sentinel "Unknown" (ID=0) should remain
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 1, "Orphaned players should be deleted");

        let remaining_player: Player = players::table.first(db).unwrap();
        assert_eq!(
            remaining_player.id, 0,
            "Only the Unknown player should remain"
        );

        // Events: only the sentinel should remain
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 1, "Orphaned events should be deleted");

        // Sites: only the sentinel should remain
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 1, "Orphaned sites should be deleted");

        // Info table counts should be updated
        let pc: String = info::table
            .filter(info::name.eq("PlayerCount"))
            .select(info::value)
            .first::<Option<String>>(db)
            .unwrap()
            .unwrap();
        assert_eq!(pc, "1");

        let ec: String = info::table
            .filter(info::name.eq("EventCount"))
            .select(info::value)
            .first::<Option<String>>(db)
            .unwrap()
            .unwrap();
        assert_eq!(ec, "1");

        let sc: String = info::table
            .filter(info::name.eq("SiteCount"))
            .select(info::value)
            .first::<Option<String>>(db)
            .unwrap()
            .unwrap();
        assert_eq!(sc, "1");
    }

    #[test]
    fn delete_orphaned_data_preserves_referenced_records() {
        let db = &mut setup_test_db();

        // Create players, events, sites for two games
        let magnus = create_player(db, "Magnus").unwrap();
        let hikaru = create_player(db, "Hikaru").unwrap();
        let fabiano = create_player(db, "Fabiano").unwrap();
        let event1 = create_event(db, "World Championship").unwrap();
        let event2 = create_event(db, "Candidates").unwrap();
        let site1 = create_site(db, "Reykjavik").unwrap();
        let site2 = create_site(db, "Toronto").unwrap();

        let make_game = |db: &mut SqliteConnection, w: i32, b: i32, e: i32, s: i32| {
            create_game(
                db,
                NewGame {
                    event_id: e,
                    site_id: s,
                    white_id: w,
                    black_id: b,
                    white_elo: None,
                    black_elo: None,
                    white_material: 0,
                    black_material: 0,
                    date: None,
                    time: None,
                    round: None,
                    result: None,
                    time_control: None,
                    eco: None,
                    ply_count: 10,
                    fen: None,
                    moves: &[],
                    pawn_home: 0,
                },
            )
            .unwrap()
        };

        // Game 1: Magnus vs Hikaru at World Championship in Reykjavik
        let game1 = make_game(db, magnus.id, hikaru.id, event1.id, site1.id);
        // Game 2: Fabiano vs Hikaru at Candidates in Toronto
        let game2 = make_game(db, fabiano.id, hikaru.id, event2.id, site2.id);

        // Delete only game 1
        diesel::delete(games::table.filter(games::id.eq(game1.id)))
            .execute(db)
            .unwrap();
        delete_orphaned_data(db).unwrap();

        // Magnus should be gone (only in game 1), but Hikaru and Fabiano should remain
        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 3, "Unknown + Hikaru + Fabiano should remain");

        let magnus_exists: i64 = players::table
            .filter(players::name.eq("Magnus"))
            .count()
            .get_result(db)
            .unwrap();
        assert_eq!(magnus_exists, 0, "Magnus should be deleted (orphaned)");

        // Event1 and Site1 should be gone, Event2 and Site2 should remain
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 2, "Unknown + Candidates should remain");

        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 2, "Unknown + Toronto should remain");

        // Delete game 2 — now everything should be orphaned
        diesel::delete(games::table.filter(games::id.eq(game2.id)))
            .execute(db)
            .unwrap();
        delete_orphaned_data(db).unwrap();

        let player_count: i64 = players::table.count().get_result(db).unwrap();
        assert_eq!(player_count, 1, "Only Unknown should remain");
        let event_count: i64 = events::table.count().get_result(db).unwrap();
        assert_eq!(event_count, 1, "Only Unknown should remain");
        let site_count: i64 = sites::table.count().get_result(db).unwrap();
        assert_eq!(site_count, 1, "Only Unknown should remain");
    }

    // ---- durability: pool pragmas, user_version migrations, bulk import ----

    #[derive(QueryableByName)]
    struct PragmaInt {
        #[diesel(sql_type = Integer)]
        value: i32,
    }

    /// Reads a single-column pragma through its table-valued form, so the
    /// pragma's own column name (`timeout` for `busy_timeout`) does not matter.
    fn pragma_int(conn: &mut SqliteConnection, name: &str) -> i32 {
        sql_query(format!("SELECT (SELECT * FROM pragma_{name}) AS value;"))
            .get_result::<PragmaInt>(conn)
            .unwrap()
            .value
    }

    fn journal_mode(conn: &mut SqliteConnection) -> String {
        sql_query("PRAGMA journal_mode;")
            .get_result::<JournalModeRow>(conn)
            .unwrap()
            .journal_mode
    }

    fn info_value(conn: &mut SqliteConnection, name: &str) -> Option<String> {
        info::table
            .filter(info::name.eq(name))
            .select(info::value)
            .first::<Option<String>>(conn)
            .unwrap()
    }

    fn temp_db_path(dir: &tempfile::TempDir, name: &str) -> String {
        dir.path().join(name).to_str().unwrap().to_owned()
    }

    #[test]
    fn new_pooled_database_is_wal_and_at_current_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_db_path(&dir, "new.db3");
        let pools = DashMap::new();

        let mut conn = open_pooled(&pools, &path, ConnectionOptions::default()).unwrap();

        assert_eq!(journal_mode(&mut conn), "wal");
        assert_eq!(pragma_int(&mut conn, "synchronous"), 1, "NORMAL");
        assert_eq!(pragma_int(&mut conn, "foreign_keys"), 1);
        assert_eq!(pragma_int(&mut conn, "busy_timeout"), 30_000);
        assert_eq!(
            migrate::read_user_version(&mut conn).unwrap(),
            migrate::CURRENT_VERSION as i32
        );

        // The schema was created, sentinel rows included.
        let unknown: Player = players::table.find(0).first(&mut conn).unwrap();
        assert_eq!(unknown.name.as_deref(), Some("Unknown"));

        // The pool is cached and reused for the same path.
        assert_eq!(pools.len(), 1);
        drop(conn);
        let mut again = open_pooled(&pools, &path, ConnectionOptions::default()).unwrap();
        assert_eq!(journal_mode(&mut again), "wal");
        assert_eq!(pools.len(), 1);
    }

    #[test]
    fn existing_en_croissant_database_is_stamped_and_keeps_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_db_path(&dir, "legacy.db3");

        // An En Croissant file: rollback journal, no user_version stamp.
        let magnus_id = {
            let mut conn = SqliteConnection::establish(&path).unwrap();
            conn.batch_execute(CREATE_TABLES_SQL).unwrap();
            set_info_value(&mut conn, "Version", DATABASE_VERSION).unwrap();
            set_info_value(&mut conn, "Title", "Legacy").unwrap();
            let magnus = create_player(&mut conn, "Magnus").unwrap();
            assert_eq!(journal_mode(&mut conn), "delete");
            assert_eq!(migrate::read_user_version(&mut conn).unwrap(), 0);
            magnus.id
        };

        let pools = DashMap::new();
        let mut conn = open_pooled(&pools, &path, ConnectionOptions::default()).unwrap();

        assert_eq!(migrate::read_user_version(&mut conn).unwrap(), 1);
        assert_eq!(journal_mode(&mut conn), "wal");
        let magnus: Player = players::table.find(magnus_id).first(&mut conn).unwrap();
        assert_eq!(magnus.name.as_deref(), Some("Magnus"));
        assert_eq!(
            info_value(&mut conn, "Version").as_deref(),
            Some(DATABASE_VERSION)
        );
        assert_eq!(info_value(&mut conn, "Title").as_deref(), Some("Legacy"));
    }

    #[test]
    fn database_from_a_newer_chessin_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_db_path(&dir, "future.db3");
        {
            let mut conn = SqliteConnection::establish(&path).unwrap();
            conn.batch_execute(CREATE_TABLES_SQL).unwrap();
            conn.batch_execute(&format!(
                "PRAGMA user_version = {};",
                migrate::CURRENT_VERSION + 1
            ))
            .unwrap();
        }

        let pools = DashMap::new();
        let err = open_pooled(&pools, &path, ConnectionOptions::default())
            .map(|_| ())
            .unwrap_err();
        assert!(
            err.to_string().contains("newer Chessin"),
            "unexpected error: {err}"
        );
        // A refused database must not leave a usable pool behind.
        assert!(pools.is_empty());

        // The stamp is untouched, so a newer build can still open it.
        let mut conn = SqliteConnection::establish(&path).unwrap();
        assert_eq!(
            migrate::read_user_version(&mut conn).unwrap(),
            migrate::CURRENT_VERSION as i32 + 1
        );
    }

    #[test]
    fn bulk_import_on_dedicated_connection_is_visible_to_pooled_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = temp_db_path(&dir, "imported.db3");
        let pgn_path = dir.path().join("games.pgn");
        std::fs::write(
            &pgn_path,
            r#"[Event "Test Open"]
[Site "Lisbon"]
[Date "2026.02.27"]
[UTCTime "12:00:00"]
[White "Magnus"]
[Black "Hikaru"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0

[Event "Test Open"]
[Site "Lisbon"]
[Date "2026.02.28"]
[UTCTime "13:00:00"]
[White "Hikaru"]
[Black "Fabiano"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 1/2-1/2
"#,
        )
        .unwrap();

        // convert_pgn's sequence, minus the Tauri plumbing.
        let mut db = open_bulk_import_connection(&path).unwrap();
        assert_eq!(journal_mode(&mut db), "wal");
        assert_eq!(pragma_int(&mut db, "synchronous"), 1, "NORMAL until import");
        assert_eq!(
            migrate::migrate(&mut db).unwrap(),
            migrate::MigrationOutcome::Created
        );
        set_info_value(&mut db, "Version", DATABASE_VERSION).unwrap();
        set_info_value(&mut db, "Title", "Imported").unwrap();

        let mut progress_calls = 0usize;
        bulk_import(&mut db, &[pgn_path], None, true, |count, file| {
            progress_calls += 1;
            assert_eq!(count, 0);
            assert_eq!(file, Some("games.pgn"));
        })
        .unwrap();
        assert_eq!(progress_calls, 1);
        assert_eq!(pragma_int(&mut db, "synchronous"), 0, "OFF during import");

        finish_bulk_import(&mut db).unwrap();
        assert_eq!(pragma_int(&mut db, "synchronous"), 1, "NORMAL after import");
        // The checkpoint folded the WAL into the main file and truncated it.
        let wal_len = std::fs::metadata(format!("{path}-wal"))
            .map(|m| m.len())
            .unwrap_or(0);
        assert_eq!(wal_len, 0);

        // A pooled connection (what every other command uses) sees the rows.
        let pools = DashMap::new();
        let mut conn = open_pooled(&pools, &path, ConnectionOptions::default()).unwrap();
        assert_eq!(journal_mode(&mut conn), "wal");
        assert_eq!(migrate::read_user_version(&mut conn).unwrap(), 1);
        let game_count: i64 = games::table.count().get_result(&mut conn).unwrap();
        assert_eq!(game_count, 2);
        let player_count: i64 = players::table.count().get_result(&mut conn).unwrap();
        assert_eq!(player_count, 4, "Unknown + Magnus + Hikaru + Fabiano");
        assert_eq!(info_value(&mut conn, "GameCount").as_deref(), Some("2"));
        assert_eq!(info_value(&mut conn, "PlayerCount").as_deref(), Some("4"));
        assert_eq!(info_value(&mut conn, "EventCount").as_deref(), Some("2"));
        assert_eq!(info_value(&mut conn, "SiteCount").as_deref(), Some("2"));
        assert_eq!(info_value(&mut conn, "Title").as_deref(), Some("Imported"));
        assert!(check_index_exists(&mut conn).unwrap());

        // Importing again into the existing database appends without
        // recreating anything.
        drop(conn);
        let mut db = open_bulk_import_connection(&path).unwrap();
        assert_eq!(
            migrate::migrate(&mut db).unwrap(),
            migrate::MigrationOutcome::UpToDate
        );
        let pgn_path = dir.path().join("games.pgn");
        bulk_import(&mut db, &[pgn_path], None, false, |_, _| {}).unwrap();
        finish_bulk_import(&mut db).unwrap();
        let mut conn = open_pooled(&pools, &path, ConnectionOptions::default()).unwrap();
        let game_count: i64 = games::table.count().get_result(&mut conn).unwrap();
        assert_eq!(game_count, 4);
        assert_eq!(info_value(&mut conn, "GameCount").as_deref(), Some("4"));
    }
}
