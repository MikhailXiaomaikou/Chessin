//! Chessin's own data store, `<app_data_dir>/chessin/library.sqlite`.
//!
//! The file is opened in WAL mode with `synchronous=NORMAL` and migrated with
//! `PRAGMA user_version` (see [`MIGRATIONS`]). Schema v1 holds:
//!
//! - `kv`: settings and workspace state (`workspace.tabs`, …) as strings;
//! - `documents`: Chessin-owned documents (`kind = "game"`, …) whose `data` is
//!   JSON written by the frontend;
//! - `document_versions`: the history of each document, at most
//!   [`VERSION_CAP`] rows per document. A put without a checkpoint label merges
//!   into the latest unlabelled version when that one is younger than
//!   [`VERSION_MERGE_MS`]; a labelled version (a checkpoint) is never overwritten;
//! - `trash`: one row per path moved to the OS recycle bin.
//!
//! Schema v2 adds (each in its own submodule):
//!
//! - `jobs` ([`jobs`]): the persisted side of the frontend's background job
//!   runner; a job left `running` by a crash is put back to `queued` on open;
//! - `eval_cache` ([`eval_cache`]): one engine evaluation per (position,
//!   engine), only ever replaced by a deeper or equally deep one;
//! - `cards` and `card_logs` ([`cards`]): the training cards of the mistake
//!   notebook with their review log. The FSRS scheduling stays in TypeScript;
//!   the store only orders by `due` and counts.
//!
//! Game databases stay in En Croissant's `.db3` format so that En Croissant can
//! still open a Chessin library; anything Chessin adds there goes into `chessin_*`
//! tables with their own migrations, plus the side-car `.cpi` position index.
//!
//! [`Library::backup_to`] snapshots the whole file with `VACUUM INTO` as
//! `library-<UTC stamp>.sqlite` in a backups directory and rotates the old ones.
//!
//! Timestamps are Unix milliseconds. Every method takes `&self`/`&mut self` on a
//! single connection; the plugin serialises access with a mutex.

mod cards;
mod eval_cache;
mod jobs;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

pub use cards::{CardLog, CardRecord, CardStats, DAY_MS};
pub use eval_cache::CachedEval;
pub use jobs::{JobRecord, FINISHED_JOB_STATUSES};

/// Versions kept per document; older ones are dropped when a new one is written.
pub const VERSION_CAP: usize = 50;
/// A put without checkpoint merges into the latest unlabelled version when that
/// version is younger than this (5 minutes).
pub const VERSION_MERGE_MS: i64 = 5 * 60 * 1000;
/// How long a statement waits for a lock held by another connection.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Schema version this build writes to `PRAGMA user_version`.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// One entry per schema version; entry `n` upgrades `user_version` `n` → `n + 1`.
const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        origin TEXT,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX documents_kind_updated_at ON documents (kind, updated_at);
    CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        label TEXT
    );
    CREATE INDEX document_versions_doc_id ON document_versions (doc_id, created_at);
    CREATE TABLE trash (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        meta TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
    );",
    // v2: background jobs, the engine evaluation cache and the training cards.
    "CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        progress REAL NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX jobs_status_created_at ON jobs (status, created_at);
    CREATE TABLE eval_cache (
        epd TEXT NOT NULL,
        engine TEXT NOT NULL,
        depth INTEGER NOT NULL,
        score_type TEXT NOT NULL,
        score_value INTEGER NOT NULL,
        best_uci TEXT NOT NULL,
        pv TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (epd, engine)
    );
    CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        epd TEXT NOT NULL,
        kind TEXT NOT NULL,
        answer TEXT NOT NULL,
        source TEXT,
        due INTEGER NOT NULL,
        fsrs TEXT NOT NULL,
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX cards_due ON cards (due);
    CREATE TABLE card_logs (
        id INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
        reviewed_at INTEGER NOT NULL,
        rating INTEGER NOT NULL,
        log TEXT NOT NULL
    );
    CREATE INDEX card_logs_card_id ON card_logs (card_id, reviewed_at);
    CREATE INDEX card_logs_reviewed_at ON card_logs (reviewed_at);",
];

