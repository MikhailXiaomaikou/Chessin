import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";
import { atom, getDefaultStore, useAtomValue } from "jotai";
import { atomFamily } from "jotai/utils";
import { useEffect } from "react";
import { commands } from "@/chessin/bindings";
import {
    enqueueJob,
    getJobs,
    isActiveStatus,
    type Job,
    type JobContext,
    registerJobHandler,
} from "@/chessin/jobs/queue";
import { titleFromPath } from "@/chessin/sources/sources";
import { hasTauri, unwrapResult } from "@/chessin/store/libraryStore";
import type { NormalizedGame } from "@/bindings";
import { type IndexGameRow, MAX_INDEX_PLY, toNormalizedGame } from "./mapping";
import type {
    IndexFilter,
    IndexPositionResult,
    IndexProgressPayload,
    IndexState,
    IndexStats,
} from "./types";

/**
 * Position index (S3-2 side of S3-1's `chessin-index`).
 *
 * - Typed, `typeof`-guarded wrappers over the plugin commands. Until S3-1
 *   lands in `src/chessin/bindings.ts` (and in vitest / the browser dev server)
 *   `isIndexAvailable()` is false, every query falls back to
 *   `search_position`, and the explorer chip is hidden.
 * - `ensureIndex(dbPath)` builds the sidecar through a `kind: "index"` job
 *   (deduped per database); the handler forwards the plugin's
 *   `chessin://index-progress` events to the job's progress.
 * - `indexStateAtomFamily(dbPath)` tells the UI whether the index is
 *   `none | building | ready` (`unknown` before the first status check).
 *
 * Importing this module registers the job handler (DatabasePanel, the
 * drawer and `ChessinMounts` import it, so it is loaded with the board bundle).
 */

export type {
    IndexFilter,
    IndexGameRef,
    IndexMoveStats,
    IndexPositionResult,
    IndexProgressPayload,
    IndexState,
    IndexStats,
} from "./types";
export { MAX_INDEX_PLY };

export const INDEX_JOB_KIND = "index";
export const INDEX_PROGRESS_EVENT = "chessin://index-progress";

// Error messages thrown below are translation keys; the chip / drawer show
// them through `t(message, { defaultValue })`. Listed for the extractor:
// t("Explorer.Index.BadPayload") t("Explorer.Index.BadResult") t("Explorer.Index.Unavailable")

export type IndexJobPayload = { dbPath: string };

// ---------------------------------------------------------------------------
// Native commands (typeof-guarded, like `jobs/queue.ts` and `review/evalCache.ts`)

type NativeIndexCommands = {
    indexBuild?: (dbPath: string, maxPly: number | null) => Promise<unknown>;
    indexStatus?: (dbPath: string) => Promise<unknown>;
    indexDelete?: (dbPath: string) => Promise<unknown>;
    indexPosition?: (
        dbPath: string,
        fen: string,
        filter: IndexFilter,
        limit: number,
    ) => Promise<unknown>;
    indexPawnCandidates?: (dbPath: string, fen: string, limit: number) => Promise<unknown>;
    indexGames?: (dbPath: string, ids: number[]) => Promise<unknown>;
};

/** `index_games` takes at most this many ids per call. */
export const INDEX_GAMES_BATCH = 500;

const NATIVE_COMMANDS = [
    "indexBuild",
    "indexStatus",
    "indexDelete",
    "indexPosition",
    "indexPawnCandidates",
] as const;

function native(): NativeIndexCommands {
    return commands as unknown as NativeIndexCommands;
}

/** True when every `index_*` query/build command exists on the generated bindings. */
export function hasIndexCommands(): boolean {
    const table = commands as unknown as Record<string, unknown>;
    return NATIVE_COMMANDS.every((name) => typeof table[name] === "function");
}

/** True when `index_games` (games by id, no sidecar needed) exists on the bindings. */
export function hasIndexGamesCommand(): boolean {
    return typeof native().indexGames === "function";
}

function normalizeGames(raw: unknown): NormalizedGame[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((g): g is IndexGameRow => !!g && typeof g === "object" && "id" in g)
        .map((g) => toNormalizedGame({ ...g, id: toNumber(g.id) }));
}

function toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function field(record: Record<string, unknown>, snake: string, camel: string): unknown {
    return snake in record ? record[snake] : record[camel];
}

function normalizeStats(raw: unknown): IndexStats | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
        games: toNumber(r.games),
        postings: toNumber(r.postings),
        bytes: toNumber(r.bytes),
        max_game_id: toNumber(field(r, "max_game_id", "maxGameId")),
        built_at: toNumber(field(r, "built_at", "builtAt")),
    };
}

function normalizePosition(raw: unknown): IndexPositionResult {
    const empty: IndexPositionResult = { ply: 0, moves: [], games: [], total: 0 };
    if (!raw || typeof raw !== "object") return empty;
    const r = raw as Record<string, unknown>;
    const moves = Array.isArray(r.moves) ? r.moves : [];
    const games = Array.isArray(r.games) ? r.games : [];
    return {
        ply: toNumber(r.ply),
        total: toNumber(r.total),
        moves: moves
            .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
            .map((m) => ({
                uci: String(m.uci ?? ""),
                san: String(m.san ?? ""),
                white: toNumber(m.white),
                draw: toNumber(m.draw),
                black: toNumber(m.black),
                games: toNumber(m.games),
                avg_elo: toNumber(field(m, "avg_elo", "avgElo")),
                last_year: toNumber(field(m, "last_year", "lastYear")),
            })),
        games: games
            .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
            .map((g) => ({ id: toNumber(g.id), ply: toNumber(g.ply) })),
    };
}

/** Everything the module needs from outside; swapped in tests. */
export type IndexDeps = {
    available(): boolean;
    status(dbPath: string): Promise<IndexStats | null>;
    build(dbPath: string, maxPly: number): Promise<IndexStats>;
    remove(dbPath: string): Promise<void>;
    position(
        dbPath: string,
        fen: string,
        filter: IndexFilter,
        limit: number,
    ): Promise<IndexPositionResult>;
    pawnCandidates(dbPath: string, fen: string, limit: number): Promise<number[]>;
    listenProgress(handler: (payload: IndexProgressPayload) => void): Promise<() => void>;
    /** `index_games` exists (independent of `available()`: it reads the `.db3`, not the sidecar). */
    gamesAvailable(): boolean;
    /** At most `INDEX_GAMES_BATCH` ids; requested order, missing ids skipped. */
    games(dbPath: string, ids: number[]): Promise<NormalizedGame[]>;
};

const nativeDeps: IndexDeps = {
    available: () => hasTauri() && hasIndexCommands(),
    async status(dbPath) {
        return normalizeStats(unwrapResult<unknown>(await native().indexStatus!(dbPath)));
    },
    async build(dbPath, maxPly) {
        const stats = normalizeStats(
            unwrapResult<unknown>(await native().indexBuild!(dbPath, maxPly)),
        );
        if (!stats) throw new Error("Explorer.Index.BadResult");
        return stats;
    },
    async remove(dbPath) {
        unwrapResult<unknown>(await native().indexDelete!(dbPath));
    },
    async position(dbPath, fen, filter, limit) {
        return normalizePosition(
            unwrapResult<unknown>(await native().indexPosition!(dbPath, fen, filter, limit)),
        );
    },
    async pawnCandidates(dbPath, fen, limit) {
        const raw = unwrapResult<unknown>(await native().indexPawnCandidates!(dbPath, fen, limit));
        return Array.isArray(raw) ? raw.map(toNumber) : [];
    },
    async listenProgress(handler) {
        if (!hasTauri()) return () => {};
        try {
            return await listen<IndexProgressPayload>(INDEX_PROGRESS_EVENT, (event) =>
                handler(event.payload),
            );
        } catch (e) {
            console.warn("[chessin] cannot listen to index progress", e);
            return () => {};
        }
    },
    gamesAvailable: () => hasTauri() && hasIndexGamesCommand(),
    async games(dbPath, ids) {
        return normalizeGames(unwrapResult<unknown>(await native().indexGames!(dbPath, ids)));
    },
};

let deps: IndexDeps = nativeDeps;

