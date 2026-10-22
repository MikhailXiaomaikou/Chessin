//! Tauri plugin that registers Chessin's commands and events with the host app.
//!
//! The app's `main.rs` only adds `.plugin(tauri_plugin_chessin::init())`; every
//! Chessin command lives here (or in the `chessin-*` crates it wraps) instead of
//! the upstream `collect_commands!` list, so monthly upstream merges stay clean.
//!
//! Commands are invoked from the frontend as `plugin:chessin|<command>`; the
//! permissions are `chessin:default` / `chessin:allow-<command>`.
//!
//! The library store commands (`store_*`, `doc_*`, `move_to_trash`, `job_*`,
//! `eval_cache_*`, `card_*`) share one SQLite connection to
//! `<app_data_dir>/chessin/library.sqlite`, held in [`LibraryState`] and used
//! from a blocking thread.

mod library;
mod scan;

use std::path::{Path, PathBuf};

use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime, State,
};

use chessin_core::store::NewDocument;

pub use chessin_cb::{CbhImportReport, UnsupportedAnnotation};
pub use chessin_core::store::{
    CachedEval, CardRecord, CardStats, Document, DocumentMeta, JobRecord, VersionMeta,
};
pub use library::LibraryState;
pub use scan::ChessBaseDb;

/// Name the plugin is registered under.
pub const PLUGIN_NAME: &str = "chessin";

/// Where the TypeScript bindings for this plugin's commands are written in debug
/// builds. Anchored to this crate's directory so it does not depend on the
/// working directory of the running app.
const BINDINGS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../src/chessin/bindings.ts"
);

/// Smoke test: returns `"pong"` from `chessin-core`.
#[tauri::command]
#[specta::specta]
fn chessin_ping() -> String {
    chessin_core::ping().to_string()
}

/// Converts a ChessBase `.cbh` database (the sibling `.cbg`, `.cba`, `.cbp`,
/// `.cbt`, `.cbc` and `.cbs` files are found next to it) into one PGN file at
/// `out_pgn_path`, which the frontend then imports with `convert_pgn`.
#[tauri::command]
#[specta::specta]
async fn cbh_to_pgn(cbh_path: String, out_pgn_path: String) -> Result<CbhImportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chessin_cb::convert_to_pgn(&cbh_path, &out_pgn_path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- library store: kv -------------------------------------------------

/// Reads a key of the `kv` table (`workspace.tabs`, …); `None` when unset.
#[tauri::command]
#[specta::specta]
async fn store_get(key: String, state: State<'_, LibraryState>) -> Result<Option<String>, String> {
    state.run(move |lib| lib.kv_get(&key)).await
}

/// Writes a key of the `kv` table.
#[tauri::command]
#[specta::specta]
async fn store_set(
    key: String,
    value: String,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    state.run(move |lib| lib.kv_set(&key, &value)).await
}

/// Removes a key of the `kv` table; a missing key is not an error.
#[tauri::command]
#[specta::specta]
async fn store_delete(key: String, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.kv_delete(&key)).await
}

// ----- library store: documents -----------------------------------------

/// Inserts or replaces a document (`data` is JSON) and records a version: a
/// new labelled one when `checkpoint` is given, otherwise a new one only when
/// the latest version is a checkpoint or older than 5 minutes (else that
/// version takes the new data). At most 50 versions are kept per document.
#[tauri::command]
#[specta::specta]
async fn doc_put(
    id: String,
    kind: String,
    title: String,
    origin: Option<String>,
    data: String,
    checkpoint: Option<String>,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    state
        .run(move |lib| {
            lib.doc_put(
                NewDocument {
                    id: &id,
                    kind: &kind,
                    title: &title,
                    origin: origin.as_deref(),
                    data: &data,
                },
                checkpoint.as_deref(),
            )
        })
        .await
}

/// The document with its payload; `None` when it does not exist.
#[tauri::command]
#[specta::specta]
async fn doc_get(id: String, state: State<'_, LibraryState>) -> Result<Option<Document>, String> {
    state.run(move |lib| lib.doc_get(&id)).await
}

/// Documents of `kind` (every kind when `None`) without their payload, most
/// recently updated first.
#[tauri::command]
#[specta::specta]
async fn doc_list(
    kind: Option<String>,
    state: State<'_, LibraryState>,
) -> Result<Vec<DocumentMeta>, String> {
    state.run(move |lib| lib.doc_list(kind.as_deref())).await
}

/// Deletes a document and its versions; a missing document is not an error.
#[tauri::command]
#[specta::specta]
async fn doc_delete(id: String, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.doc_delete(&id)).await
}

