import { basename, resolve } from "@tauri-apps/api/path";
import { info } from "@tauri-apps/plugin-log";
import type { DatabaseInfo, NormalizedGame } from "@/bindings";
import { commands, events } from "@/bindings";
import { commands as chessinCommands } from "@/chessin/bindings";
import type { DatabaseConversionState } from "@/state/atoms";
import { downloadChessCom, getChessComAccount } from "@/utils/chess.com/api";
import { getDatabases, query_games } from "@/utils/db";
import { getDatabasesDir } from "@/utils/directories";
import { capitalize } from "@/utils/format";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";
import { unwrap } from "@/utils/unwrap";

/**
 * First-run importers.
 *
 * These are the non-React halves of the flows that already exist in
 * `src/components/home/Accounts.tsx` (adding an account), in
 * `src/components/home/AccountCard.tsx` ("Download games" → convert_pgn) and in
 * `src/components/databases/AddDatabase.tsx` (local PGN → .db3). Those live as
 * closures inside components, so the same function calls are repeated here with
 * the same file names / titles so the Accounts and Databases pages pick the
 * results up unchanged.
 */

export type AccountKind = "lichess" | "chesscom";

export type SetSessions = (update: (prev: Session[]) => Session[]) => void;
export type SetConversionState = (
    update: (prev: DatabaseConversionState) => DatabaseConversionState,
) => void;

export type ImportedDatabase = {
    /** Absolute path of the .db3 file. */
    dbPath: string;
    /** Title as shown on the Databases page. */
    title: string;
    /** Number of games in the database after the import, when known. */
    games: number | null;
};

export type AddedAccount = {
    kind: AccountKind;
    /** Canonical username used for file names (`<username>_lichess.db3`). */
    username: string;
    /** Total games on the site, used to size the Lichess download. */
    totalGames: number;
};

const CONVERSION_IDLE: Omit<DatabaseConversionState, "inProgress"> = {
    totalGames: 0,
    elapsedSeconds: 0,
    targetDatabasePath: null,
    targetDatabaseTitle: null,
    sourceFileName: null,
};

function resetConversionState(setConversionState: SetConversionState) {
    setConversionState((prev) => ({ ...prev, inProgress: false, ...CONVERSION_IDLE }));
}

// ---------------------------------------------------------------------------
// Accounts (same calls as Accounts.tsx `addLichessNoLogin` / `addChessCom`)
// ---------------------------------------------------------------------------

/** Looks the account up and stores it in `sessionsAtom`, like Accounts.tsx does. */
export async function addAccount(
    kind: AccountKind,
    typedUsername: string,
    setSessions: SetSessions,
): Promise<AddedAccount | null> {
    const username = typedUsername.trim();
    if (!username) return null;

    if (kind === "lichess") {
        const account = await getLichessAccount({ username });
        if (!account) return null;
        setSessions((sessions) => [
            ...sessions.filter((s) => s.lichess?.username !== username),
            { lichess: { username, account }, player: username, updatedAt: Date.now() },
        ]);
        const perfs = account.perfs;
        const totalGames =
            (perfs?.ultraBullet?.games ?? 0) +
            (perfs?.bullet?.games ?? 0) +
            (perfs?.blitz?.games ?? 0) +
            (perfs?.rapid?.games ?? 0) +
            (perfs?.classical?.games ?? 0) +
            (perfs?.correspondence?.games ?? 0);
        return { kind, username: account.username, totalGames };
    }

    const stats = await getChessComAccount(username);
    if (!stats) return null;
    setSessions((sessions) => [
        ...sessions.filter((s) => s.chessCom?.username !== username),
        { chessCom: { username, stats }, player: username, updatedAt: Date.now() },
    ]);
    let totalGames = 0;
    for (const stat of Object.values(stats)) {
        if (stat?.record) {
            totalGames += stat.record.win + stat.record.loss + stat.record.draw;
        }
    }
    return { kind, username, totalGames };
}

/** Same query AccountCard.tsx uses to resume an incremental download. */
async function getLastGameDate(dbFile: string): Promise<number | null> {
    const games = await query_games(dbFile, {
        options: { page: 1, pageSize: 1, sort: "date", direction: "desc", skipCount: false },
    });
    const first = games.data[0];
    if ((games.count ?? 0) > 0 && first?.date && first.time) {
        const [year, month, day] = first.date.split(".").map(Number);
        const [hour, minute, second] = first.time.split(":").map(Number);
        return Date.UTC(year, month - 1, day, hour, minute, second);
    }
    return null;
}

function findDatabase(databases: DatabaseInfo[], dbPath: string) {
    const db = databases.find((d) => d.file === dbPath);
    return db && db.type === "success" ? db : null;
}

