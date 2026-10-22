//! Plugin state of the opening-book and tablebase commands (`book_lookup`,
//! `book_info`, `tablebase_probe`, `tablebase_status`), over [`chessin_book`].
//!
//! Open books (memory maps) and table directories (their table files open
//! lazily on the first probe) are cached per path in two small LRUs. A book
//! whose file changed size or modification time since it was opened is
//! reopened; `tablebase_status` always relists its directory, so a freshly
//! downloaded table shows up without a restart.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use chessin_book::{
    polyglot::{self, Book},
    syzygy::Tables,
    BookInfo, BookMove, TablebaseProbe, TablebaseStatus,
};

/// Open books kept per plugin.
pub const BOOK_LRU_CAPACITY: usize = 8;
/// Table directories kept per plugin.
pub const TABLES_LRU_CAPACITY: usize = 2;

/// What tells a changed book file from the one that was opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Result<Stamp, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Stamp {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

#[derive(Default)]
struct Inner {
    /// Most recently used first.
    books: Vec<(String, Stamp, Arc<Book>)>,
    /// Most recently used first.
    tables: Vec<(String, Arc<Tables>)>,
}

/// Managed by the plugin's `setup`; cheap to clone.
#[derive(Clone, Default)]
pub struct BookState {
    inner: Arc<Mutex<Inner>>,
}