/** Test hook: replaces the native commands (null restores them). */
export function __setIndexDepsForTests(next: IndexDeps | null): void {
    deps = next ?? nativeDeps;
}

/** True inside Tauri when the index commands exist. */
export function isIndexAvailable(): boolean {
    return deps.available();
}

// ---------------------------------------------------------------------------
// Wrappers

export async function indexStatus(dbPath: string): Promise<IndexStats | null> {
    if (!deps.available()) return null;
    return deps.status(dbPath);
}

export async function indexBuild(dbPath: string, maxPly = MAX_INDEX_PLY): Promise<IndexStats> {
    if (!deps.available()) throw new Error("Explorer.Index.Unavailable");
    return deps.build(dbPath, maxPly);
}

export async function indexDelete(dbPath: string): Promise<void> {
    if (!deps.available()) return;
    await deps.remove(dbPath);
    getDefaultStore().set(indexStateAtomFamily(dbPath), "none");
}

export async function indexPosition(
    dbPath: string,
    fen: string,
    filter: IndexFilter = {},
    limit = 50,
): Promise<IndexPositionResult> {
    if (!deps.available()) throw new Error("Explorer.Index.Unavailable");
    return deps.position(dbPath, fen, filter, limit);
}

export async function indexPawnCandidates(
    dbPath: string,
    fen: string,
    limit = 500,
): Promise<number[]> {
    if (!deps.available()) throw new Error("Explorer.Index.Unavailable");
    return deps.pawnCandidates(dbPath, fen, limit);
}

/** True inside Tauri when `index_games` exists (`getGamesByIds` then uses it). */
export function isIndexGamesAvailable(): boolean {
    return deps.gamesAvailable();
}

/**
 * Games by id through `index_games` (batched by `INDEX_GAMES_BATCH`), in the
 * requested order with missing ids skipped. Throws when the command is
 * missing; `getGamesByIds` in `src/utils/db.ts` is the caller with the
 * OFFSET-based fallback.
 */
export async function indexGames(dbPath: string, ids: number[]): Promise<NormalizedGame[]> {
    if (!deps.gamesAvailable()) throw new Error("Explorer.Index.Unavailable");
    const unique = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    const out: NormalizedGame[] = [];
    for (let i = 0; i < unique.length; i += INDEX_GAMES_BATCH) {
        out.push(...(await deps.games(dbPath, unique.slice(i, i + INDEX_GAMES_BATCH))));
    }
    return out;
}

// ---------------------------------------------------------------------------
// State

export const indexStateAtomFamily = atomFamily((_dbPath: string) => atom<IndexState>("unknown"));

/** Build progress 0..1 of the database's index job (0 when none is running). */
export const indexProgressAtomFamily = atomFamily((_dbPath: string) => atom<number>(0));

export function isIndexJobPayload(value: unknown): value is IndexJobPayload {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as Partial<IndexJobPayload>).dbPath === "string"
    );
}

/** The queued / running index job of `dbPath`, if any. */
export function findActiveIndexJob(jobs: readonly Job[], dbPath: string): Job | null {
    return (
        jobs.find(
            (job) =>
                job.kind === INDEX_JOB_KIND &&
                isActiveStatus(job.status) &&
                isIndexJobPayload(job.payload) &&
                job.payload.dbPath === dbPath,
        ) ?? null
    );
}

export function getIndexState(dbPath: string): IndexState {
    return getDefaultStore().get(indexStateAtomFamily(dbPath));
}

/**
 * Asks the plugin whether `dbPath` has an index and updates the atom. A
 * database whose build job is still queued or running stays `building`.
 */
export async function refreshIndexState(dbPath: string): Promise<IndexState> {
    const store = getDefaultStore();
    const stateAtom = indexStateAtomFamily(dbPath);
    if (!deps.available()) {
        store.set(stateAtom, "none");
        return "none";
    }
    let stats: IndexStats | null = null;
    try {
        stats = await deps.status(dbPath);
    } catch (e) {
        console.warn("index_status failed", e);
    }
    let next: IndexState;
    if (stats) next = "ready";
    else if (findActiveIndexJob(getJobs(), dbPath)) next = "building";
    else next = "none";
    store.set(stateAtom, next);
    return next;
}