/**
 * Downloads the account's games and converts them to
 * `<databases dir>/<username>_<site>.db3` titled "<username> Lichess" /
 * "<username> Chess.com" — exactly what AccountCard.tsx's download button does,
 * so the Accounts page recognises the database.
 */
export async function importAccountGames(
    account: AddedAccount,
    {
        setConversionState,
        setDownloadProgress = () => {},
        onConvertStart,
        token,
    }: {
        setConversionState: SetConversionState;
        /** Lichess only; Chess.com progress is emitted as `progress-event` by downloadChessCom. */
        setDownloadProgress?: (progress: number) => void;
        /** Called once the download finished and convert_pgn starts. */
        onConvertStart?: () => void;
        token?: string;
    },
): Promise<ImportedDatabase> {
    const { kind, username } = account;
    const dir = await getDatabasesDir();
    const pgnPath = await resolve(dir, `${username}_${kind}.pgn`);
    const dbPath = pgnPath.replace(/\.pgn$/, ".db3");
    const title = `${username} ${kind === "lichess" ? "Lichess" : "Chess.com"}`;

    const existing = findDatabase(await getDatabases(), dbPath);
    const lastGameDate = existing ? await getLastGameDate(existing.file) : null;
    const downloaded = existing?.game_count ?? 0;

    if (kind === "lichess") {
        await downloadLichess(
            username,
            lastGameDate,
            account.totalGames - downloaded,
            setDownloadProgress,
            token,
        );
    } else {
        await downloadChessCom(username, lastGameDate);
    }

    info(`first run: converting ${pgnPath} ${lastGameDate}`);
    onConvertStart?.();
    const sourceFileName = await basename(pgnPath);
    setConversionState((prev) => ({
        ...prev,
        inProgress: true,
        targetDatabasePath: dbPath,
        targetDatabaseTitle: title,
        sourceFileName,
    }));
    try {
        unwrap(
            await commands.convertPgn(
                [pgnPath],
                dbPath,
                lastGameDate ? lastGameDate / 1000 : null,
                title,
                null,
            ),
        );
        events.progressEvent.emit({ id: `${kind}_${username}`, progress: 100, finished: true });
        await commands.deleteEmptyGames(dbPath);
    } finally {
        resetConversionState(setConversionState);
    }

    const games = findDatabase(await getDatabases(), dbPath)?.game_count ?? null;
    return { dbPath, title, games };
}

// ---------------------------------------------------------------------------
// Local files (same calls as AddDatabase.tsx `convertDB`)
// ---------------------------------------------------------------------------

export type ImportFileKind = "pgn" | "cbh";

export function classifyImportFile(path: string): ImportFileKind | null {
    const lower = path.toLowerCase();
    if (lower.endsWith(".cbh")) return "cbh";
    if (/\.pgn(\.(zst|bz2))?$/.test(lower)) return "pgn";
    return null;
}

/** Title suggestion, as AddDatabase.tsx derives it from the file name. */
export function titleFromFileName(fileName: string): string {
    return capitalize(fileName.replaceAll(/[_-]/g, " ").replace(/\.(pgn(\.(zst|bz2))?|cbh)$/i, ""));
}

/** AddDatabase.tsx rejects a title that is already used; here we de-duplicate instead. */
export function uniqueDatabaseTitle(base: string, databases: DatabaseInfo[]): string {
    const used = new Set(databases.filter((d) => d.type === "success").map((d) => d.title));
    const trimmed = base.trim() || "Games";
    if (!used.has(trimmed)) return trimmed;
    for (let i = 2; ; i++) {
        const candidate = `${trimmed} (${i})`;
        if (!used.has(candidate)) return candidate;
    }
}

type CbhImportReport = {
    games: number;
    exported: number;
    skipped: number;
    annotated: number;
    unsupported: { kind: string; count: number }[];
    encoding: string;
    warnings: string[];
};

type CbhModule = {
    importCbhFile: (cbhPath: string, targetDbPath: string) => Promise<CbhImportReport>;
};

// TODO(chessin): replace with a static `import("@/chessin/import/cbh")` once
// agent D's module (`src/chessin/import/cbh.ts`, `importCbhFile(cbhPath, targetDbPath)`)
// has landed. A lazy glob is used so a missing module neither breaks `tsc`
// nor the Vite build: the record is simply empty until the file exists.
const cbhModules = import.meta.glob<CbhModule>("../import/cbh.ts");

export class CbhUnavailableError extends Error {
    constructor() {
        super("ChessBase (.cbh) import is not available in this build");
        this.name = "CbhUnavailableError";
    }
}

async function loadCbhModule(): Promise<CbhModule> {
    const loader = Object.values(cbhModules)[0];
    if (!loader) throw new CbhUnavailableError();
    try {
        const mod = await loader();
        if (typeof mod?.importCbhFile !== "function") throw new CbhUnavailableError();
        return mod;
    } catch (e) {
        if (e instanceof CbhUnavailableError) throw e;
        throw new CbhUnavailableError();
    }
}

