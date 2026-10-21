# Chessin catalog

Static JSON files that the desktop app fetches to populate its "download an
engine / database / puzzle set" dialogs. They replace the dynamic endpoints
En Croissant serves from `www.encroissant.org/{engines,databases,puzzle_databases}`.
En Croissant's catalog is **not** reused: these files start empty and are
curated for Chessin (Stockfish is downloaded on first run, not bundled).

The app reads them from `CATALOG_BASE_URL` (`src/chessin/config.ts`), which
defaults to the raw GitHub URL of this directory on `main`:

```
https://raw.githubusercontent.com/MikhailXiaomaikou/Chessin/main/catalog/<file>
```

Override it at build time with `VITE_CHESSIN_CATALOG_BASE_URL` (for a CN
mirror later). Each file is a JSON array; an empty catalog is `[]`.

The shapes below are derived from the TypeScript types the app parses the
responses into (`src/utils/engines.ts`, `src/utils/db.ts`,
`src/bindings/index.ts`, `src/bindings/generated.ts`). Field naming is
inconsistent between files (snake_case vs camelCase) because it follows the
Rust structs upstream; keep it as is.

## `engines.json`

Consumed by `useDefaultEngines` in `src/utils/engines.ts`. Because the file
is static, the app filters the array client-side and keeps only the entries
whose `os` and `bmi2` match the running machine (upstream passed
`?os=..&bmi2=..` to the server and then applied the same filter). Ship one
entry per `(engine, os, bmi2)` combination.

```jsonc
{
  "name": "Stockfish", // display name; also the install key
  "version": "17.1",
  "os": "linux", // "linux" | "macos" | "windows" (tauri plugin-os Platform)
  "bmi2": true, // true = build needs BMI2/AVX2; false = portable build
  "path": "stockfish/stockfish-ubuntu-x86-64-bmi2", // executable path relative to the engines dir, after extraction ("/" separators)
  "downloadLink": "https://.../stockfish-ubuntu-x86-64-bmi2.tar", // .zip / .tar / .tar.gz are extracted into the engines dir; anything else is saved as-is
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // optional, hex SHA-256 of the file at downloadLink (the archive itself, not its contents); see Notes
  "downloadSize": 45000000, // bytes, shown in the UI
  "elo": 3640, // optional, shown in the UI
  "image": "https://.../stockfish.png", // optional logo URL
}
```

Type: `LocalEngine` from `src/utils/engines.ts` minus the runtime fields
(`id`, `type`, `loaded`, `enabled`, `go`, `settings`, which the app fills in
on install) plus `os` and `bmi2`.

## `databases.json`

Consumed by `useDefaultDatabases` in `src/utils/db.ts`
(`SuccessDatabaseInfo[]`). The UI shows `title`, `description`,
`storage_size`, `game_count`, `player_count` and downloads `downloadLink`
into the databases dir under `<title>.db3`.

```jsonc
{
  "title": "Lichess Elite 2024",
  "description": "Rated games 2400+ from lichess.org, 2024",
  "game_count": 1200000,
  "player_count": 35000,
  "event_count": 120,
  "storage_size": 850000000, // bytes
  "downloadLink": "https://.../lichess-elite-2024.db3",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // optional, hex SHA-256 of the file at downloadLink; see Notes
  "filename": "lichess-elite-2024.db3", // informational
  "indexed": true, // whether the .db3 ships with position index tables
}
```

Type: `CatalogDatabaseInfo` from `src/utils/db.ts`, i.e. `DatabaseInfo` from
`src/bindings/generated.ts` plus `downloadLink` and the optional `sha256`
(`type` and `file` are added by the app, do not include them).

## `puzzle_databases.json`

Consumed by `getDefaultPuzzleDatabases` in `src/utils/db.ts`
(`(PuzzleDatabaseInfo & { downloadLink: string })[]`). The UI shows
`title`, `description`, `storageSize`, `puzzleCount` and downloads
`downloadLink` into the puzzles dir under `<title>.db3`.

```jsonc
{
  "title": "Lichess puzzles",
  "description": "Puzzles from the lichess.org open database",
  "puzzleCount": 3500000,
  "storageSize": 600000000, // bytes
  "path": "lichess-puzzles.db3", // informational
  "downloadLink": "https://.../lichess-puzzles.db3",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // optional, hex SHA-256 of the file at downloadLink; see Notes
}
```

Type: `CatalogPuzzleDatabaseInfo` from `src/utils/db.ts`.

## Notes

- Download URLs can point anywhere (GitHub Releases, Stockfish's own
  releases, ...). They are fetched by the Rust `download_file` command, not
  by the webview, so they are not subject to the `http` plugin scope. The
  catalog JSON itself **is** fetched through the `http` plugin, so the host
  of `CATALOG_BASE_URL` must be allowed in
  `src-tauri/capabilities/main.json` (`http:default` scope).
- `sha256` (all three files) is optional but recommended for anything not
  served from a host you control. It is the hex SHA-256 (either case) of
  the exact bytes at `downloadLink` (`sha256sum <file>`; for an archive,
  hash the archive, not the extracted binary). When set, `download_file`
  hashes the complete download before extracting or moving it into place and
  deletes it with an error on mismatch, so a bad or tampered file never
  reaches the engines/databases/puzzles dir. Remember to update it whenever
  `downloadLink` starts pointing at different bytes.
- Downloads are streamed to `<target>.part` (for archives,
  `<dir>/<archive name>.part`) and moved into place only once complete. An
  interrupted download is resumed on the next click with an HTTP `Range`
  request, so hosts that honour `Range` (GitHub Releases does) save users
  from restarting large files; hosts that answer `200` simply restart.
- Keep the files valid JSON (no comments) and keep them small; they are
  fetched on every open of the respective dialog.
