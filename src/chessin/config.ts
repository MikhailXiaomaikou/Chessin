/**
 * Chessin-specific URLs.
 *
 * Everything that used to point at encroissant.org lives here, so the fork
 * never talks to En Croissant's servers. Hosting is GitHub for now; a CN
 * mirror can be plugged in later via `VITE_CHESSIN_CATALOG_BASE_URL`.
 */

export const CHESSIN_REPO_URL = "https://github.com/MikhailXiaomaikou/Chessin";

const DEFAULT_CATALOG_BASE_URL =
    "https://raw.githubusercontent.com/MikhailXiaomaikou/Chessin/main/catalog";

/**
 * Base URL of the static catalog files (`engines.json`, `databases.json`,
 * `puzzle_databases.json`). See `catalog/README.md` for the entry shapes.
 */
export const CATALOG_BASE_URL: string = (
    (import.meta.env.VITE_CHESSIN_CATALOG_BASE_URL as string | undefined) ??
    DEFAULT_CATALOG_BASE_URL
).replace(/\/+$/, "");

export const DOCS_URL = `${CHESSIN_REPO_URL}/tree/main/docs`;

export const ISSUES_URL = `${CHESSIN_REPO_URL}/issues/new?assignees=&labels=bug&projects=&template=bug.yml`;
