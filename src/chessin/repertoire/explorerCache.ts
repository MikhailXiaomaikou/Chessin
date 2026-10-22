import { getDefaultStore } from "jotai";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { getKv, setKv } from "@/chessin/store/libraryStore";
import { getLichessGames, getMasterGames } from "@/utils/lichess/api";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";
import { lichessRatingsFor, lichessSpeedsFor, type RepertoireMeta, toEpd } from "./model";

/**
 * Explorer statistics for the repertoire check, cached in the library `kv`
 * table for 7 days under `rep.explorer.<epd>.<ratings>.<speeds>` (or
 * `rep.explorer.<epd>.masters`). Requests go through the serial Lichess queue
 * one at a time; in offline mode only the cache is consulted (stale entries
 * included) and nothing touches the network.
 */

export type ExplorerMove = {
    uci: string;
    san: string;
    white: number;
    draws: number;
    black: number;
    averageRating?: number;
};

export type ExplorerStats = {
    white: number;
    draws: number;
    black: number;
    moves: ExplorerMove[];
};

export type ExplorerQuery =
    | { kind: "lichess"; ratings: LichessRating[]; speeds: LichessGameSpeed[] }
    | { kind: "masters" };

export const EXPLORER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPLORER_CACHE_PREFIX = "rep.explorer.";
/** Queue lane of the check's explorer requests (never the board tab's lane). */
export const EXPLORER_LANE = "repertoire-check";
/** Moves the explorer returns per position (its default is 12). */
export const EXPLORER_MOVES = 12;

export function explorerQueryFor(meta: RepertoireMeta): ExplorerQuery {
    if (meta.ratingSource === "fide") return { kind: "masters" };
    return {
        kind: "lichess",
        ratings: lichessRatingsFor(meta.eloRange),
        speeds: lichessSpeedsFor(meta.timeControl),
    };
}

export function explorerCacheKey(fenOrEpd: string, query: ExplorerQuery): string {
    const epd = toEpd(fenOrEpd);
    if (query.kind === "masters") return `${EXPLORER_CACHE_PREFIX}${epd}.masters`;
    return `${EXPLORER_CACHE_PREFIX}${epd}.${query.ratings.join("-")}.${query.speeds.join("-")}`;
}

export function movesTotal(move: Pick<ExplorerMove, "white" | "draws" | "black">): number {
    return move.white + move.draws + move.black;
}

/** Games that continued from the position (the sum over the listed moves). */
export function continuingGames(stats: ExplorerStats): number {
    return stats.moves.reduce((acc, m) => acc + movesTotal(m), 0);
}

function num(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Accepts the explorer's JSON (`white/draws/black/moves[]`); null when unusable. */
export function normalizeExplorerStats(raw: unknown): ExplorerStats | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.moves)) return null;
    const moves: ExplorerMove[] = [];
    for (const item of r.moves) {
        if (!item || typeof item !== "object") continue;
        const m = item as Record<string, unknown>;
        if (typeof m.san !== "string" || typeof m.uci !== "string") continue;
        const move: ExplorerMove = {
            uci: m.uci,
            san: m.san,
            white: num(m.white),
            draws: num(m.draws),
            black: num(m.black),
        };
        if (typeof m.averageRating === "number") move.averageRating = m.averageRating;
        moves.push(move);
    }
    return { white: num(r.white), draws: num(r.draws), black: num(r.black), moves };
}

type CacheEntry = { at: number; stats: ExplorerStats };

function parseEntry(raw: string | null): CacheEntry | null {
    if (!raw) return null;
    try {
        const json = JSON.parse(raw) as { at?: unknown; stats?: unknown };
        const stats = normalizeExplorerStats(json.stats);
        if (!stats || typeof json.at !== "number") return null;
        return { at: json.at, stats };
    } catch {
        return null;
    }
}

export type ExplorerLookup = {
    stats: ExplorerStats | null;
    /** Served from the kv cache (fresh or, when offline, stale). */
    fromCache: boolean;
    /** Nothing fetched because offline mode is on. */
    offline: boolean;
};

