import { appDataDir, dataDir } from "@tauri-apps/api/path";
import { copyFile, exists, mkdir, readDir, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { warn } from "@tauri-apps/plugin-log";
import { getDefaultStore } from "jotai";
import { hasTauri, setKv } from "@/chessin/store/libraryStore";
import { enginesAtom } from "@/state/atoms";
import { getDatabasesDir, getEnginesDir, getPuzzlesDir } from "@/utils/directories";
import { type Engine, engineSchema } from "@/utils/engines";

/**
 * "从 En Croissant 迁移" — copies an existing En Croissant installation's
 * engines, databases and puzzle files into Chessin.
 *
 * Chessin's app identifier is `cn.chessin.app`, En Croissant's is
 * `org.encroissant.app`, so both keep their data under
 * `<dataDir>/<identifier>/` (`dataDir()` is the parent of `appDataDir()`).
 * Everything here is copy-only: En Croissant's files are read, never written,
 * moved or deleted. Its `engines/engines.json` is not copied as a file either;
 * its entries are merged into `enginesAtom` with the binary paths rewritten to
 * Chessin's engines directory (see `mergeEngines`).
 *
 * The pure helpers (`rewriteEnginePath`, `mergeEngines`, `joinPath`,
 * `samePath`) are exported for tests; the fs plugin is only touched by
 * `detectEnCroissant` / `migrateEnCroissant`.
 */

export const EC_APP_IDENTIFIER = "org.encroissant.app";
/** kv key (library store) holding the ISO date of the last completed migration. */
export const MIGRATE_DONE_KEY = "migrate.ec.done";
/** EC subfolder names, same as Chessin's `directories.ts` defaults. */
const EC_DB_DIR = "db";
const EC_ENGINES_DIR = "engines";
const EC_PUZZLES_DIR = "puzzles";
const ENGINES_JSON = "engines.json";
/** How long to wait for `enginesAtom` to finish loading its file before giving up. */
const ENGINES_LOAD_TIMEOUT_MS = 10_000;

export type EcCategory = {
    /** Number of items (engine entries / .db3 files). */
    count: number;
    /** Total size on disk. */
    bytes: number;
};

export type EcInstall = {
    /** `<dataDir>/org.encroissant.app` */
    dataDir: string;
    engines: EcCategory;
    databases: EcCategory;
    puzzles: EcCategory;
    /** Set when `engines/engines.json` exists. */
    enginesJsonPath?: string;
};

export type MigrationProgress = {
    /** Path of the file being copied, relative to its EC folder (`/`-separated); "" when finished. */
    file: string;
    done: number;
    total: number;
};

export type MigrationOptions = {
    engines: boolean;
    databases: boolean;
    puzzles: boolean;
    onProgress?: (p: MigrationProgress) => void;
};

export type MigrationFailure = { path: string; error: string };

export type MigrationReport = {
    copied: number;
    /** Files already present in Chessin's folder with the same size. */
    skipped: number;
    failed: MigrationFailure[];
    /** Engine entries added to `enginesAtom` from EC's engines.json. */
    enginesAdded: number;
};

// ---------------------------------------------------------------------------
// Pure path helpers

function separatorOf(path: string): "\\" | "/" {
    return path.includes("\\") ? "\\" : "/";
}

function normalizeSeparators(path: string): string {
    return path.replaceAll("\\", "/");
}

/** Removes trailing `/` or `\` (keeps a lone root separator). */
export function stripTrailingSeparators(path: string): string {
    let end = path.length;
    while (end > 1 && (path[end - 1] === "/" || path[end - 1] === "\\")) end--;
    return path.slice(0, end);
}

/** String-level join using the separator style of `dir` (no IPC round trip). */
export function joinPath(dir: string, ...parts: string[]): string {
    const sep = separatorOf(dir);
    let out = stripTrailingSeparators(dir);
    for (const part of parts) out += sep + part;
    return out;
}

/** Parent directory of `path`, or null for a bare name / root. */
export function parentOf(path: string): string | null {
    const trimmed = stripTrailingSeparators(path);
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (index <= 0) return null;
    return trimmed.slice(0, index);
}

/** True when both strings name the same path, ignoring separator style and trailing separators. */
export function samePath(a: string, b: string): boolean {
    return (
        normalizeSeparators(stripTrailingSeparators(a)) ===
        normalizeSeparators(stripTrailingSeparators(b))
    );
}

/** True when `path` is `dir` itself or lies below it. */
export function isInsideDir(path: string, dir: string): boolean {
    const p = normalizeSeparators(stripTrailingSeparators(path));
    const d = normalizeSeparators(stripTrailingSeparators(dir));
    return p === d || p.startsWith(`${d}/`);
}

/**
 * Moves an engine binary path from EC's engines directory to Chessin's.
 * Paths outside `fromDir` (an engine the user installed elsewhere) are
 * returned unchanged; the part below `fromDir` keeps its separators.
 */
export function rewriteEnginePath(path: string, fromDir: string, toDir: string): string {
    const from = stripTrailingSeparators(fromDir);
    if (!isInsideDir(path, from)) return path;
    const remainder = path.slice(from.length);
    return stripTrailingSeparators(toDir) + remainder;
}

// ---------------------------------------------------------------------------
// engines.json merge (pure)

export type MergeEnginesResult = {
    /** `current` followed by the entries that were added. */
    engines: Engine[];
    added: Engine[];
    /** Entries already present (same binary path, or same remote url). */
    skipped: number;
    /** Entries that did not match the engine schema. */
    invalid: number;
};

/**
 * Merges the parsed contents of EC's `engines.json` (`incoming`) into the
 * current engine list. Local engines get their `path` rewritten from EC's
 * engines dir to Chessin's; an entry whose (rewritten) path is already in the
 * list is skipped; remote engines (chessdb / lichess) are de-duplicated by
 * url. `settings`, `go` and the other fields are kept; a colliding `id` gets
 * a fresh uuid. `current` is not mutated.
 */
export function mergeEngines(
    current: Engine[],
    incoming: unknown,
    fromDir: string,
    toDir: string,
): MergeEnginesResult {
    const engines = current.slice();
    const added: Engine[] = [];
    let skipped = 0;
    let invalid = 0;
    if (!Array.isArray(incoming)) return { engines, added, skipped, invalid };

    const ids = new Set(engines.map((e) => e.id));
    const hasLocal = (path: string) =>
        engines.some((e) => e.type === "local" && samePath(e.path, path));
    const hasRemote = (type: string, url: string) =>
        engines.some((e) => e.type !== "local" && e.type === type && e.url === url);

    for (const raw of incoming) {
        const parsed = engineSchema.safeParse(raw);
        if (!parsed.success) {
            invalid++;
            continue;
        }
        const engine = parsed.data;
        let next: Engine;
        if (engine.type === "local") {
            const path = rewriteEnginePath(engine.path, fromDir, toDir);
            if (hasLocal(path)) {
                skipped++;
                continue;
            }
            next = { ...engine, path };
        } else {
            if (hasRemote(engine.type, engine.url)) {
                skipped++;
                continue;
            }
            next = { ...engine };
        }
        if (ids.has(next.id)) next = { ...next, id: crypto.randomUUID() };
        ids.add(next.id);
        engines.push(next);
        added.push(next);
    }
    return { engines, added, skipped, invalid };
}

/** Number of local engine entries in a parsed engines.json, or null when unreadable. */
export function countLocalEngines(incoming: unknown): number | null {
    if (!Array.isArray(incoming)) return null;
    return incoming.filter((e) => engineSchema.safeParse(e).success && e?.type === "local").length;
}

// ---------------------------------------------------------------------------
// fs helpers (tolerant: a folder that cannot be read counts as empty)

type FoundFile = {
    /** Path relative to the listed folder, `/`-separated. */
    rel: string;
    path: string;
    size: number;
};

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === "string" ? e : String(e);
}

