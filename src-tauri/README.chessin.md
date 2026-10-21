# Chessin build overlay (`tauri.chessin.conf.json`)

`tauri.conf.json` is kept byte-identical to upstream En Croissant so that
monthly `upstream/main` merges never conflict on it. Everything that makes
the build a *Chessin* build lives in `tauri.chessin.conf.json`, which the
Tauri CLI merges on top of `tauri.conf.json` as a JSON merge patch
(RFC 7396: objects are merged key by key, **arrays are replaced wholesale**,
`null` deletes a key).

## What the overlay overrides

| Key | Upstream | Chessin | Why |
|---|---|---|---|
| `productName` | `en-croissant` | `Chessin` | product name shown in installers / About; also the artifact file names |
| `identifier` | `org.encroissant.app` | `cn.chessin.app` | separate app-data dir, separate installer identity, so Chessin and En Croissant can be installed side by side |
| `plugins.deep-link.desktop.schemes` | `["encroissant"]` | `["chessin"]` | `chessin://import?url=...` links; the frontend side is `src/utils/launch.ts` |
| `plugins.updater.endpoints` | `https://www.encroissant.org/updates` | `https://github.com/MikhailXiaomaikou/Chessin/releases/latest/download/latest.json` | updates come from Chessin's own GitHub Releases and **never** from En Croissant's server (it would "update" Chessin into En Croissant) |
| `plugins.updater.pubkey` | EC's minisign key | Chessin's minisign public key (key id `DE8D26A35A871654`) | only artifacts signed with the matching private key are accepted |
| `app.windows[0].title` | `En Croissant` | `Chessin` | main window title |
| `app.security.csp` | `null` (no CSP) | strict policy, see below | security (plan section 1.1, S0) |
| `app.security.devCsp` | (unset) | same policy plus the Vite dev server | keep `pnpm dev:chessin` usable under the policy |

Notes:

- `app.windows` is an array, so the whole window entry is repeated here.
  If upstream changes the window entry in `tauri.conf.json`, mirror the
  change in the overlay.
- Not overridden on purpose (follow-ups, not blockers): `mainBinaryName`
  (`en-croissant`, tied to the Cargo package name; changes with the
  workspace restructuring), `bundle.publisher`, `bundle.shortDescription`.
  The `http:default` scope in `capabilities/main.json` already lists the
  GitHub, Lichess, Chess.com and chessdb hosts and no longer
  `www.encroissant.org`; narrowing `fs` / `assetProtocol` / `opener` there
  is still open.

## How to build

From the repository root:

```sh
# development
pnpm dev:chessin            # = pnpm tauri dev   --config src-tauri/tauri.chessin.conf.json

# release binary, no installers (mirrors upstream's `pnpm build`)
pnpm build:chessin          # = pnpm tauri build --no-bundle --config src-tauri/tauri.chessin.conf.json

# release with installers / bundles
pnpm tauri build --config src-tauri/tauri.chessin.conf.json
```