export type ExplorerCacheDeps = {
    getKv: (key: string) => Promise<string | null>;
    setKv: (key: string, value: string) => Promise<void>;
    now: () => number;
    isOffline: () => boolean;
    fetchLichess: (
        fen: string,
        ratings: LichessRating[],
        speeds: LichessGameSpeed[],
    ) => Promise<unknown>;
    fetchMasters: (fen: string) => Promise<unknown>;
};

export type ExplorerCache = {
    lookup(fen: string, query: ExplorerQuery): Promise<ExplorerLookup>;
    /** Forgets the in-memory copies (the kv rows stay). */
    clearMemory(): void;
};

export function createExplorerCache(
    deps: ExplorerCacheDeps,
    ttlMs: number = EXPLORER_CACHE_TTL_MS,
): ExplorerCache {
    const memory = new Map<string, CacheEntry>();
    // Lookups are chained so concurrent callers still produce one request at a time.
    let chain: Promise<unknown> = Promise.resolve();

    async function read(key: string): Promise<CacheEntry | null> {
        const inMemory = memory.get(key);
        if (inMemory) return inMemory;
        let entry: CacheEntry | null = null;
        try {
            entry = parseEntry(await deps.getKv(key));
        } catch {
            entry = null;
        }
        if (entry) memory.set(key, entry);
        return entry;
    }

    async function write(key: string, entry: CacheEntry): Promise<void> {
        memory.set(key, entry);
        try {
            await deps.setKv(key, JSON.stringify(entry));
        } catch {
            // best effort: the in-memory copy still serves this session
        }
    }

    async function fetchFresh(fen: string, query: ExplorerQuery): Promise<ExplorerStats | null> {
        const raw =
            query.kind === "masters"
                ? await deps.fetchMasters(fen)
                : await deps.fetchLichess(fen, query.ratings, query.speeds);
        return normalizeExplorerStats(raw);
    }

    async function lookupNow(fen: string, query: ExplorerQuery): Promise<ExplorerLookup> {
        const key = explorerCacheKey(fen, query);
        const cached = await read(key);
        const now = deps.now();
        if (cached && now - cached.at < ttlMs) {
            return { stats: cached.stats, fromCache: true, offline: false };
        }
        if (deps.isOffline()) {
            return { stats: cached?.stats ?? null, fromCache: cached !== null, offline: true };
        }
        const fresh = await fetchFresh(fen, query);
        if (fresh === null) {
            // The API helpers return null when offline mode switched on meanwhile.
            return { stats: cached?.stats ?? null, fromCache: cached !== null, offline: true };
        }
        await write(key, { at: now, stats: fresh });
        return { stats: fresh, fromCache: false, offline: false };
    }

    return {
        lookup(fen, query) {
            const task = chain.then(() => lookupNow(fen, query));
            chain = task.catch(() => undefined);
            return task;
        },
        clearMemory() {
            memory.clear();
        },
    };
}

function isOfflineNow(): boolean {
    try {
        if (getDefaultStore().get(offlineModeAtom)) return true;
        return localStorage.getItem("chessin.offline") === "true";
    } catch {
        return false;
    }
}

export const defaultExplorerCacheDeps: ExplorerCacheDeps = {
    getKv,
    setKv,
    now: () => Date.now(),
    isOffline: isOfflineNow,
    fetchLichess: (fen, ratings, speeds) =>
        getLichessGames(
            fen,
            {
                color: "white",
                ratings,
                speeds,
                moves: EXPLORER_MOVES,
                topGames: 0,
                recentGames: 0,
            },
            undefined,
            EXPLORER_LANE,
        ),
    fetchMasters: (fen) =>
        getMasterGames(fen, { moves: EXPLORER_MOVES, topGames: 0 }, undefined, EXPLORER_LANE),
};

let shared: ExplorerCache | null = null;

/** The app-wide cache over the library kv store and the Lichess queue. */
export function getExplorerCache(): ExplorerCache {
    if (!shared) shared = createExplorerCache(defaultExplorerCacheDeps);
    return shared;
}

/** Test hook: replaces the shared cache (null restores the default). */
export function __setExplorerCacheForTests(cache: ExplorerCache | null): void {
    shared = cache;
}
