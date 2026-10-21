//! Tauri plugin that registers Chessin's commands and events with the host app.
//!
//! The app's `main.rs` only adds `.plugin(tauri_plugin_chessin::init())`; every
//! Chessin command lives here (or in the `chessin-*` crates it wraps) instead of
//! the upstream `collect_commands!` list, so monthly upstream merges stay clean.
//!
//! Commands are invoked from the frontend as `plugin:chessin|<command>`; the
//! permissions are `chessin:default` / `chessin:allow-<command>`.

use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};

pub use chessin_cb::{CbhImportReport, UnsupportedAnnotation};

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

fn specta_builder<R: Runtime>() -> tauri_specta::Builder<R> {
    tauri_specta::Builder::<R>::new()
        .plugin_name(PLUGIN_NAME)
        .commands(tauri_specta::collect_commands![chessin_ping, cbh_to_pgn])
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