/// The versions of a document, newest first.
#[tauri::command]
#[specta::specta]
async fn doc_versions(
    id: String,
    state: State<'_, LibraryState>,
) -> Result<Vec<VersionMeta>, String> {
    state.run(move |lib| lib.doc_versions(&id)).await
}

/// Makes `version_id` the document's current payload; the state before the
/// restore stays in the history.
#[tauri::command]
#[specta::specta]
async fn doc_restore_version(
    id: String,
    version_id: i64,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    state
        .run(move |lib| lib.doc_restore_version(&id, version_id))
        .await
}

// ----- library store: jobs ------------------------------------------------

/// Inserts or replaces a background job, every field included; the frontend's
/// job runner writes each transition through this.
#[tauri::command]
#[specta::specta]
async fn job_upsert(job: JobRecord, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.job_upsert(&job)).await
}

/// The jobs with `status` (`queued`, `running`, `done`, `failed`, `cancelled`;
/// every status when `None`): running first, then queued, then finished,
/// newest first within each group. A job left `running` by a crash is
/// `queued` again once the library is reopened.
#[tauri::command]
#[specta::specta]
async fn job_list(
    status: Option<String>,
    state: State<'_, LibraryState>,
) -> Result<Vec<JobRecord>, String> {
    state.run(move |lib| lib.job_list(status.as_deref())).await
}

/// Deletes a job; a missing one is not an error.
#[tauri::command]
#[specta::specta]
async fn job_delete(id: String, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.job_delete(&id)).await
}

/// Keeps the `keep_finished` most recently updated done/failed/cancelled jobs,
/// deletes the other finished ones and returns how many were deleted.
#[tauri::command]
#[specta::specta]
async fn job_prune(keep_finished: u32, state: State<'_, LibraryState>) -> Result<u32, String> {
    state.run(move |lib| lib.job_prune(keep_finished)).await
}

// ----- library store: engine evaluation cache -----------------------------

/// The cached evaluations of `epds` by `engine` whose depth reaches
/// `min_depth`, each position at most once, in no particular order.
#[tauri::command]
#[specta::specta]
async fn eval_cache_get(
    epds: Vec<String>,
    engine: String,
    min_depth: u32,
    state: State<'_, LibraryState>,
) -> Result<Vec<CachedEval>, String> {
    state
        .run(move |lib| lib.eval_cache_get(&epds, &engine, min_depth))
        .await
}

/// Caches evaluations; an entry only replaces the stored one of its
/// (position, engine) when its depth is at least the stored depth.
#[tauri::command]
#[specta::specta]
async fn eval_cache_put(
    entries: Vec<CachedEval>,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    state.run(move |lib| lib.eval_cache_put(&entries)).await
}

// ----- library store: training cards --------------------------------------

/// Inserts or replaces training cards, every field included; an existing
/// card keeps its review log.
#[tauri::command]
#[specta::specta]
async fn card_upsert(cards: Vec<CardRecord>, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.card_upsert(&cards)).await
}

/// Up to `limit` cards due at or before `due_before` (every card when `None`),
/// soonest due first.
#[tauri::command]
#[specta::specta]
async fn card_list(
    due_before: Option<i64>,
    limit: u32,
    state: State<'_, LibraryState>,
) -> Result<Vec<CardRecord>, String> {
    state.run(move |lib| lib.card_list(due_before, limit)).await
}

/// The card; `None` when it does not exist.
#[tauri::command]
#[specta::specta]
async fn card_get(
    id: String,
    state: State<'_, LibraryState>,
) -> Result<Option<CardRecord>, String> {
    state.run(move |lib| lib.card_get(&id)).await
}

/// Deletes a card and its review log; a missing card is not an error.
#[tauri::command]
#[specta::specta]
async fn card_delete(id: String, state: State<'_, LibraryState>) -> Result<(), String> {
    state.run(move |lib| lib.card_delete(&id)).await
}

/// Records a review of the card (`rating` 1–4 as in FSRS, `log` the ts-fsrs
/// `ReviewLog` as JSON); the card must exist.
#[tauri::command]
#[specta::specta]
async fn card_log(
    card_id: String,
    reviewed_at: i64,
    rating: u32,
    log: String,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    state
        .run(move |lib| {
            lib.card_log(&card_id, reviewed_at, rating, &log)
                .map(|_| ())
        })
        .await
}

/// Counts the cards as of `now` (Unix milliseconds): total, due (`due <= now`),
/// new (never graded) and reviewed today (distinct cards graded during the UTC
/// calendar day that contains `now`).
#[tauri::command]
#[specta::specta]
async fn card_stats(now: i64, state: State<'_, LibraryState>) -> Result<CardStats, String> {
    state.run(move |lib| lib.card_stats(now)).await
}

