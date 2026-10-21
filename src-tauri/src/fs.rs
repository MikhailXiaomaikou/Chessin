use std::{
    fs::create_dir_all,
    io::{Read, Seek},
    path::{Path, PathBuf},
};

use log::info;
use reqwest::{
    header::{HeaderMap, AUTHORIZATION, CONTENT_RANGE, RANGE},
    Client, Response, StatusCode,
};
use sha2::{Digest, Sha256};
use specta::Type;
use tokio::io::{AsyncWriteExt, BufWriter};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use flate2::read::GzDecoder;
use futures_util::StreamExt;

use crate::error::Error;
use crate::progress::update_progress;
use crate::AppState;

/// Downloads `url` to `path`.
///
/// The body is streamed to disk into a `.part` file next to the destination
/// (`<path>.part`, or `<path>/<archive name>.part` when the URL points at an
/// archive, in which case `path` is the directory it is extracted into). An
/// interrupted download is resumed on the next call with an HTTP `Range`
/// request; a server that answers with `200` instead of `206` restarts it.
///
/// When `sha256` is given, the hex digest of the complete file is checked
/// against it before anything is extracted or moved into place; on mismatch
/// the `.part` file is deleted and an error is returned. Plain files are then
/// renamed atomically onto `path`; archives are extracted into it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub async fn download_file(
    id: String,
    url: String,
    path: PathBuf,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    token: Option<String>,
    finalize: Option<bool>,
    total_size: Option<u32>,
    sha256: Option<String>,
) -> Result<(), Error> {
    let finalize = finalize.unwrap_or(true);
    info!("Downloading file from {}", url);

    let kind = archive_kind(&url);
    let part_path = partial_path(&url, &path, kind.is_some());
    if let Some(parent) = part_path.parent() {
        create_dir_all(parent)?;
    }

    let client = Client::new();
    let existing = match tokio::fs::metadata(&part_path).await {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => 0,
    };

    let mut res = send_request(&client, &url, token.as_deref(), existing).await?;
    if existing > 0 && res.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        // The partial file no longer matches what the server has: start over.
        info!("Server rejected resume of {}, restarting", url);
        res = send_request(&client, &url, token.as_deref(), 0).await?;
    }
    let res = res.error_for_status()?;

    let resume = existing > 0 && res.status() == StatusCode::PARTIAL_CONTENT;
    let mut downloaded: u64 = if resume { existing } else { 0 };
    if resume {
        info!("Resuming download of {} at byte {}", url, existing);
    }

    let total_size = match total_size {
        Some(total_size) => Some(total_size as u64),
        None if resume => content_range_total(res.headers())
            .or_else(|| res.content_length().map(|rest| rest + existing)),
        None => res.content_length(),
    };

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true);
    if resume {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }
    let mut writer = BufWriter::new(options.open(&part_path).await?);
    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item?;
        writer.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if let Some(total_size) = total_size {
            let progress = ((downloaded as f32 / total_size as f32) * 100.0).min(100.0);
            update_progress(&state.progress_state, &app, id.clone(), progress, false)?;
        }
    }
    writer.flush().await?;
    writer.into_inner().sync_all().await?;

    info!("Downloaded {} bytes to {}", downloaded, part_path.display());

    if let Some(expected) = sha256 {
        let hashed = part_path.clone();
        let verified = tokio::task::spawn_blocking(move || verify_sha256(&hashed, &expected))
            .await
            .map_err(std::io::Error::other)?;
        if let Err(e) = verified {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e);
        }
    }

    match kind {
        Some(ArchiveKind::Zip) => unzip_file(&path, std::fs::File::open(&part_path)?)?,
        Some(ArchiveKind::Tar) => {
            let mut archive = tar::Archive::new(std::fs::File::open(&part_path)?);
            archive.unpack(&path)?;
        }
        Some(ArchiveKind::TarGz) => {
            unpack_tar_gz(&path, std::fs::File::open(&part_path)?)?;
        }
        None => {}
    }
    if kind.is_some() {
        std::fs::remove_file(&part_path)?;
    } else {
        std::fs::rename(&part_path, &path)?;
    }

    info!("Downloaded file to {}", path.display());

    if finalize {
        update_progress(&state.progress_state, &app, id, 100.0, true)?;
    }
    Ok(())
}

async fn send_request(
    client: &Client,
    url: &str,
    token: Option<&str>,
    from: u64,
) -> Result<Response, Error> {
    let mut req = client.get(url);
    // add Bearer if token is present
    if let Some(token) = token {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if from > 0 {
        req = req.header(RANGE, format!("bytes={from}-"));
    }
    Ok(req.send().await?)
}

/// Total length announced by a `Content-Range: bytes <from>-<to>/<total>` header.
fn content_range_total(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_RANGE)?
        .to_str()
        .ok()?
        .rsplit('/')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Where the bytes are written while the download is in flight.
///
/// For a plain file that is `<path>.part`; for an archive `path` is the
/// extraction directory, so the archive is staged inside it under its URL
/// file name.
fn partial_path(url: &str, path: &Path, is_archive: bool) -> PathBuf {
    if is_archive {
        let name = url
            .split(['?', '#'])
            .next()
            .unwrap_or(url)
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("download");
        path.join(format!("{name}.part"))
    } else {
        let mut file_name = path.as_os_str().to_os_string();
        file_name.push(".part");
        PathBuf::from(file_name)
    }
}

/// Hex-encoded SHA-256 digest of the file at `path`, computed by streaming it.
pub fn sha256_file(path: &Path) -> Result<String, Error> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Checks that the file at `path` hashes to `expected` (hex, case-insensitive).
pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), Error> {
    let expected = expected.trim().to_ascii_lowercase();
    let actual = sha256_file(path)?;
    if actual == expected {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "sha256 mismatch for {}: expected {expected}, got {actual}",
                path.display()
            ),
        )
        .into())
    }
}