/**
 * Imports one `.pgn` / `.pgn.zst` / `.pgn.bz2` / `.cbh` file into a new
 * database under the databases directory.
 */
export async function importLocalFile(
    path: string,
    setConversionState: SetConversionState,
): Promise<ImportedDatabase> {
    const kind = classifyImportFile(path);
    if (!kind) throw new Error(`Unsupported file: ${path}`);

    const fileName = await basename(path);
    const dir = await getDatabasesDir();
    const title = uniqueDatabaseTitle(titleFromFileName(fileName), await getDatabases());
    const dbPath = await resolve(dir, `${title}.db3`);

    // Loaded before touching the conversion state so an unavailable module
    // fails fast without a stray "in progress" banner.
    const cbh = kind === "cbh" ? await loadCbhModule() : null;

    setConversionState((prev) => ({
        ...prev,
        inProgress: true,
        targetDatabasePath: dbPath,
        targetDatabaseTitle: title,
        sourceFileName: fileName,
    }));
    try {
        if (cbh) {
            await cbh.importCbhFile(path, dbPath);
        } else {
            unwrap(await commands.convertPgn([path], dbPath, null, title, null));
        }
    } finally {
        resetConversionState(setConversionState);
    }

    const games = findDatabase(await getDatabases(), dbPath)?.game_count ?? null;
    return { dbPath, title, games };
}

// ---------------------------------------------------------------------------
// ChessBase scan ("查找本机的 ChessBase 数据库"; plugin command `scan_chessbase`)
// ---------------------------------------------------------------------------

/** One database found by `scan_chessbase` (mirrors the Rust `ChessBaseDb`). */
export type ChessBaseDb = {
    path: string;
    name: string;
    /** `cbh` (CB v1, importable) or `2cbh` (CB'26, not importable yet). */
    format: "cbh" | "2cbh" | (string & {});
    games: number | null;
    size_bytes: number;
    /** Unix timestamp of the last modification, when known. */
    modified: number | null;
};

type ScanCommand = (dirs: string[] | null) => Promise<unknown>;

/**
 * `scan_chessbase` lands with the library-store plugin work; older builds (and
 * stale bindings) simply do not have it. Looked up at call time so the import
 * above stays a plain static one.
 */
function getScanCommand(): ScanCommand | null {
    const scan = (chessinCommands as Record<string, unknown>).scanChessbase;
    return typeof scan === "function" ? (scan as ScanCommand) : null;
}

/** True when this build can look for ChessBase databases. */
export function isChessBaseScanAvailable(): boolean {
    return getScanCommand() !== null;
}

function isChessBaseDb(value: unknown): value is ChessBaseDb {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return typeof v.path === "string" && typeof v.name === "string" && typeof v.format === "string";
}

function normaliseScanResult(raw: unknown): ChessBaseDb[] {
    // tauri-specta wraps `Result<_, String>` commands as `{ status, data | error }`.
    let list = raw;
    if (raw && typeof raw === "object" && "status" in raw) {
        const result = raw as { status: string; data?: unknown; error?: unknown };
        if (result.status === "error") throw new Error(String(result.error ?? "scan failed"));
        list = result.data;
    }
    if (!Array.isArray(list)) return [];
    return list.filter(isChessBaseDb).map((db) => ({
        path: db.path,
        name: db.name,
        format: db.format.toLowerCase(),
        games: typeof db.games === "number" ? db.games : null,
        size_bytes: typeof db.size_bytes === "number" ? db.size_bytes : Number(db.size_bytes ?? 0),
        modified: typeof db.modified === "number" ? db.modified : null,
    }));
}

/**
 * Looks for ChessBase databases in the default locations (Documents/ChessBase…).
 * Never called automatically: the first-run screen only runs it on an explicit
 * click. Resolves to `null` when the command is missing from this build.
 */
export async function scanChessBaseDatabases(): Promise<ChessBaseDb[] | null> {
    const scan = getScanCommand();
    if (!scan) return null;
    const found = normaliseScanResult(await scan(null));
    return found.sort((a, b) => {
        if (a.format !== b.format) return a.format === "cbh" ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

/** Only CBH v1 databases go through `importLocalFile` → `importCbhFile`. */
export function isImportableChessBaseDb(db: ChessBaseDb): boolean {
    return db.format === "cbh" && classifyImportFile(db.path) === "cbh";
}

/** Most recent game (by date) of a database, or null when it is empty. */
export async function getNewestGame(dbPath: string): Promise<NormalizedGame | null> {
    const res = await query_games(dbPath, {
        options: { page: 1, pageSize: 1, sort: "date", direction: "desc", skipCount: true },
    });
    return res.data[0] ?? null;
}