// ----- trash and ChessBase scan -------------------------------------------

/// Moves files and directories to the OS recycle bin, records each success in
/// the `trash` table and returns the paths that could not be moved.
#[tauri::command]
#[specta::specta]
async fn move_to_trash(
    paths: Vec<String>,
    state: State<'_, LibraryState>,
) -> Result<Vec<String>, String> {
    state
        .run(move |lib| lib.move_to_trash(&paths, os_trash))
        .await
}

fn os_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// Lists the ChessBase databases (`.cbh`, `.2cbh`) under `dirs`, or under the
/// usual `Documents/ChessBase` folders when `dirs` is `None`, searching up to
/// three directory levels deep.
#[tauri::command]
#[specta::specta]
async fn scan_chessbase(dirs: Option<Vec<String>>) -> Result<Vec<ChessBaseDb>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = match dirs {
            Some(dirs) => dirs.into_iter().map(PathBuf::from).collect(),
            None => scan::default_dirs(),
        };
        scan::scan_dirs(&roots)
    })
    .await
    .map_err(|e| e.to_string())
}

fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![
            chessin_ping,
            cbh_to_pgn,
            store_get,
            store_set,
            store_delete,
            doc_put,
            doc_get,
            doc_list,
            doc_delete,
            doc_versions,
            doc_restore_version,
            job_upsert,
            job_list,
            job_delete,
            job_prune,
            eval_cache_get,
            eval_cache_put,
            card_upsert,
            card_list,
            card_get,
            card_delete,
            card_log,
            card_stats,
            move_to_trash,
            scan_chessbase,
        ])
}

#[cfg(any(debug_assertions, test))]
fn typescript() -> specta_typescript::Typescript {
    specta_typescript::Typescript::default().bigint(specta_typescript::BigIntExportBehavior::BigInt)
}

