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
//! Game databases stay in En Croissant's `.db3` format so that En Croissant can
//! still open a Chessin library; anything Chessin adds there goes into `chessin_*`
//! tables with their own migrations, plus the side-car `.cpi` position index.
//!
//! Timestamps are Unix milliseconds. Every method takes `&self`/`&mut self` on a
//! single connection; the plugin serialises access with a mutex.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

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
    #[error("library schema version {found} is newer than this build supports ({SCHEMA_VERSION})")]
    SchemaTooNew { found: u32 },
    #[error("no document {id}")]
    NoSuchDocument { id: String },
    #[error("document {doc_id} has no version {version_id}")]
    NoSuchVersion { doc_id: String, version_id: i64 },
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
