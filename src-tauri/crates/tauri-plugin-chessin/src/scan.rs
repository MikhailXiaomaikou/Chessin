//! Looks for ChessBase databases on disk (the `scan_chessbase` command).
//!
//! Only `.cbh` (CB v1, importable through `cbh_to_pgn`) and `.2cbh` (the
//! ChessBase 2026 format, listed but not importable yet) header files are
//! reported; the size is the sum of the database's side-car files.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chessin_cb::header::CBH_HEADER_SIZE;

/// How many directory levels below each root are searched.
pub const MAX_DEPTH: usize = 3;

/// Side-car extensions of a CB v1 database, summed into `size_bytes`.
const CBH_SIDECARS: &[&str] = &[
    "cbh", "cbg", "cba", "cbp", "cbt", "cbc", "cbs", "cbj", "cbe", "cbl", "cbm", "cbtt", "cit",
    "cib",
];

/// One database found by [`scan_dirs`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct ChessBaseDb {
    /// The header file (`.cbh` / `.2cbh`).
    pub path: String,
    /// File name without the extension.
    pub name: String,
    /// `cbh` or `2cbh`.
    pub format: String,
    /// Records in the database (games, texts and deleted games); `None` for
    /// `2cbh` and for a `.cbh` file whose size is not a whole number of records.
    pub games: Option<u32>,
    /// Size of the header file plus its side-car files.
    pub size_bytes: u64,
    /// Unix seconds of the header file's last modification, when known.
    pub modified: Option<i64>,
}

/// `$DOCUMENTS/ChessBase`, `$DOCUMENTS/ChessBase/Bases` and
/// `$HOME/Documents/ChessBase` (`%USERPROFILE%\Documents\ChessBase` on Windows),
/// without duplicates. Missing directories are fine; [`scan_dirs`] skips them.
pub fn default_dirs() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    };
    if let Some(documents) = dirs::document_dir() {
        push(documents.join("ChessBase"));
        push(documents.join("ChessBase").join("Bases"));
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join("Documents").join("ChessBase"));
    }
    roots
}

/// Scans each root (and up to [`MAX_DEPTH`] levels of subdirectories) and
/// returns the databases found, sorted by path. Unreadable directories and
/// symbolic links are skipped.
pub fn scan_dirs(roots: &[PathBuf]) -> Vec<ChessBaseDb> {
    let mut found = BTreeMap::new();
    for root in roots {
        if root.is_dir() {
            walk(root, 0, &mut found);
        }
    }
    found.into_values().collect()
}

fn walk(dir: &Path, depth: usize, found: &mut BTreeMap<PathBuf, ChessBaseDb>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, fs::Metadata)> = Vec::new();
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            subdirs.push(entry.path());
        } else if file_type.is_file() {
            if let Ok(metadata) = entry.metadata() {
                files.push((entry.path(), metadata));
            }
        }
    }

    // Side-car sizes per (lower-cased stem, format): ChessBase writes `Games.cbh`
    // next to `Games.cbg`, and Windows does not care about the case.
    let mut sizes: HashMap<(String, &str), u64> = HashMap::new();
    for (path, metadata) in &files {
        if let (Some(stem), Some(format)) = (lower_stem(path), sidecar_format(path)) {
            *sizes.entry((stem, format)).or_default() += metadata.len();
        }
    }

    for (path, metadata) in &files {
        let format = match lower_extension(path).as_deref() {
            Some("cbh") => "cbh",
            Some("2cbh") => "2cbh",
            _ => continue,
        };
        let Some(stem) = lower_stem(path) else {
            continue;
        };
        let games = match format {
            "cbh" => cbh_game_count(metadata.len()),
            _ => None,
        };
        found.insert(
            path.clone(),
            ChessBaseDb {
                path: path.to_string_lossy().into_owned(),
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                format: format.to_string(),
                games,
                size_bytes: sizes
                    .get(&(stem, format))
                    .copied()
                    .unwrap_or(metadata.len()),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .and_then(|d| i64::try_from(d.as_secs()).ok()),
            },
        );
    }

    if depth < MAX_DEPTH {
        for subdir in subdirs {
            walk(&subdir, depth + 1, found);
        }
    }
}

