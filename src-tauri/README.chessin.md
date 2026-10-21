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
| `productName` | `en-croissant` | `Chessin` | product name shown in installers / About |
| `identifier` | `org.encroissant.app` | `cn.chessin.app` | separate app-data dir, separate installer identity, so Chessin and En Croissant can be installed side by side |
| `plugins.deep-link.desktop.schemes` | `["encroissant"]` | `["chessin"]` | `chessin://import?url=...` links; the frontend side is `src/utils/launch.ts` |
| `plugins.updater.endpoints` | `https://www.encroissant.org/updates` | `[]` | **never** ask En Croissant's server for updates (it would "update" Chessin into En Croissant) |
| `plugins.updater.pubkey` | EC's minisign key | `""` | no Chessin signing key exists yet, see TODO below |
| `plugins.updater.active` | (unset) | `false` | informational only, see note |
| `app.windows[0].title` | `En Croissant` | `Chessin` | main window title |

Notes:

- The updater plugin is still compiled in and initialised (`main.rs`), but
  with an empty `endpoints` list `tauri_plugin_updater` returns
  `Error::EmptyEndpoints` from `check()` before any network request is made,
  so the app cannot reach `encroissant.org`. The frontend's startup check in
  `src/App.tsx` swallows that error; the manual "Check for updates" menu
  action in `src/routes/__root.tsx` does not, so expect an error there until
  the updater is re-enabled.
- `pubkey` cannot be removed (`null`), because the plugin's config requires
  the field and the app would fail at startup. An empty string deserialises
  fine and can never verify a signature.
- `active: false` is not a Tauri 2 updater option (it was in Tauri 1); the
  plugin ignores it. It is kept as a visible marker of intent. The real
  switch is the empty `endpoints`.
- `app.windows` is an array, so the whole window entry is repeated here.
  If upstream changes the window entry in `tauri.conf.json`, mirror the
  change in the overlay.
- Not overridden on purpose (follow-ups, not blockers): `mainBinaryName`
  (`en-croissant`, tied to the Cargo package name; changes with the
  workspace restructuring), `bundle.publisher`, `bundle.shortDescription`,
  `app.security.csp` (`null` upstream; the plan wants a real CSP), and the
  `http:default` scope in `capabilities/main.json` which still allows
  `www.encroissant.org` and does **not** yet allow
  `raw.githubusercontent.com` (needed for the catalog fetches in
  `src/utils/engines.ts` and `src/utils/db.ts`).

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

## TODO: re-enable the updater against GitHub Releases

1. Generate a Chessin minisign key pair (keep the private key out of git,
   put it in CI as a secret):

   ```sh
   pnpm tauri signer generate -w ~/.tauri/chessin.key
   ```

2. Put the printed public key into `plugins.updater.pubkey` in
   `tauri.chessin.conf.json`, set `plugins.updater.endpoints` to the
   GitHub Releases manifest (the `release.yml` workflow has to publish a
   `latest.json` next to the signed artifacts), e.g.

   ```
   https://github.com/MikhailXiaomaikou/Chessin/releases/latest/download/latest.json
   ```

   and drop the `active: false` marker.

3. Build with `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   set so the `.sig` files are produced (`bundle.createUpdaterArtifacts` is
   already on upstream).

4. Add the GitHub hosts to the `http:default` scope in
   `capabilities/main.json` (the updater plugin uses its own HTTP client,
   but the catalogs are fetched through the `http` plugin and need the scope).

A CN mirror for updates and catalogs is a later step; nothing here assumes
one.