/// Errors of the store.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cannot create {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot write backup {path}: {source}")]
    Backup {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("library schema version {found} is newer than this build supports ({SCHEMA_VERSION})")]
    SchemaTooNew { found: u32 },
    #[error("no document {id}")]
    NoSuchDocument { id: String },
    #[error("document {doc_id} has no version {version_id}")]
    NoSuchVersion { doc_id: String, version_id: i64 },
    #[error("no card {id}")]
    NoSuchCard { id: String },
}

/// A document with its JSON payload.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct Document {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub origin: Option<String>,
    pub data: String,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// [`Document`] without its payload, as listed by [`Library::doc_list`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct DocumentMeta {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub origin: Option<String>,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// One row of `document_versions` without its payload.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct VersionMeta {
    pub id: i64,
    pub doc_id: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// The checkpoint label; `None` for an automatic version.
    pub label: Option<String>,
}

/// One row of `trash`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct TrashEntry {
    pub id: i64,
    /// `file` or `directory`.
    pub kind: String,
    pub path: String,
    /// JSON with what was known about the path (`size_bytes`, `modified`).
    pub meta: String,
    /// Unix milliseconds.
    pub deleted_at: i64,
}

/// What [`Library::doc_put`] stores.
#[derive(Debug, Clone, Copy)]
pub struct NewDocument<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub origin: Option<&'a str>,
    /// JSON payload, opaque to the store.
    pub data: &'a str,
}

/// Unix milliseconds now; `0` if the clock is before 1970.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// An open `library.sqlite`.
#[derive(Debug)]
pub struct Library {
    conn: Connection,
}