/// Records in a `.cbh` file of `len` bytes: the file is a 46-byte header
/// followed by 46-byte records. `None` when the size does not fit that layout.
pub fn cbh_game_count(len: u64) -> Option<u32> {
    let record = CBH_HEADER_SIZE as u64;
    if len < record || !len.is_multiple_of(record) {
        return None;
    }
    u32::try_from((len - record) / record).ok()
}

fn lower_extension(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

fn lower_stem(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().to_lowercase())
}

/// Which database format a side-car file belongs to, by extension.
fn sidecar_format(path: &Path) -> Option<&'static str> {
    let ext = lower_extension(path)?;
    if CBH_SIDECARS.contains(&ext.as_str()) {
        Some("cbh")
    } else if ext.starts_with("2cb") {
        Some("2cbh")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, len: usize) -> PathBuf {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0u8; len]).unwrap();
        path
    }

    #[test]
    fn game_count_follows_the_record_layout() {
        assert_eq!(cbh_game_count(0), None);
        assert_eq!(cbh_game_count(45), None);
        assert_eq!(cbh_game_count(46), Some(0));
        assert_eq!(cbh_game_count(46 * 4), Some(3));
        assert_eq!(cbh_game_count(46 * 4 + 1), None);
    }

    #[test]
    fn scan_finds_cbh_and_2cbh_files_up_to_three_levels_deep() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let games = write(root, "Games.cbh", 46 * 4);
        write(root, "Games.CBG", 1000);
        write(root, "games.cba", 10);
        write(root, "Games.txt", 99);
        let odd = write(root, "odd.cbh", 50);
        let modern = write(root, "Modern.2cbh", 7);
        write(root, "Modern.2cbg", 3);
        let deep = write(root, "a/b/c/deep.cbh", 46);
        write(root, "a/b/c/d/toodeep.cbh", 46);

        let found = scan_dirs(&[root.to_path_buf()]);
        let paths: Vec<&str> = found.iter().map(|db| db.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                games.to_string_lossy().as_ref(),
                modern.to_string_lossy().as_ref(),
                deep.to_string_lossy().as_ref(),
                odd.to_string_lossy().as_ref(),
            ],
            "sorted by path; the file four levels down is not visited"
        );

        let db = &found[0];
        assert_eq!((db.name.as_str(), db.format.as_str()), ("Games", "cbh"));
        assert_eq!(db.games, Some(3));
        assert_eq!(
            db.size_bytes,
            46 * 4 + 1000 + 10,
            "side-cars, case-insensitively"
        );
        assert!(db.modified.is_some_and(|t| t > 0));

        let db = &found[1];
        assert_eq!((db.name.as_str(), db.format.as_str()), ("Modern", "2cbh"));
        assert_eq!(db.games, None);
        assert_eq!(db.size_bytes, 7 + 3);

        assert_eq!(found[2].games, Some(0));
        assert_eq!(
            found[3].games, None,
            "50 bytes is not a whole number of records"
        );
        assert_eq!(found[3].size_bytes, 50);
    }

    #[test]
    fn scan_skips_missing_roots_and_does_not_list_a_database_twice() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "Bases/x.cbh", 46);
        let roots = vec![
            root.to_path_buf(),
            root.join("Bases"),
            root.join("does-not-exist"),
        ];
        let found = scan_dirs(&roots);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "x");
        assert!(scan_dirs(&[root.join("does-not-exist")]).is_empty());
    }

    #[test]
    fn default_dirs_point_at_chessbase_folders_without_duplicates() {
        let roots = default_dirs();
        let unique: std::collections::BTreeSet<&PathBuf> = roots.iter().collect();
        assert_eq!(roots.len(), unique.len());
        for root in &roots {
            let name = root.file_name().unwrap().to_string_lossy();
            assert!(name == "ChessBase" || name == "Bases", "{}", root.display());
        }
    }
}