function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

/**
 * Makes sure `dbPath` has an index: returns `ready` when it already exists,
 * otherwise queues the build job (one per database, see `dedupeKey`) and
 * returns `building` with that job. `none` means the commands are missing.
 */
export async function ensureIndex(dbPath: string): Promise<{ state: IndexState; job: Job | null }> {
    const store = getDefaultStore();
    const stateAtom = indexStateAtomFamily(dbPath);
    if (!deps.available()) {
        store.set(stateAtom, "none");
        return { state: "none", job: null };
    }
    let stats: IndexStats | null = null;
    try {
        stats = await deps.status(dbPath);
    } catch (e) {
        console.warn("index_status failed", e);
    }
    if (stats) {
        store.set(stateAtom, "ready");
        return { state: "ready", job: null };
    }
    // t("Explorer.Index.JobTitle") — spelled out for the extractor (removeUnusedKeys).
    const job = await enqueueJob({
        kind: INDEX_JOB_KIND,
        title: tr("Explorer.Index.JobTitle", { name: titleFromPath(dbPath) }),
        payload: { dbPath } satisfies IndexJobPayload,
        dedupeKey: `index:${dbPath}`,
    });
    store.set(stateAtom, "building");
    if (job.status === "queued") store.set(indexProgressAtomFamily(dbPath), 0);
    return { state: "building", job };
}

/** Deletes the sidecar and queues a fresh build. */
export async function rebuildIndex(
    dbPath: string,
): Promise<{ state: IndexState; job: Job | null }> {
    await indexDelete(dbPath);
    return ensureIndex(dbPath);
}

// ---------------------------------------------------------------------------
// Job handler

function normalizeProgress(payload: IndexProgressPayload): number {
    if (payload.finished) return 1;
    const value = Number.isFinite(payload.progress) ? payload.progress : 0;
    const unit = value > 1 ? value / 100 : value;
    return Math.min(1, Math.max(0, unit));
}

/**
 * `kind: "index"` jobs: builds the sidecar and mirrors the plugin's progress
 * events into the job. There is no cancel command in v0: cancelling the job
 * only hides it; the build finishes on its own and the index becomes `ready`.
 */
export async function runIndexJob(job: Job, ctx: JobContext): Promise<IndexStats> {
    if (!isIndexJobPayload(job.payload)) throw new Error("Explorer.Index.BadPayload");
    const { dbPath } = job.payload;
    if (!deps.available()) throw new Error("Explorer.Index.Unavailable");
    const store = getDefaultStore();
    const stateAtom = indexStateAtomFamily(dbPath);
    const progressAtom = indexProgressAtomFamily(dbPath);
    store.set(stateAtom, "building");
    store.set(progressAtom, 0);
    const unlisten = await deps.listenProgress((payload) => {
        if (payload.db_path !== dbPath) return;
        const progress = normalizeProgress(payload);
        ctx.setProgress(progress);
        store.set(progressAtom, progress);
    });
    try {
        const stats = await deps.build(dbPath, MAX_INDEX_PLY);
        store.set(stateAtom, "ready");
        store.set(progressAtom, 1);
        return stats;
    } catch (e) {
        store.set(stateAtom, "none");
        store.set(progressAtom, 0);
        throw e;
    } finally {
        unlisten();
    }
}

let registered = false;

export function registerIndexJobHandler(): void {
    if (registered) return;
    registered = true;
    registerJobHandler(INDEX_JOB_KIND, runIndexJob);
}

registerIndexJobHandler();

// ---------------------------------------------------------------------------
// React

/** The index state and build progress of a database (refreshed on mount / path change). */
export function useIndexState(dbPath: string | null): { state: IndexState; progress: number } {
    const key = dbPath ?? "";
    const state = useAtomValue(indexStateAtomFamily(key));
    const progress = useAtomValue(indexProgressAtomFamily(key));
    useEffect(() => {
        if (dbPath) void refreshIndexState(dbPath);
    }, [dbPath]);
    return { state: dbPath ? state : "none", progress };
}