impl Library {
    /// Opens (creating the file and its parent directories) and migrates the
    /// library at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Library, Error> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| Error::CreateDir {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        Library::init(Connection::open(path)?)
    }

    /// An in-memory library, for tests.
    pub fn open_in_memory() -> Result<Library, Error> {
        Library::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Library, Error> {
        conn.busy_timeout(BUSY_TIMEOUT)?;
        // `journal_mode` answers with a row, so it cannot go through `pragma_update`.
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        // Crash recovery: nothing can still be running when the file is opened.
        jobs::requeue_running(&conn, now_ms())?;
        Ok(Library { conn })
    }

    /// The schema version of the open file.
    pub fn schema_version(&self) -> Result<u32, Error> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    // ----- kv -------------------------------------------------------------

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, Error> {
        Ok(self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), Error> {
        self.conn.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_ms()],
        )?;
        Ok(())
    }

    pub fn kv_delete(&self, key: &str) -> Result<(), Error> {
        self.conn.execute("DELETE FROM kv WHERE key = ?1", [key])?;
        Ok(())
    }

    // ----- documents ------------------------------------------------------

    /// Inserts or replaces the document and records a version: a new row when
    /// `checkpoint` is given or when the latest version is a checkpoint or older
    /// than [`VERSION_MERGE_MS`]; otherwise the latest version takes the new data.
    pub fn doc_put(&mut self, doc: NewDocument<'_>, checkpoint: Option<&str>) -> Result<(), Error> {
        self.doc_put_at(doc, checkpoint, now_ms())
    }

    /// [`Library::doc_put`] with an explicit clock (tests).
    pub fn doc_put_at(
        &mut self,
        doc: NewDocument<'_>,
        checkpoint: Option<&str>,
        now_ms: i64,
    ) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO documents (id, kind, title, origin, data, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
                 origin = excluded.origin, data = excluded.data, updated_at = excluded.updated_at",
            params![doc.id, doc.kind, doc.title, doc.origin, doc.data, now_ms],
        )?;

        let latest: Option<(i64, i64, Option<String>)> = tx
            .query_row(
                "SELECT id, created_at, label FROM document_versions
                 WHERE doc_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
                [doc.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let merge_into = match (checkpoint, latest) {
            (None, Some((id, created_at, None))) if now_ms - created_at < VERSION_MERGE_MS => {
                Some(id)
            }
            _ => None,
        };
        match merge_into {
            Some(version_id) => {
                tx.execute(
                    "UPDATE document_versions SET data = ?1 WHERE id = ?2",
                    params![doc.data, version_id],
                )?;
            }
            None => insert_version(&tx, doc.id, doc.data, now_ms, checkpoint)?,
        }
        tx.commit()?;
        Ok(())
    }

    pub fn doc_get(&self, id: &str) -> Result<Option<Document>, Error> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, kind, title, origin, data, updated_at FROM documents WHERE id = ?1",
                [id],
                |r| {
                    Ok(Document {
                        id: r.get(0)?,
                        kind: r.get(1)?,
                        title: r.get(2)?,
                        origin: r.get(3)?,
                        data: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Documents of `kind` (all kinds when `None`), most recently updated first.
    pub fn doc_list(&self, kind: Option<&str>) -> Result<Vec<DocumentMeta>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, title, origin, updated_at FROM documents
             WHERE ?1 IS NULL OR kind = ?1 ORDER BY updated_at DESC, id",
        )?;
        let rows = stmt.query_map([kind], |r| {
            Ok(DocumentMeta {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                origin: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Deletes the document and its versions; a missing document is not an error.
    pub fn doc_delete(&mut self, id: &str) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM document_versions WHERE doc_id = ?1", [id])?;
        tx.execute("DELETE FROM documents WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Versions of a document, newest first.
    pub fn doc_versions(&self, id: &str) -> Result<Vec<VersionMeta>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, doc_id, created_at, label FROM document_versions
             WHERE doc_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok(VersionMeta {
                id: r.get(0)?,
                doc_id: r.get(1)?,
                created_at: r.get(2)?,
                label: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The stored payload of one version of a document; `None` when the
    /// document has no version with that id.
    pub fn doc_version_get(&self, id: &str, version_id: i64) -> Result<Option<String>, Error> {
        Ok(self
            .conn
            .query_row(
                "SELECT data FROM document_versions WHERE id = ?1 AND doc_id = ?2",
                params![version_id, id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Makes the version's payload the document's current one. The restored
    /// payload is also appended as a new (unlabelled) version so that the state
    /// before the restore stays in the history.
    pub fn doc_restore_version(&mut self, id: &str, version_id: i64) -> Result<(), Error> {
        self.doc_restore_version_at(id, version_id, now_ms())
    }

    /// [`Library::doc_restore_version`] with an explicit clock (tests).
    pub fn doc_restore_version_at(
        &mut self,
        id: &str,
        version_id: i64,
        now_ms: i64,
    ) -> Result<(), Error> {
        let tx = self.conn.transaction()?;
        let data: Option<String> = tx
            .query_row(
                "SELECT data FROM document_versions WHERE id = ?1 AND doc_id = ?2",
                params![version_id, id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(data) = data else {
            return Err(Error::NoSuchVersion {
                doc_id: id.to_string(),
                version_id,
            });
        };
        let changed = tx.execute(
            "UPDATE documents SET data = ?1, updated_at = ?2 WHERE id = ?3",
            params![data, now_ms, id],
        )?;
        if changed == 0 {
            return Err(Error::NoSuchDocument { id: id.to_string() });
        }
        insert_version(&tx, id, &data, now_ms, None)?;
        tx.commit()?;
        Ok(())
    }

    // ----- trash ----------------------------------------------------------

    /// Moves each path with `mover` (the OS recycle bin in the app; a rename in
    /// tests), records a `trash` row for each success and returns the paths that
    /// failed. A database error after a successful move is returned as is.
    pub fn move_to_trash<F>(&self, paths: &[String], mut mover: F) -> Result<Vec<String>, Error>
    where
        F: FnMut(&Path) -> Result<(), String>,
    {
        let mut failed = Vec::new();
        for path in paths {
            let p = Path::new(path);
            let metadata = fs::symlink_metadata(p).ok();
            let kind = match &metadata {
                Some(m) if m.is_dir() => "directory",
                _ => "file",
            };
            match mover(p) {
                Ok(()) => {
                    self.record_trash(kind, path, &trash_meta(metadata.as_ref()))?;
                }
                Err(_) => failed.push(path.clone()),
            }
        }
        Ok(failed)
    }

    /// Records a path moved to the recycle bin; returns the row id.
    pub fn record_trash(&self, kind: &str, path: &str, meta: &str) -> Result<i64, Error> {
        self.conn.execute(
            "INSERT INTO trash (kind, path, meta, deleted_at) VALUES (?1, ?2, ?3, ?4)",
            params![kind, path, meta, now_ms()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Everything moved to the recycle bin, newest first.
    pub fn trash_entries(&self) -> Result<Vec<TrashEntry>, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, path, meta, deleted_at FROM trash ORDER BY deleted_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TrashEntry {
                id: r.get(0)?,
                kind: r.get(1)?,
                path: r.get(2)?,
                meta: r.get(3)?,
                deleted_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ----- backups --------------------------------------------------------

    /// Writes a compact, consistent snapshot of the library (`VACUUM INTO`,
    /// committed WAL content included) to
    /// `<dir>/library-<YYYYMMDD-HHMMSS>.sqlite`, the stamp being `now_ms` in
    /// UTC, creating `dir` when needed. The snapshot is written to a `.tmp`
    /// file first and renamed, so a failure never leaves a partial backup
    /// behind (a backup made the same second is replaced). Then the oldest
    /// `library-*.sqlite` files beyond `keep` (the new one counted) are
    /// deleted. Returns the path of the new file.
    pub fn backup_to(&self, dir: &Path, now_ms: i64, keep: usize) -> Result<PathBuf, Error> {
        fs::create_dir_all(dir).map_err(|source| Error::CreateDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let name = format!("{BACKUP_PREFIX}{}{BACKUP_SUFFIX}", backup_stamp(now_ms));
        let path = dir.join(&name);
        let tmp = dir.join(format!("{name}.tmp"));
        let io_err = |path: &Path, source: std::io::Error| Error::Backup {
            path: path.to_path_buf(),
            source,
        };
        let Some(tmp_str) = tmp.to_str() else {
            return Err(io_err(
                &tmp,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "the path is not valid UTF-8",
                ),
            ));
        };
        // `VACUUM INTO` refuses to overwrite, so a leftover of a crashed run
        // goes first; a missing file is fine.
        let _ = fs::remove_file(&tmp);
        if let Err(e) = self.conn.execute("VACUUM INTO ?1", [tmp_str]) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        if let Err(source) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            return Err(io_err(&path, source));
        }
        rotate_backups(dir, &name, keep)?;
        Ok(path)
    }
}

/// File name of a backup: `library-<YYYYMMDD-HHMMSS>.sqlite`.
const BACKUP_PREFIX: &str = "library-";
const BACKUP_SUFFIX: &str = ".sqlite";

/// Deletes the `library-*.sqlite` files in `dir` beyond the `keep` newest by
/// name (the stamps sort chronologically); `just_written` is never deleted,
/// even when a clock set back makes it sort as old.
fn rotate_backups(dir: &Path, just_written: &str, keep: usize) -> Result<(), Error> {
    let entries = fs::read_dir(dir).map_err(|source| Error::Backup {
        path: dir.to_path_buf(),
        source,
    })?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(BACKUP_PREFIX) && name.ends_with(BACKUP_SUFFIX))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    for name in names.iter().skip(keep).filter(|n| *n != just_written) {
        let path = dir.join(name);
        fs::remove_file(&path).map_err(|source| Error::Backup { path, source })?;
    }
    Ok(())
}

/// `now_ms` (Unix milliseconds) as `YYYYMMDD-HHMMSS` in UTC.
fn backup_stamp(now_ms: i64) -> String {
    let secs = now_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Proleptic Gregorian (year, month, day) of a day count since 1970-01-01
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // day of era, 0..=146096
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // 0..=399
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // 0..=365, March-based
    let mp = (5 * doy + 2) / 153; // 0..=11, March = 0
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn migrate(conn: &mut Connection) -> Result<(), Error> {
    let found: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew { found });
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(found as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as u32 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// Appends a version and drops the oldest ones beyond [`VERSION_CAP`].
fn insert_version(
    conn: &Connection,
    doc_id: &str,
    data: &str,
    created_at: i64,
    label: Option<&str>,
) -> Result<(), Error> {
    conn.execute(
        "INSERT INTO document_versions (doc_id, data, created_at, label) VALUES (?1, ?2, ?3, ?4)",
        params![doc_id, data, created_at, label],
    )?;
    conn.execute(
        "DELETE FROM document_versions WHERE doc_id = ?1 AND id NOT IN (
             SELECT id FROM document_versions WHERE doc_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT ?2)",
        params![doc_id, VERSION_CAP as i64],
    )?;
    Ok(())
}

/// The `meta` JSON of a trash row: `size_bytes` (files only) and `modified`
/// (Unix seconds), when known.
fn trash_meta(metadata: Option<&fs::Metadata>) -> String {
    let mut meta = serde_json::Map::new();
    if let Some(m) = metadata {
        if m.is_file() {
            meta.insert("size_bytes".into(), m.len().into());
        }
        if let Some(secs) = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
        {
            meta.insert("modified".into(), secs.into());
        }
    }
    serde_json::Value::Object(meta).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60 * 1000;

    fn game<'a>(id: &'a str, data: &'a str) -> NewDocument<'a> {
        NewDocument {
            id,
            kind: "game",
            title: "Test game",
            origin: None,
            data,
        }
    }

    #[test]
    fn open_creates_the_directories_and_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chessin").join("library.sqlite");
        let lib = Library::open(&path).unwrap();
        assert!(path.is_file());
        assert_eq!(lib.schema_version().unwrap(), SCHEMA_VERSION);
        let mode: String = lib
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        lib.kv_set("a", "1").unwrap();
        drop(lib);

        // Reopening keeps the data and does not re-run the migration.
        let lib = Library::open(&path).unwrap();
        assert_eq!(lib.kv_get("a").unwrap().as_deref(), Some("1"));
        assert_eq!(lib.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn a_v1_library_is_upgraded_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        {
            // A file as S1b-1 wrote it: only the v1 tables, user_version 1.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('a', '1', 0)",
                [],
            )
            .unwrap();
        }
        let lib = Library::open(&path).unwrap();
        assert_eq!(lib.schema_version().unwrap(), 2);
        assert_eq!(lib.kv_get("a").unwrap().as_deref(), Some("1"));
        assert!(lib.job_list(None).unwrap().is_empty());
        assert_eq!(lib.card_stats(0).unwrap(), CardStats::default());
        assert!(lib
            .eval_cache_get(&["x".to_string()], "e", 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        drop(Library::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        let err = Library::open(&path).unwrap_err();
        assert!(matches!(err, Error::SchemaTooNew { found } if found == SCHEMA_VERSION + 1));
    }

    #[test]
    fn kv_round_trip() {
        let lib = Library::open_in_memory().unwrap();
        assert_eq!(lib.kv_get("workspace.tabs").unwrap(), None);
        lib.kv_set("workspace.tabs", "[]").unwrap();
        assert_eq!(lib.kv_get("workspace.tabs").unwrap().as_deref(), Some("[]"));
        lib.kv_set("workspace.tabs", "[1]").unwrap();
        assert_eq!(
            lib.kv_get("workspace.tabs").unwrap().as_deref(),
            Some("[1]")
        );
        lib.kv_delete("workspace.tabs").unwrap();
        assert_eq!(lib.kv_get("workspace.tabs").unwrap(), None);
        // Deleting a missing key is fine.
        lib.kv_delete("workspace.tabs").unwrap();
    }

    #[test]
    fn documents_round_trip_list_and_delete() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.doc_put_at(game("t1", "{\"a\":1}"), None, 1_000)
            .unwrap();
        lib.doc_put_at(
            NewDocument {
                id: "t2",
                kind: "study",
                title: "Opening",
                origin: Some("file:/x.pgn"),
                data: "{}",
            },
            None,
            2_000,
        )
        .unwrap();

        let doc = lib.doc_get("t1").unwrap().unwrap();
        assert_eq!(
            doc,
            Document {
                id: "t1".into(),
                kind: "game".into(),
                title: "Test game".into(),
                origin: None,
                data: "{\"a\":1}".into(),
                updated_at: 1_000,
            }
        );
        assert_eq!(lib.doc_get("missing").unwrap(), None);

        let all = lib.doc_list(None).unwrap();
        assert_eq!(
            all.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["t2", "t1"]
        );
        assert_eq!(all[0].origin.as_deref(), Some("file:/x.pgn"));
        let games = lib.doc_list(Some("game")).unwrap();
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].id, "t1");

        // A put with the same id replaces title/data and bumps updated_at.
        lib.doc_put_at(
            NewDocument {
                title: "Renamed",
                ..game("t1", "{\"a\":2}")
            },
            None,
            3_000,
        )
        .unwrap();
        let doc = lib.doc_get("t1").unwrap().unwrap();
        assert_eq!(
            (doc.title.as_str(), doc.data.as_str(), doc.updated_at),
            ("Renamed", "{\"a\":2}", 3_000)
        );
        assert_eq!(lib.doc_list(None).unwrap()[0].id, "t1");

        lib.doc_delete("t1").unwrap();
        assert_eq!(lib.doc_get("t1").unwrap(), None);
        assert!(lib.doc_versions("t1").unwrap().is_empty());
        assert_eq!(lib.doc_list(None).unwrap().len(), 1);
        lib.doc_delete("t1").unwrap();
    }

    #[test]
    fn versions_merge_within_five_minutes_but_checkpoints_never() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.doc_put_at(game("t", "v1"), None, 0).unwrap();
        lib.doc_put_at(game("t", "v2"), None, MIN).unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 1, "a put within 5 min merges");
        assert_eq!(versions[0].created_at, 0);
        assert_eq!(version_data(&lib, versions[0].id), "v2");

        lib.doc_put_at(game("t", "v3"), None, 5 * MIN).unwrap();
        assert_eq!(
            lib.doc_versions("t").unwrap().len(),
            2,
            "5 min later: a new row"
        );

        lib.doc_put_at(game("t", "v4"), Some("before sacrifice"), 5 * MIN + 1)
            .unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 3, "a checkpoint always adds a row");
        assert_eq!(versions[0].label.as_deref(), Some("before sacrifice"));
        let checkpoint_id = versions[0].id;

        lib.doc_put_at(game("t", "v5"), None, 5 * MIN + 2).unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(
            versions.len(),
            4,
            "an autosave never merges into a checkpoint"
        );
        assert_eq!(version_data(&lib, checkpoint_id), "v4");
        assert_eq!(versions[0].label, None);
        assert_eq!(version_data(&lib, versions[0].id), "v5");
        assert_eq!(lib.doc_get("t").unwrap().unwrap().data, "v5");
    }

    #[test]
    fn versions_are_capped_at_fifty_per_document() {
        let mut lib = Library::open_in_memory().unwrap();
        for i in 0..60 {
            let data = format!("v{i}");
            lib.doc_put_at(game("t", &data), None, i * 10 * MIN)
                .unwrap();
        }
        // Another document's history is independent.
        lib.doc_put_at(game("other", "x"), Some("c"), 0).unwrap();

        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), VERSION_CAP);
        assert_eq!(versions[0].created_at, 59 * 10 * MIN, "newest first");
        assert_eq!(versions[VERSION_CAP - 1].created_at, 10 * 10 * MIN);
        assert_eq!(version_data(&lib, versions[VERSION_CAP - 1].id), "v10");
        assert_eq!(lib.doc_versions("other").unwrap().len(), 1);
    }

    #[test]
    fn restore_version_brings_the_payload_back_and_keeps_the_history() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.doc_put_at(game("t", "old"), Some("start"), 0).unwrap();
        lib.doc_put_at(game("t", "new"), None, 10 * MIN).unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 2);
        let start = versions[1].id;

        lib.doc_restore_version_at("t", start, 20 * MIN).unwrap();
        let doc = lib.doc_get("t").unwrap().unwrap();
        assert_eq!((doc.data.as_str(), doc.updated_at), ("old", 20 * MIN));
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 3, "the restore is its own version");
        assert_eq!(version_data(&lib, versions[0].id), "old");
        assert_eq!(
            version_data(&lib, versions[1].id),
            "new",
            "the state before the restore survives"
        );

        // An autosave right after merges into the restore row, not into "new".
        lib.doc_put_at(game("t", "edited"), None, 20 * MIN + 1)
            .unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 3);
        assert_eq!(version_data(&lib, versions[1].id), "new");

        let err = lib.doc_restore_version_at("t", 9_999, 0).unwrap_err();
        assert!(
            matches!(
                err,
                Error::NoSuchVersion {
                    version_id: 9_999,
                    ..
                }
            ),
            "{err}"
        );
        // A version of another document is not accepted either.
        lib.doc_put_at(game("u", "u"), None, 0).unwrap();
        let foreign = lib.doc_versions("u").unwrap()[0].id;
        assert!(lib.doc_restore_version_at("t", foreign, 0).is_err());
    }

    #[test]
    fn move_to_trash_records_a_row_per_moved_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let file = dir.path().join("games.db3");
        fs::write(&file, b"0123456789").unwrap();
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let missing = dir.path().join("missing.pgn");

        let lib = Library::open(dir.path().join("library.sqlite")).unwrap();
        let paths: Vec<String> = [&file, &folder, &missing]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let failed = lib
            .move_to_trash(&paths, |path| {
                let target = bin.join(path.file_name().unwrap());
                fs::rename(path, target).map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(failed, vec![paths[2].clone()]);
        assert!(!file.exists() && !folder.exists());
        assert!(bin.join("games.db3").is_file() && bin.join("folder").is_dir());

        let rows = lib.trash_entries().unwrap();
        assert_eq!(rows.len(), 2);
        // Newest first: the folder was moved after the file.
        assert_eq!(
            (rows[0].kind.as_str(), rows[0].path.as_str()),
            ("directory", paths[1].as_str())
        );
        assert_eq!(
            (rows[1].kind.as_str(), rows[1].path.as_str()),
            ("file", paths[0].as_str())
        );
        let meta: serde_json::Value = serde_json::from_str(&rows[1].meta).unwrap();
        assert_eq!(meta["size_bytes"], 10);
        assert!(meta["modified"].is_number());
        assert!(rows[0].deleted_at > 0);
    }

    #[test]
    fn doc_version_get_returns_the_payload_of_that_document_only() {
        let mut lib = Library::open_in_memory().unwrap();
        lib.doc_put_at(game("t", "old"), Some("start"), 0).unwrap();
        lib.doc_put_at(game("t", "new"), None, 10 * MIN).unwrap();
        lib.doc_put_at(game("u", "other"), None, 0).unwrap();
        let versions = lib.doc_versions("t").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            lib.doc_version_get("t", versions[0].id).unwrap().as_deref(),
            Some("new")
        );
        assert_eq!(
            lib.doc_version_get("t", versions[1].id).unwrap().as_deref(),
            Some("old")
        );
        assert_eq!(lib.doc_version_get("t", 9_999).unwrap(), None);
        // A version of another document is not visible through this one.
        let foreign = lib.doc_versions("u").unwrap()[0].id;
        assert_eq!(lib.doc_version_get("t", foreign).unwrap(), None);
        assert_eq!(lib.doc_version_get("missing", foreign).unwrap(), None);
    }

    #[test]
    fn backup_stamp_is_the_utc_calendar_time() {
        // Reference values from `date -u -d @<secs> +%Y%m%d-%H%M%S`.
        assert_eq!(backup_stamp(0), "19700101-000000");
        assert_eq!(backup_stamp(951_782_400_000), "20000229-000000");
        assert_eq!(backup_stamp(1_709_251_199_999), "20240229-235959");
        assert_eq!(backup_stamp(1_735_689_599_000), "20241231-235959");
        assert_eq!(backup_stamp(1_761_134_400_000), "20251022-120000");
        assert_eq!(backup_stamp(2_147_483_647_000), "20380119-031407");
        assert_eq!(backup_stamp(-1), "19691231-235959");
        // Every day of a 400-year cycle round-trips through the Gregorian rules.
        let mut days = 0_i64;
        let mut date = (1970_i64, 1_u32, 1_u32);
        while days < 146_097 {
            assert_eq!(civil_from_days(days), date, "day {days}");
            days += 1;
            date = next_day(date);
        }
    }

    fn next_day((year, month, day): (i64, u32, u32)) -> (i64, u32, u32) {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let length = match month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        match (day < length, month < 12) {
            (true, _) => (year, month, day + 1),
            (false, true) => (year, month + 1, 1),
            (false, false) => (year + 1, 1, 1),
        }
    }

    #[test]
    fn backup_to_writes_a_sqlite_snapshot_and_keeps_the_newest_seven() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = Library::open(dir.path().join("library.sqlite")).unwrap();
        lib.kv_set("workspace.tabs", "[1]").unwrap();
        lib.doc_put_at(game("t", "{\"a\":1}"), Some("c"), 0)
            .unwrap();
        let backups = dir.path().join("chessin").join("backups");

        let path = lib.backup_to(&backups, 1_761_134_400_000, 7).unwrap();
        assert_eq!(path, backups.join("library-20251022-120000.sqlite"));
        assert!(path.is_file());
        assert!(!backups.join("library-20251022-120000.sqlite.tmp").exists());
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..16], b"SQLite format 3\0");
        // Opened on its own, the copy holds the rows (the WAL content included).
        let copy =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tabs: String = copy
            .query_row(
                "SELECT value FROM kv WHERE key = 'workspace.tabs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tabs, "[1]");
        let versions: i64 = copy
            .query_row("SELECT count(*) FROM document_versions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(versions, 1);
        drop(copy);
        // The live library is untouched and still works.
        lib.kv_set("workspace.tabs", "[2]").unwrap();

        // A backup made the same second replaces the file, not an error.
        let same = lib.backup_to(&backups, 1_761_134_400_999, 7).unwrap();
        assert_eq!(same, path);
        // Unrelated files are left alone by the rotation.
        fs::write(backups.join("notes.txt"), b"keep me").unwrap();
        fs::write(backups.join("library-old.sqlite.bak"), b"keep me").unwrap();

        for i in 1..=8 {
            lib.backup_to(&backups, 1_761_134_400_000 + i * 60_000, 7)
                .unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(&backups)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "library-20251022-120200.sqlite",
                "library-20251022-120300.sqlite",
                "library-20251022-120400.sqlite",
                "library-20251022-120500.sqlite",
                "library-20251022-120600.sqlite",
                "library-20251022-120700.sqlite",
                "library-20251022-120800.sqlite",
                "library-old.sqlite.bak",
                "notes.txt",
            ]
        );

        // A directory that cannot be created is an error, not a panic.
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, b"").unwrap();
        let err = lib.backup_to(&blocker.join("backups"), 0, 7).unwrap_err();
        assert!(matches!(err, Error::CreateDir { .. }), "{err}");
    }

    fn version_data(lib: &Library, version_id: i64) -> String {
        lib.conn
            .query_row(
                "SELECT data FROM document_versions WHERE id = ?1",
                [version_id],
                |r| r.get(0),
            )
            .unwrap()
    }
}