Running plain `pnpm dev` / `pnpm build` still produces an En Croissant build
(with EC's updater endpoint and public key). Do not ship that.

## Updater (GitHub Releases)

- **Key.** `plugins.updater.pubkey` is the public half of a Chessin minisign
  key pair generated with `pnpm tauri signer generate` (key id
  `DE8D26A35A871654`). The private half lives in the repository owner's hands
  and in CI as the `TAURI_SIGNING_PRIVATE_KEY` secret (plus
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). It is not in git and must never be.
  If it is lost, generate a new pair, put the new public key here and ship
  that release through a channel other than the updater (old installs cannot
  verify it).
- **Endpoint.** `.github/workflows/release.yml` builds every target with
  `--config src-tauri/tauri.chessin.conf.json`, signs with the secrets above
  (`bundle.createUpdaterArtifacts: "v1Compatible"` is inherited from upstream,
  so the `.sig` files and updater bundles are produced) and `tauri-action`
  uploads `latest.json` next to the artifacts (`includeUpdaterJson: true`).
  The workflow creates the release as a **draft**:
  `/releases/latest/download/latest.json` only resolves once the draft is
  published, and GitHub's `latest` ignores pre-releases, so publishing the
  draft is the moment an update goes live.
- The Tauri 1 `active: false` marker is gone; Tauri 2's updater has no such
  option, the switches are `endpoints` and `pubkey`.
- The frontend calls `check()` at startup (`src/App.tsx`) and from the
  "Check for updates" menu action (`src/routes/__root.tsx`); both now get a
  real answer instead of `EmptyEndpoints`.
- **Not exercised end to end yet.** Before the first public release, push a
  throwaway tag (e.g. `v0.15.1-test.1`), publish the draft, install the
  previous build and confirm it offers and applies the update (signature
  check included). Then delete the test release.
- A CN mirror for updates and catalogs is a later step; nothing here assumes
  one.

## Content Security Policy

Upstream ships `"csp": null`, i.e. no policy at all. The overlay sets
`app.security.csp` to:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' asset: http://asset.localhost data: blob: https:;
media-src 'self' asset: http://asset.localhost blob: http://127.0.0.1:*;
font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*;
frame-src 'none';
object-src 'none';
base-uri 'self'
```

What each source is for (from grepping the frontend on 2026-10-21):

- `script-src 'self'`: all JS is bundled by Vite; Tauri appends nonces /
  hashes for the scripts it injects itself. No WebAssembly and no Web
  Workers were found, so there is no `'wasm-unsafe-eval'` and no
  `worker-src`; add them back the day a worker or a WASM module lands.
- `style-src 'unsafe-inline'`: Mantine writes its CSS variables into a
  `<style>` element and uses inline `style` attributes everywhere.
- `img-src`: boards are files under `/board` (`'self'`); piece sets are
  base64 `data:` URIs inside `public/pieces/*.css`; the board snapshot
  (`dom-to-image-more` in `src/components/boards/BoardControls.tsx`) goes
  through `blob:` / `data:` images; engine logos from the catalog and FIDE
  player photos are plain `https:` URLs; `src/components/common/LocalImage.tsx`
  shows local files through the asset protocol (`asset:` on macOS/Linux,
  `http://asset.localhost` on Windows).
- `media-src`: move sounds are played through the asset protocol on
  macOS/Windows and, on Linux, through the local axum server in
  `src-tauri/src/sound.rs` (`http://127.0.0.1:<random port>`).
- `connect-src`: every HTTP request (Lichess, Chess.com, chessdb.cn, the
  GitHub catalogs) goes through `@tauri-apps/plugin-http`, i.e. over IPC
  (`ipc:` / `http://ipc.localhost`); nothing in the webview uses a native
  `fetch` or a WebSocket. If a native `fetch` is ever added, add `https:`
  here. `http://127.0.0.1:*` is there for the Linux sound server in case a
  future code path fetches instead of streaming.
- `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`: nothing embeds
  frames or plugins.

`devCsp` is the same policy plus the Vite dev server (`http://localhost:1420`,
HMR over `ws://localhost:1420` / `ws://localhost:1421`) and `'unsafe-inline'`
in `script-src` for the React Refresh preamble that `@vitejs/plugin-react`
injects in dev.

**This policy has NOT been verified at runtime yet.** Nobody has run a
Chessin build with it. On the first run, open the webview devtools (debug
build) and watch for `Refused to load ...` / `Refused to connect ...`
messages while exercising: board and pieces (2D and 3D), board snapshot /
copy image, move sounds on all three OSes, a local engine logo, a catalog
engine logo, a FIDE profile photo, Lichess and Chess.com game import, engine
and database download, the updater check. If something is blocked and the
directive cannot be fixed on the spot, disable the policy with

```json
"security": { "csp": null, "devCsp": null }
```

in `tauri.chessin.conf.json` (that restores upstream behaviour) and open an
issue with the console message.