/// Build the plugin.
///
/// In debug builds this also regenerates `src/chessin/bindings.ts` from the
/// registered commands and events, mirroring how `main.rs` exports
/// `src/bindings/generated.ts`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = specta_builder::<R>();

    #[cfg(debug_assertions)]
    builder
        .export(typescript(), BINDINGS_PATH)
        .expect("Failed to export Chessin bindings");

    PluginBuilder::new(PLUGIN_NAME)
        .invoke_handler(builder.invoke_handler())
        .setup(move |app, _api| {
            builder.mount_events(app);
            let data_dir = app.path().app_data_dir()?;
            app.manage(LibraryState::new(
                data_dir.join("chessin").join("library.sqlite"),
            ));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_delegates_to_core() {
        assert_eq!(chessin_ping(), "pong");
    }

    #[test]
    fn cbh_to_pgn_reports_a_missing_database() {
        let err = tauri::async_runtime::block_on(cbh_to_pgn(
            "/nonexistent/games.cbh".to_string(),
            "/nonexistent/out.pgn".to_string(),
        ))
        .unwrap_err();
        assert!(err.contains("games.cbh"), "{err}");
    }

    /// The command bodies are one-liners over `LibraryState`; this covers the
    /// plumbing from the state down to the store with a fake recycle bin.
    #[test]
    fn move_to_trash_through_the_state_records_rows_and_failures() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let file = dir.path().join("games.db3");
        std::fs::write(&file, b"x").unwrap();
        let paths = vec![
            file.to_string_lossy().into_owned(),
            dir.path().join("missing").to_string_lossy().into_owned(),
        ];

        let state = LibraryState::new(dir.path().join("library.sqlite"));
        let failed = state
            .with(|lib| {
                lib.move_to_trash(&paths, |path| {
                    std::fs::rename(path, bin.join(path.file_name().unwrap()))
                        .map_err(|e| e.to_string())
                })
            })
            .unwrap();
        assert_eq!(failed, vec![paths[1].clone()]);
        let rows = state.with(|lib| lib.trash_entries()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, paths[0]);
    }

    /// The v2 store commands are one-liners over `LibraryState::run`; this
    /// drives each table through the state on the async runtime, the way the
    /// commands do.
    #[test]
    fn v2_store_commands_run_through_the_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = LibraryState::new(dir.path().join("library.sqlite"));
        let job = JobRecord {
            id: "j1".into(),
            kind: "review".into(),
            title: "Review".into(),
            status: "running".into(),
            payload: "{}".into(),
            progress: 0.25,
            result: None,
            error: None,
            created_at: 1_000,
            updated_at: 1_000,
        };
        let eval = CachedEval {
            epd: "8/8/8/8/8/8/8/K6k w - -".into(),
            engine: "sf17".into(),
            depth: 20,
            score_type: "cp".into(),
            score_value: 0,
            best_uci: "a1a2".into(),
            pv: "a1a2 h1h2".into(),
        };
        let card = CardRecord {
            id: "fm:x".into(),
            epd: "x".into(),
            kind: "find_move".into(),
            answer: "[\"e2e4\"]".into(),
            source: None,
            due: 500,
            fsrs: "{}".into(),
            meta: "{}".into(),
            created_at: 100,
            updated_at: 100,
        };

        tauri::async_runtime::block_on(async {
            // Jobs.
            state
                .run({
                    let job = job.clone();
                    move |lib| lib.job_upsert(&job)
                })
                .await
                .unwrap();
            let done = JobRecord {
                id: "j2".into(),
                status: "done".into(),
                ..job.clone()
            };
            state.run(move |lib| lib.job_upsert(&done)).await.unwrap();
            let listed = state.run(|lib| lib.job_list(None)).await.unwrap();
            assert_eq!(
                listed.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
                ["j1", "j2"]
            );
            assert_eq!(listed[0], job);
            assert_eq!(state.run(|lib| lib.job_prune(0)).await.unwrap(), 1);
            state.run(|lib| lib.job_delete("j1")).await.unwrap();
            assert!(state
                .run(|lib| lib.job_list(None))
                .await
                .unwrap()
                .is_empty());

            // Eval cache.
            state
                .run({
                    let entries = vec![eval.clone()];
                    move |lib| lib.eval_cache_put(&entries)
                })
                .await
                .unwrap();
            let epds = vec![eval.epd.clone()];
            let got = state
                .run(move |lib| lib.eval_cache_get(&epds, "sf17", 10))
                .await
                .unwrap();
            assert_eq!(got, vec![eval]);

            // Cards.
            state
                .run({
                    let cards = vec![card.clone()];
                    move |lib| lib.card_upsert(&cards)
                })
                .await
                .unwrap();
            assert_eq!(
                state.run(|lib| lib.card_get("fm:x")).await.unwrap(),
                Some(card.clone())
            );
            assert_eq!(
                state.run(|lib| lib.card_list(Some(500), 10)).await.unwrap(),
                vec![card]
            );
            state
                .run(|lib| lib.card_log("fm:x", 600, 3, "{}").map(|_| ()))
                .await
                .unwrap();
            let stats = state.run(|lib| lib.card_stats(600)).await.unwrap();
            assert_eq!(
                stats,
                CardStats {
                    total: 1,
                    due: 1,
                    new: 0,
                    reviewed_today: 1
                }
            );
            let err = state
                .run(|lib| lib.card_log("missing", 0, 1, "{}"))
                .await
                .unwrap_err();
            assert!(err.contains("missing"), "{err}");
            state.run(|lib| lib.card_delete("fm:x")).await.unwrap();
            assert_eq!(
                state.run(|lib| lib.card_stats(600)).await.unwrap(),
                CardStats::default()
            );
        });
    }

    #[test]
    fn scan_chessbase_accepts_explicit_directories() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.cbh"), vec![0u8; 46 * 3]).unwrap();
        let found = tauri::async_runtime::block_on(scan_chessbase(Some(vec![dir
            .path()
            .to_string_lossy()
            .into_owned()])))
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].name.as_str(), found[0].games), ("x", Some(2)));
        // The default folders may or may not exist here; the scan must not fail.
        tauri::async_runtime::block_on(scan_chessbase(None)).unwrap();
    }

    /// The committed `src/chessin/bindings.ts` must match what a debug build of
    /// the app would export, so the frontend never drifts from the Rust side.
    #[test]
    fn committed_bindings_are_up_to_date() {
        let expected = specta_builder::<tauri::Wry>()
            .export_str(typescript())
            .expect("export bindings");
        let committed = std::fs::read_to_string(BINDINGS_PATH)
            .unwrap_or_else(|e| panic!("read {BINDINGS_PATH}: {e}"));
        assert_eq!(
            committed, expected,
            "src/chessin/bindings.ts is stale; run `pnpm dev:chessin` once, or `cargo test -p tauri-plugin-chessin -- --ignored write_bindings`, to regenerate it"
        );
    }

    /// Rewrites `src/chessin/bindings.ts` without launching the app:
    /// `cargo test -p tauri-plugin-chessin -- --ignored write_bindings`.
    #[test]
    #[ignore = "writes the committed bindings; run on demand"]
    fn write_bindings() {
        specta_builder::<tauri::Wry>()
            .export(typescript(), BINDINGS_PATH)
            .expect("export bindings");
    }
}