async function safeExists(path: string): Promise<boolean> {
    try {
        return await exists(path);
    } catch {
        return false;
    }
}

async function statOrNull(path: string) {
    try {
        return await stat(path);
    } catch {
        return null;
    }
}

/** `*.db3` files directly inside `dir`. */
async function listDb3(dir: string): Promise<FoundFile[]> {
    if (!(await safeExists(dir))) return [];
    let entries;
    try {
        entries = await readDir(dir);
    } catch (e) {
        warn(`migrate: cannot read ${dir}: ${errorMessage(e)}`);
        return [];
    }
    const out: FoundFile[] = [];
    for (const entry of entries) {
        if (!entry.name.toLowerCase().endsWith(".db3")) continue;
        const path = joinPath(dir, entry.name);
        const info = await statOrNull(path);
        if (!info || !info.isFile) continue;
        out.push({ rel: entry.name, path, size: info.size });
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Every file below `dir`, recursively (symlinks are followed via `stat`). */
async function walk(
    dir: string,
    skip: (rel: string) => boolean = () => false,
    rel = "",
): Promise<FoundFile[]> {
    if (rel === "" && !(await safeExists(dir))) return [];
    let entries;
    try {
        entries = await readDir(dir);
    } catch (e) {
        warn(`migrate: cannot read ${dir}: ${errorMessage(e)}`);
        return [];
    }
    const out: FoundFile[] = [];
    for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (skip(entryRel)) continue;
        const path = joinPath(dir, entry.name);
        if (entry.isDirectory) {
            out.push(...(await walk(path, skip, entryRel)));
            continue;
        }
        const info = await statOrNull(path);
        if (!info) continue;
        if (info.isDirectory) {
            out.push(...(await walk(path, skip, entryRel)));
        } else if (info.isFile) {
            out.push({ rel: entryRel, path, size: info.size });
        }
    }
    return out;
}

function sumBytes(files: FoundFile[]): number {
    return files.reduce((total, f) => total + f.size, 0);
}

async function readEnginesJson(path: string): Promise<unknown> {
    return JSON.parse(await readTextFile(path)) as unknown;
}

// ---------------------------------------------------------------------------
// Detection

/** `<dataDir>/org.encroissant.app`, or null outside Tauri. */
export async function enCroissantDataDir(): Promise<string | null> {
    if (!hasTauri()) return null;
    try {
        return joinPath(await dataDir(), EC_APP_IDENTIFIER);
    } catch (e) {
        warn(`migrate: dataDir() failed: ${errorMessage(e)}`);
        return null;
    }
}

/** True when at least one category has something to copy. */
export function hasMigratableData(install: EcInstall): boolean {
    return install.engines.count > 0 || install.databases.count > 0 || install.puzzles.count > 0;
}

/**
 * Looks for an En Croissant data directory and sizes its contents. Resolves
 * to null outside Tauri, when the directory does not exist, or when it is
 * this very app's data directory (a dev build running under EC's identifier).
 */
export async function detectEnCroissant(): Promise<EcInstall | null> {
    const ecDir = await enCroissantDataDir();
    if (!ecDir || !(await safeExists(ecDir))) return null;
    try {
        if (samePath(await appDataDir(), ecDir)) return null;
    } catch {
        return null;
    }

    const enginesDir = joinPath(ecDir, EC_ENGINES_DIR);
    const [databases, puzzles, engineFiles] = await Promise.all([
        listDb3(joinPath(ecDir, EC_DB_DIR)),
        listDb3(joinPath(ecDir, EC_PUZZLES_DIR)),
        walk(enginesDir),
    ]);

    const enginesJson = engineFiles.find((f) => f.rel === ENGINES_JSON);
    const enginesJsonPath = enginesJson ? joinPath(enginesDir, ENGINES_JSON) : undefined;
    let engineCount: number | null = null;
    if (enginesJsonPath) {
        try {
            engineCount = countLocalEngines(await readEnginesJson(enginesJsonPath));
        } catch (e) {
            warn(`migrate: cannot read ${enginesJsonPath}: ${errorMessage(e)}`);
        }
    }
    if (engineCount === null) {
        // No readable engines.json: count the top-level entries of engines/ instead.
        const topLevel = new Set(
            engineFiles.filter((f) => f.rel !== ENGINES_JSON).map((f) => f.rel.split("/")[0]),
        );
        engineCount = topLevel.size;
    }

    return {
        dataDir: ecDir,
        engines: { count: engineCount, bytes: sumBytes(engineFiles) },
        databases: { count: databases.length, bytes: sumBytes(databases) },
        puzzles: { count: puzzles.length, bytes: sumBytes(puzzles) },
        ...(enginesJsonPath ? { enginesJsonPath } : {}),
    };
}

// ---------------------------------------------------------------------------
// Migration

type CopyItem = { from: string; to: string; rel: string; size: number };

type JotaiStore = ReturnType<typeof getDefaultStore>;

/**
 * Current value of `enginesAtom`. Subscribing mounts the atom, which makes
 * `atomWithStorage` load `engines/engines.json` when nothing else has; the
 * unwrapped atom reads as `undefined` until that load settles.
 */
function readEngines(store: JotaiStore): Promise<Engine[]> {
    return new Promise<Engine[]>((resolve, reject) => {
        let settled = false;
        let unsub: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (engines: Engine[] | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            unsub?.();
            if (engines === null) reject(new Error("engine list did not load"));
            else resolve(engines);
        };
        const check = () => {
            const value = store.get(enginesAtom);
            if (value !== undefined) finish(value);
        };
        unsub = store.sub(enginesAtom, check);
        timer = setTimeout(() => finish(null), ENGINES_LOAD_TIMEOUT_MS);
        check();
    });
}

async function mergeEnginesJson(jsonPath: string, fromDir: string, toDir: string): Promise<number> {
    if (!(await safeExists(jsonPath))) return 0;
    const incoming = await readEnginesJson(jsonPath);
    const store = getDefaultStore();
    const current = await readEngines(store);
    const result = mergeEngines(current, incoming, fromDir, toDir);
    if (result.invalid > 0) {
        warn(`migrate: ${result.invalid} entries of ${jsonPath} did not match the engine schema`);
    }
    if (result.added.length > 0) store.set(enginesAtom, result.engines);
    return result.added.length;
}

async function ensureParentDir(path: string, created: Set<string>): Promise<void> {
    const parent = parentOf(path);
    if (!parent || created.has(parent)) return;
    if (!(await safeExists(parent))) {
        await mkdir(parent, { recursive: true });
    }
    created.add(parent);
}

/**
 * Copies the selected categories from En Croissant into Chessin's folders
 * (`getDatabasesDir()` / `getEnginesDir()` / `getPuzzlesDir()`): `db/*.db3`,
 * everything below `engines/` (recursively, except engines.json) and
 * `puzzles/*.db3`. A target file that already exists with the same size is
 * skipped; a failed copy is recorded and the run continues. With `engines`,
 * EC's engines.json entries are merged into `enginesAtom` afterwards. Finally
 * `migrate.ec.done` is written to the library store. EC's files are never
 * modified.
 */
export async function migrateEnCroissant(opts: MigrationOptions): Promise<MigrationReport> {
    const ecDir = await enCroissantDataDir();
    if (!ecDir || !(await safeExists(ecDir))) {
        throw new Error("En Croissant data directory not found");
    }
    const report: MigrationReport = { copied: 0, skipped: 0, failed: [], enginesAdded: 0 };
    const items: CopyItem[] = [];
    const ecEnginesDir = joinPath(ecDir, EC_ENGINES_DIR);

    if (opts.databases) {
        const target = await getDatabasesDir();
        for (const f of await listDb3(joinPath(ecDir, EC_DB_DIR))) {
            items.push({ from: f.path, to: joinPath(target, f.rel), rel: f.rel, size: f.size });
        }
    }
    if (opts.puzzles) {
        const target = await getPuzzlesDir();
        for (const f of await listDb3(joinPath(ecDir, EC_PUZZLES_DIR))) {
            items.push({ from: f.path, to: joinPath(target, f.rel), rel: f.rel, size: f.size });
        }
    }
    let enginesTarget: string | null = null;
    if (opts.engines) {
        enginesTarget = await getEnginesDir();
        // engines.json is merged into the atom below, never copied over Chessin's own.
        for (const f of await walk(ecEnginesDir, (rel) => rel === ENGINES_JSON)) {
            items.push({
                from: f.path,
                to: joinPath(enginesTarget, ...f.rel.split("/")),
                rel: f.rel,
                size: f.size,
            });
        }
    }

    const total = items.length;
    const created = new Set<string>();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        opts.onProgress?.({ file: item.rel, done: i, total });
        try {
            // Chessin configured to use EC's folder: nothing to copy, and copying a file
            // onto itself would truncate it.
            if (samePath(item.from, item.to)) {
                report.skipped++;
                continue;
            }
            const existing = await statOrNull(item.to);
            if (existing?.isFile && existing.size === item.size) {
                report.skipped++;
                continue;
            }
            await ensureParentDir(item.to, created);
            await copyFile(item.from, item.to);
            report.copied++;
        } catch (e) {
            warn(`migrate: copy of ${item.from} failed: ${errorMessage(e)}`);
            report.failed.push({ path: item.from, error: errorMessage(e) });
        }
    }
    opts.onProgress?.({ file: "", done: total, total });

    if (enginesTarget) {
        const jsonPath = joinPath(ecEnginesDir, ENGINES_JSON);
        try {
            report.enginesAdded = await mergeEnginesJson(jsonPath, ecEnginesDir, enginesTarget);
        } catch (e) {
            warn(`migrate: merging ${jsonPath} failed: ${errorMessage(e)}`);
            report.failed.push({ path: jsonPath, error: errorMessage(e) });
        }
    }

    try {
        await setKv(MIGRATE_DONE_KEY, new Date().toISOString());
    } catch (e) {
        warn(`migrate: could not record ${MIGRATE_DONE_KEY}: ${errorMessage(e)}`);
    }
    return report;
}