impl BookState {
    pub fn new() -> BookState {
        BookState::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The book at `path`, from the LRU (unless the file changed) or freshly
    /// mapped.
    pub fn book(&self, path: &str) -> Result<Arc<Book>, String> {
        let current = stamp(Path::new(path))?;
        let mut inner = self.lock();
        if let Some(i) = inner.books.iter().position(|(p, _, _)| p == path) {
            let (p, seen, book) = inner.books.remove(i);
            if seen == current {
                inner.books.insert(0, (p, seen, book.clone()));
                return Ok(book);
            }
        }
        let book = Arc::new(Book::open(Path::new(path)).map_err(|e| e.to_string())?);
        inner
            .books
            .insert(0, (path.to_string(), current, book.clone()));
        inner.books.truncate(BOOK_LRU_CAPACITY);
        Ok(book)
    }

    /// The tables of `dir`, from the LRU or freshly listed.
    pub fn tables(&self, dir: &str) -> Result<Arc<Tables>, String> {
        let mut inner = self.lock();
        if let Some(i) = inner.tables.iter().position(|(d, _)| d == dir) {
            let entry = inner.tables.remove(i);
            let tables = entry.1.clone();
            inner.tables.insert(0, entry);
            return Ok(tables);
        }
        drop(inner);
        let tables = Arc::new(Tables::open(Path::new(dir)).map_err(|e| e.to_string())?);
        let mut inner = self.lock();
        inner.tables.retain(|(d, _)| d != dir);
        inner.tables.insert(0, (dir.to_string(), tables.clone()));
        inner.tables.truncate(TABLES_LRU_CAPACITY);
        Ok(tables)
    }

    /// Relists `dir`, replacing a cached entry.
    pub fn reload_tables(&self, dir: &str) -> Result<Arc<Tables>, String> {
        self.lock().tables.retain(|(d, _)| d != dir);
        self.tables(dir)
    }

    /// The paths of the cached books and table directories, MRU first.
    pub fn cached(&self) -> (Vec<String>, Vec<String>) {
        let inner = self.lock();
        (
            inner.books.iter().map(|(p, _, _)| p.clone()).collect(),
            inner.tables.iter().map(|(d, _)| d.clone()).collect(),
        )
    }

    /// `book_lookup`.
    pub fn lookup(&self, path: &str, fen: &str) -> Result<Vec<BookMove>, String> {
        self.book(path)?.lookup_fen(fen).map_err(|e| e.to_string())
    }

    /// `book_info`; nothing is cached.
    pub fn info(path: &str) -> Result<BookInfo, String> {
        polyglot::info(Path::new(path)).map_err(|e| format!("{path}: {e}"))
    }

    /// `tablebase_probe`.
    pub fn probe(&self, dir: &str, fen: &str) -> Result<Option<TablebaseProbe>, String> {
        self.tables(dir)?.probe_fen(fen).map_err(|e| e.to_string())
    }

    /// `tablebase_status`: always relists the directory.
    pub fn status(&self, dir: &str) -> Result<TablebaseStatus, String> {
        Ok(self.reload_tables(dir)?.status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const START_KEY: u64 = 0x463b96181691fc9c;

    /// `e2e4` = (from 12 << 6) | to 28; `d2d4` = (11 << 6) | 27.
    fn book_bytes(moves: &[(u16, u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (code, weight) in moves {
            out.extend_from_slice(&START_KEY.to_be_bytes());
            out.extend_from_slice(&code.to_be_bytes());
            out.extend_from_slice(&weight.to_be_bytes());
            out.extend_from_slice(&0u32.to_be_bytes());
        }
        out
    }

    #[test]
    fn books_are_cached_and_reopened_when_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.bin");
        std::fs::write(&path, book_bytes(&[((12 << 6) | 28, 100)])).unwrap();
        let path = path.to_string_lossy().into_owned();
        let state = BookState::new();

        let first = state.lookup(&path, START).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].uci, "e2e4");
        assert_eq!(state.cached().0, vec![path.clone()]);
        let kept = state.book(&path).unwrap();
        assert!(Arc::ptr_eq(&kept, &state.book(&path).unwrap()));

        // A bigger file is a changed file: reopened, and the new entry shows.
        std::fs::write(
            &path,
            book_bytes(&[((11 << 6) | 27, 50), ((12 << 6) | 28, 100)]),
        )
        .unwrap();
        let second = state.lookup(&path, START).unwrap();
        assert_eq!(second.len(), 2);
        assert!(!Arc::ptr_eq(&kept, &state.book(&path).unwrap()));

        assert_eq!(
            BookState::info(&path).unwrap(),
            BookInfo {
                format: "polyglot".into(),
                entries: Some(2),
                bytes: 32
            }
        );
        let missing = dir
            .path()
            .join("missing.bin")
            .to_string_lossy()
            .into_owned();
        assert!(state
            .lookup(&missing, START)
            .unwrap_err()
            .contains("missing.bin"));
        assert!(BookState::info(&missing)
            .unwrap_err()
            .contains("missing.bin"));
    }

    #[test]
    fn the_book_lru_keeps_the_most_recent_books() {
        let dir = tempfile::tempdir().unwrap();
        let state = BookState::new();
        let mut paths = Vec::new();
        for i in 0..=BOOK_LRU_CAPACITY {
            let path = dir.path().join(format!("{i}.bin"));
            std::fs::write(&path, book_bytes(&[((12 << 6) | 28, 1)])).unwrap();
            let path = path.to_string_lossy().into_owned();
            state.book(&path).unwrap();
            paths.push(path);
        }
        let (books, _) = state.cached();
        assert_eq!(books.len(), BOOK_LRU_CAPACITY);
        assert_eq!(books[0], paths[BOOK_LRU_CAPACITY]);
        assert!(!books.contains(&paths[0]));
    }

    #[test]
    fn tables_are_cached_per_directory_and_status_relists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let state = BookState::new();

        assert_eq!(state.status(&path).unwrap(), TablebaseStatus::default());
        assert_eq!(
            state
                .probe(&path, "8/8/8/8/8/4k3/8/4K2Q w - - 0 1")
                .unwrap(),
            None
        );
        let cached = state.tables(&path).unwrap();
        assert!(Arc::ptr_eq(&cached, &state.tables(&path).unwrap()));

        // A table file appears: `status` relists, `probe` then sees it.
        std::fs::write(dir.path().join("KQvK.rtbw"), [0u8; 16]).unwrap();
        assert!(Arc::ptr_eq(&cached, &state.tables(&path).unwrap()));
        assert_eq!(
            state.status(&path).unwrap(),
            TablebaseStatus {
                pieces: 3,
                files: 1
            }
        );
        assert!(!Arc::ptr_eq(&cached, &state.tables(&path).unwrap()));
        // The fake table is corrupt: probing it is an error, not a silent None.
        assert!(state
            .probe(&path, "8/8/8/8/8/4k3/8/4K2Q w - - 0 1")
            .is_err());

        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        assert!(state.status(&missing).is_err());

        // The LRU holds two directories.
        let other = tempfile::tempdir().unwrap();
        let third = tempfile::tempdir().unwrap();
        state.tables(&other.path().to_string_lossy()).unwrap();
        state.tables(&third.path().to_string_lossy()).unwrap();
        let (_, dirs) = state.cached();
        assert_eq!(dirs.len(), TABLES_LRU_CAPACITY);
        assert!(!dirs.contains(&path));
    }
}