fn unpack_tar_gz<R: Read>(path: &Path, file: R) -> Result<(), Error> {
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(path)?;
    Ok(())
}

#[derive(Debug, PartialEq)]
enum ArchiveKind {
    Zip,
    Tar,
    TarGz,
}

fn archive_kind(url: &str) -> Option<ArchiveKind> {
    let path = url.split(['?', '#']).next().unwrap_or(url);

    if path.ends_with(".tar.gz") {
        Some(ArchiveKind::TarGz)
    } else if path.ends_with(".zip") {
        Some(ArchiveKind::Zip)
    } else if path.ends_with(".tar") {
        Some(ArchiveKind::Tar)
    } else {
        None
    }
}

pub fn unzip_file<R: Read + Seek>(path: &Path, file: R) -> Result<(), Error> {
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = path.join(file.mangled_name());
        if (*file.name()).ends_with('/') {
            info!(
                "File {} extracted to \"{}\"",
                i,
                outpath.as_path().display()
            );
            create_dir_all(&outpath)?;
        } else {
            info!(
                "File {} extracted to \"{}\" ({} bytes)",
                i,
                outpath.as_path().display(),
                file.size()
            );
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    create_dir_all(p)?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_file_as_executable(_path: String) -> Result<(), Error> {
    #[cfg(unix)]
    {
        let path = Path::new(&_path);
        let metadata = std::fs::metadata(path)?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn file_exists(path: String) -> Result<bool, Error> {
    Ok(Path::new(&path).exists())
}

#[derive(Debug, Type, serde::Serialize)]
pub struct FileMetadata {
    pub last_modified: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn get_file_metadata(path: String) -> Result<FileMetadata, Error> {
    let metadata = std::fs::metadata(path)?;
    let last_modified = metadata
        .modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?;
    Ok(FileMetadata {
        last_modified: last_modified.as_secs() as u32,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use reqwest::header::HeaderValue;

    use super::*;

    /// `printf abc | sha256sum`
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn temp_file(contents: &[u8]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(contents).unwrap();
        file.flush().unwrap();
        file
    }

    #[test]
    fn sha256_file_hashes_contents() {
        let file = temp_file(b"abc");
        assert_eq!(sha256_file(file.path()).unwrap(), ABC_SHA256);

        let empty = temp_file(b"");
        assert_eq!(
            sha256_file(empty.path()).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn verify_sha256_accepts_matching_digest() {
        let file = temp_file(b"abc");
        assert!(verify_sha256(file.path(), ABC_SHA256).is_ok());
        // Case and surrounding whitespace do not matter.
        let upper = format!("  {}\n", ABC_SHA256.to_uppercase());
        assert!(verify_sha256(file.path(), &upper).is_ok());
    }

    #[test]
    fn verify_sha256_rejects_wrong_digest() {
        let file = temp_file(b"abd");
        let err = verify_sha256(file.path(), ABC_SHA256).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("sha256 mismatch"), "{message}");
        assert!(message.contains(ABC_SHA256), "{message}");
        // The file itself is left alone by the helper.
        assert!(file.path().exists());
    }

    #[test]
    fn verify_sha256_fails_on_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(verify_sha256(&dir.path().join("missing"), ABC_SHA256).is_err());
    }

    #[test]
    fn partial_path_stages_next_to_destination() {
        assert_eq!(
            partial_path(
                "https://example.org/lichess.db3",
                Path::new("/data/db/lichess.db3"),
                false
            ),
            PathBuf::from("/data/db/lichess.db3.part")
        );
        assert_eq!(
            partial_path(
                "https://example.org/sf/stockfish.tar.gz?v=1#x",
                Path::new("/data/engines"),
                true
            ),
            PathBuf::from("/data/engines/stockfish.tar.gz.part")
        );
        assert_eq!(
            partial_path("https://example.org/", Path::new("/data/engines"), true),
            PathBuf::from("/data/engines/download.part")
        );
    }

    #[test]
    fn content_range_total_parses_total_length() {
        let mut headers = HeaderMap::new();
        assert_eq!(content_range_total(&headers), None);

        headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_static("bytes 100-999/1000"),
        );
        assert_eq!(content_range_total(&headers), Some(1000));

        headers.insert(CONTENT_RANGE, HeaderValue::from_static("bytes */*"));
        assert_eq!(content_range_total(&headers), None);
    }

    #[test]
    fn archive_kind_ignores_query_and_fragment() {
        assert_eq!(
            archive_kind("https://x/a.tar.gz?x=1"),
            Some(ArchiveKind::TarGz)
        );
        assert_eq!(archive_kind("https://x/a.zip#frag"), Some(ArchiveKind::Zip));
        assert_eq!(archive_kind("https://x/a.tar"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("https://x/a.db3"), None);
    }
}
