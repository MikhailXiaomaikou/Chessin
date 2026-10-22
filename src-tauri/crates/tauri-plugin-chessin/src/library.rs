//! Plugin state: the lazily opened `library.sqlite` (see `chessin_core::store`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chessin_core::store::{self, Library};

/// Managed by the plugin's `setup`; cheap to clone (the connection is shared).
///
/// The file is opened on first use so that a broken app data directory shows
/// up as a command error rather than a failure to start the app.
#[derive(Clone)]
pub struct LibraryState {
    path: PathBuf,
    library: Arc<Mutex<Option<Library>>>,
}

impl LibraryState {
    /// `path` is the `.sqlite` file; its directories are created on open.
    pub fn new(path: PathBuf) -> LibraryState {
        LibraryState {
            path,
            library: Arc::new(Mutex::new(None)),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs `f` against the library on a blocking thread (SQLite is synchronous),
    /// opening the file first if this is the first call.
    pub async fn run<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Library) -> Result<T, store::Error> + Send + 'static,
    {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || state.with(f))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Synchronous [`LibraryState::run`]; blocks the current thread while another
    /// command holds the connection.
    pub fn with<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut Library) -> Result<T, store::Error>,
    {
        // A panic while holding the lock leaves a usable connection (an open
        // transaction is rolled back when dropped), so the poison is ignored.
        let mut guard = self.library.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(Library::open(&self.path).map_err(|e| e.to_string())?);
        }
        let library = guard.as_mut().expect("opened above");
        f(library).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_lazily_and_creates_the_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chessin").join("library.sqlite");
        let state = LibraryState::new(path.clone());
        assert!(!path.exists(), "nothing is opened before the first command");

        state.with(|lib| lib.kv_set("k", "v")).unwrap();
        assert!(path.is_file());
        let value = state.clone().with(|lib| lib.kv_get("k")).unwrap();
        assert_eq!(value.as_deref(), Some("v"));
        assert_eq!(state.path(), path);
    }

    #[test]
    fn run_executes_on_a_blocking_thread() {
        let dir = tempfile::tempdir().unwrap();
        let state = LibraryState::new(dir.path().join("library.sqlite"));
        let value = tauri::async_runtime::block_on(async {
            state.run(|lib| lib.kv_set("a", "1")).await.unwrap();
            state.run(|lib| lib.kv_get("a")).await
        })
        .unwrap();
        assert_eq!(value.as_deref(), Some("1"));
    }

    #[test]
    fn an_unopenable_path_is_a_command_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        // The parent is a file, so the directory cannot be created.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"").unwrap();
        let state = LibraryState::new(blocker.join("library.sqlite"));
        let err = state.with(|lib| lib.kv_get("a")).unwrap_err();
        assert!(err.contains("blocker"), "{err}");
    }
}
