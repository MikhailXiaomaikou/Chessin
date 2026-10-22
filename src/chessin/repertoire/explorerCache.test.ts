import { describe, expect, it } from "vitest";
import {
    createExplorerCache,
    EXPLORER_CACHE_TTL_MS,
    type ExplorerCacheDeps,
    type ExplorerQuery,
    explorerCacheKey,
    explorerQueryFor,
    normalizeExplorerStats,
} from "./explorerCache";
import { defaultMeta } from "./model";

const FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const QUERY: ExplorerQuery = { kind: "lichess", ratings: [1600, 1800], speeds: ["rapid"] };
const RAW = {
    white: 1,
    draws: 1,
    black: 1,
    moves: [{ san: "e5", uci: "e7e5", white: 1, draws: 1, black: 1 }],
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function fakeDeps() {
    const kv = new Map<string, string>();
    const state = { now: 1_000_000, offline: false, fetches: 0, inFlight: 0, maxInFlight: 0 };
    const pending: (() => void)[] = [];
    const deps: ExplorerCacheDeps = {
        getKv: async (k) => kv.get(k) ?? null,
        setKv: async (k, v) => {
            kv.set(k, v);
        },
        now: () => state.now,
        isOffline: () => state.offline,
        fetchLichess: async () => {
            state.fetches++;
            state.inFlight++;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            const d = deferred<void>();
            pending.push(d.resolve);
            await d.promise;
            state.inFlight--;
            return RAW;
        },
        fetchMasters: async () => RAW,
    };
    return { deps, kv, state, release: () => pending.shift()?.() };
}

async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("explorer cache", () => {
    it("builds kv keys from the EPD and the query", () => {
        expect(explorerCacheKey(FEN, QUERY)).toBe(
            "rep.explorer.rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -.1600-1800.rapid",
        );
        expect(explorerCacheKey(FEN, { kind: "masters" })).toBe(
            "rep.explorer.rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -.masters",
        );
        const meta = defaultMeta({ color: "white", startFen: FEN });
        expect(explorerQueryFor(meta)).toEqual({
            kind: "lichess",
            ratings: [1600],
            speeds: ["rapid"],
        });
        expect(explorerQueryFor({ ...meta, ratingSource: "fide" })).toEqual({ kind: "masters" });
    });

    it("serves repeats from the cache for 7 days, then refetches", async () => {
        const f = fakeDeps();
        const cache = createExplorerCache(f.deps);
        const first = cache.lookup(FEN, QUERY);
        await flush();
        f.release();
        expect(await first).toMatchObject({ fromCache: false, offline: false });
        expect(f.kv.size).toBe(1);

        f.state.now += EXPLORER_CACHE_TTL_MS - 1;
        expect(await cache.lookup(FEN, QUERY)).toMatchObject({ fromCache: true });
        expect(f.state.fetches).toBe(1);

        // A fresh cache instance reads the kv row rather than refetching.
        const again = createExplorerCache(f.deps);
        expect(await again.lookup(FEN, QUERY)).toMatchObject({ fromCache: true });

        f.state.now += 2;
        const refetch = cache.lookup(FEN, QUERY);
        await flush();
        f.release();
        expect(await refetch).toMatchObject({ fromCache: false });
        expect(f.state.fetches).toBe(2);
    });

    it("never fetches while offline: stale rows are served, otherwise null", async () => {
        const f = fakeDeps();
        const cache = createExplorerCache(f.deps);
        f.state.offline = true;
        expect(await cache.lookup(FEN, QUERY)).toEqual({
            stats: null,
            fromCache: false,
            offline: true,
        });
        expect(f.state.fetches).toBe(0);

        f.state.offline = false;
        const fetched = cache.lookup(FEN, QUERY);
        await flush();
        f.release();
        await fetched;
        f.state.now += EXPLORER_CACHE_TTL_MS * 3;
        f.state.offline = true;
        const stale = await cache.lookup(FEN, QUERY);
        expect(stale.offline).toBe(true);
        expect(stale.fromCache).toBe(true);
        expect(stale.stats?.moves[0].san).toBe("e5");
        expect(f.state.fetches).toBe(1);
    });

    it("runs concurrent lookups one request at a time", async () => {
        const f = fakeDeps();
        const cache = createExplorerCache(f.deps);
        const a = cache.lookup(FEN, QUERY);
        const b = cache.lookup("8/8/8/8/8/8/8/K6k w - - 0 1", QUERY);
        await flush();
        expect(f.state.inFlight).toBe(1);
        f.release();
        await a;
        await flush();
        f.release();
        await b;
        expect(f.state.maxInFlight).toBe(1);
        expect(f.state.fetches).toBe(2);
    });

    it("normalises explorer JSON and drops unusable rows", () => {
        expect(normalizeExplorerStats(null)).toBeNull();
        expect(normalizeExplorerStats({ white: 1 })).toBeNull();
        expect(
            normalizeExplorerStats({
                white: "3",
                draws: -1,
                black: 2,
                moves: [
                    { san: "e5", uci: "e7e5", white: 1, draws: 1, black: 1, averageRating: 1700 },
                    { san: 5, uci: "x" },
                    null,
                ],
            }),
        ).toEqual({
            white: 3,
            draws: 0,
            black: 2,
            moves: [{ san: "e5", uci: "e7e5", white: 1, draws: 1, black: 1, averageRating: 1700 }],
        });
    });
});
