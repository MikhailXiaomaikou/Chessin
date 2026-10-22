import { INITIAL_FEN } from "chessops/fen";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveAnalysis } from "@/bindings";
import { commands as chessinCommands } from "@/chessin/bindings";
import { __resetJobsForTests, getJob, hasJobHandler } from "@/chessin/jobs/queue";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    listDocs,
    putDoc,
} from "@/chessin/store/libraryStore";
import { createTreeStore } from "@/state/store/tree";
import type { LocalEngine } from "@/utils/engines";
import { defaultTree, type TreeState } from "@/utils/treeReducer";
import { clearReviewListeners, onReviewSaved } from "./events";
import {
    enqueueReview,
    findDatabaseGame,
    loadGameFromOrigin,
    mainLinePositions,
    ReviewError,
    reviewGame,
} from "./reviewGame";
import { getReview, listReviews } from "./store";

const mocks = vi.hoisted(() => ({
    analyzeGame: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    cancelAnalysis: vi.fn<(id: string) => Promise<{ status: string; data: null }>>(async () => ({
        status: "ok",
        data: null,
    })),
    readGames: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    lexPgn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    queryGames: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    progressListener: null as
        | null
        | ((e: { payload: { id: string; progress: number; finished: boolean } }) => void),
}));

vi.mock("@/bindings", () => ({
    commands: {
        analyzeGame: (...args: unknown[]) => mocks.analyzeGame(...args),
        cancelAnalysis: (id: string) => mocks.cancelAnalysis(id),
        readGames: (...args: unknown[]) => mocks.readGames(...args),
        lexPgn: (...args: unknown[]) => mocks.lexPgn(...args),
    },
    events: {
        progressEvent: {
            listen: async (cb: typeof mocks.progressListener) => {
                mocks.progressListener = cb;
                return () => {
                    mocks.progressListener = null;
                };
            },
        },
    },
}));

vi.mock("@/utils/db", () => ({
    query_games: (...args: unknown[]) => mocks.queryGames(...args),
}));

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const SANS = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];
const UCIS = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

function tree(): TreeState {
    const store = createTreeStore();
    store.getState().setState(defaultTree());
    store.getState().makeMoves({ payload: SANS });
    const state = store.getState();
    return { ...state, headers: { ...state.headers, white: "Alice", black: "Bob", result: "1-0" } };
}

function line(
    uci: string,
    cp: number | { mate: number },
    depth = 8,
    san?: string,
): MoveAnalysis["best"][number] {
    return {
        depth,
        score: {
            value:
                typeof cp === "number"
                    ? { type: "cp", value: cp }
                    : { type: "mate", value: cp.mate },
            wdl: null,
        },
        uciMoves: [uci],
        sanMoves: san ? [san] : [],
        multipv: 1,
        nodes: 0,
        nps: 0,
    };
}

function a(best: MoveAnalysis["best"]): MoveAnalysis {
    return { best, novelty: false, is_sacrifice: false };
}

/** One entry per non-terminal position (the mate is skipped, like `analyze_game`). */
const EVALS: MoveAnalysis[] = [
    a([line("e2e4", 30), line("d2d4", 28)]),
    a([line("e7e5", 30), line("c7c5", 25)]),
    a([line("g1f3", 35), line("d8h5", 10)]),
    a([line("g8f6", 10), line("b8c6", 150)]),
    a([line("f1c4", 150), line("b1c3", 140)]),
    a([line("g7g6", 20), line("d8e7", 40)]),
    a([line("h5f7", { mate: 1 }, 8, "Qxf7#"), line("c4f7", 300)]),
];

const engine = {
    type: "local",
    id: "engine-1",
    name: "Test Engine",
    version: "1.0",
    path: "/bin/test-engine",
    settings: [{ name: "Threads", value: 2 }],
} as unknown as LocalEngine;

const KEY = "database:/tmp/games.db3#1";

beforeEach(() => {
    __setLibraryBackendForTests(null);
    __resetJobsForTests();
    clearReviewListeners();
    mocks.analyzeGame.mockReset();
    mocks.cancelAnalysis.mockClear();
    mocks.queryGames.mockReset();
    mocks.progressListener = null;
    mocks.analyzeGame.mockImplementation(async (id) => {
        mocks.progressListener?.({ payload: { id: String(id), progress: 50, finished: false } });
        return { status: "ok", data: EVALS };
    });
});

describe("mainLinePositions", () => {
    it("walks the main line with standard UCI", () => {
        const positions = mainLinePositions(tree());
        expect(positions).toHaveLength(8);
        expect(positions[0]).toMatchObject({ fen: INITIAL_FEN, san: null, uci: null });
        expect(positions.slice(1).map((p) => p.uci)).toEqual(UCIS);
        expect(positions.slice(1).map((p) => p.san)).toEqual(SANS);
        expect(positions.every((p) => typeof p.nodeId === "string")).toBe(true);
    });
});

describe("reviewGame", () => {
    it("runs the engine over the main line, stores the review and reports progress", async () => {
        const progress: number[] = [];
        const saved: string[] = [];
        onReviewSaved((r) => saved.push(r.gameKey));

        const review = await reviewGame({
            tree: tree(),
            gameKey: KEY,
            preset: "full",
            playerColor: "black",
            engine,
            depth: 8,
            onProgress: (p) => progress.push(p),
        });

        expect(mocks.analyzeGame).toHaveBeenCalledTimes(1);
        const [id, path, goMode, options, uciOptions] = mocks.analyzeGame.mock.calls[0] as [
            string,
            string,
            unknown,
            { moves: string[] },
            unknown,
        ];
        expect(id).toMatch(/^review_/);
        expect(path).toBe("/bin/test-engine");
        expect(goMode).toEqual({ t: "Depth", c: 8 });
        expect(options).toMatchObject({
            fen: INITIAL_FEN,
            annotateNovelties: false,
            referenceDb: null,
            reversed: true,
        });
        expect(options.moves).toHaveLength(7);
        expect(uciOptions).toEqual([{ name: "Threads", value: "2" }]);
        expect(progress).toEqual([0.5]);

        expect(review).toMatchObject({
            version: 1,
            gameKey: KEY,
            engine: "Test Engine 1.0",
            depth: 8,
            playerColor: "black",
            preset: "full",
            headers: { white: "Alice", black: "Bob", result: "1-0" },
        });
        expect(review.plies).toHaveLength(7);
        expect(review.moments.map((m) => m.ply)).toEqual([6, 4]);
        expect(Array.isArray(review.moments[0].explanations)).toBe(true);

        expect(saved).toEqual([KEY]);
        expect(await getReview(KEY)).toEqual(JSON.parse(JSON.stringify(review)));
        const list = await listReviews();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ gameKey: KEY, title: "Alice – Bob 1-0" });
    });

    it("a blunder check replaces the stored full review", async () => {
        await reviewGame({
            tree: tree(),
            gameKey: KEY,
            preset: "full",
            playerColor: "black",
            engine,
            depth: 8,
        });
        const check = await reviewGame({
            tree: tree(),
            gameKey: KEY,
            preset: "blunder_check",
            playerColor: "black",
            engine,
            depth: 6,
        });
        expect(check.moments.map((m) => m.ply)).toEqual([6]);
        expect(mocks.analyzeGame.mock.calls[1][2]).toEqual({ t: "Depth", c: 6 });
        expect(await listDocs("review")).toHaveLength(1);
        expect((await getReview(KEY))?.preset).toBe("blunder_check");
    });

    it("maps engine failures and cancellation to ReviewError", async () => {
        mocks.analyzeGame.mockResolvedValueOnce({ status: "error", error: "no engine" });
        await expect(
            reviewGame({ tree: tree(), gameKey: KEY, preset: "full", engine, depth: 8 }),
        ).rejects.toMatchObject({ name: "ReviewError", key: "Review.EngineFailed" });

        const controller = new AbortController();
        controller.abort();
        await expect(
            reviewGame({
                tree: tree(),
                gameKey: KEY,
                preset: "full",
                engine,
                depth: 8,
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ key: "Review.Cancelled" });
        expect(await getReview(KEY)).toBeNull();

        const aborting = new AbortController();
        mocks.analyzeGame.mockImplementationOnce(async () => {
            aborting.abort();
            return { status: "error", error: "cancelled" };
        });
        await expect(
            reviewGame({
                tree: tree(),
                gameKey: KEY,
                preset: "full",
                engine,
                depth: 8,
                signal: aborting.signal,
            }),
        ).rejects.toMatchObject({ key: "Review.Cancelled" });
        expect(mocks.cancelAnalysis).toHaveBeenCalledWith(expect.stringMatching(/^review_/));
    });

    it("rejects games without moves", async () => {
        const empty = defaultTree();
        await expect(
            reviewGame({ tree: empty, gameKey: KEY, preset: "full", engine }),
        ).rejects.toBeInstanceOf(ReviewError);
    });

    it("skips the engine when every position is cached at the requested depth", async () => {
        const table = chessinCommands as unknown as Record<string, unknown>;
        const w = window as unknown as Record<string, unknown>;
        w.__TAURI_INTERNALS__ = {};
        // "Inside Tauri" for the eval cache only; documents stay in memory.
        __setLibraryBackendForTests(createMemoryBackend());
        const cached = mainLinePositions(tree())
            .slice(0, 7)
            .map((p, i) => {
                const best = EVALS[i].best[0];
                const value = best.score.value;
                return {
                    epd: p.fen.split(" ").slice(0, 4).join(" "),
                    engine: "Test Engine 1.0",
                    depth: 12,
                    score_type: value.type,
                    score_value: value.value,
                    best_uci: best.uciMoves[0],
                    pv: best.uciMoves.join(" "),
                };
            });
        const evalCacheGet = vi.fn<() => Promise<typeof cached>>(async () => cached);
        const evalCachePut = vi.fn<(entries: unknown[]) => Promise<null>>(async () => null);
        table.evalCacheGet = evalCacheGet;
        table.evalCachePut = evalCachePut;
        try {
            const review = await reviewGame({
                tree: tree(),
                gameKey: KEY,
                preset: "full",
                playerColor: "black",
                engine,
                depth: 8,
            });
            expect(mocks.analyzeGame).not.toHaveBeenCalled();
            expect(evalCacheGet).toHaveBeenCalledWith(expect.any(Array), "Test Engine 1.0", 8);
            expect(evalCachePut).not.toHaveBeenCalled();
            expect(review.moments.map((m) => m.ply)).toEqual([6, 4]);
            expect(review.moments.every((m) => m.alternatives.length === 0)).toBe(true);
            expect(review.plies[5].depth).toBe(12);

            evalCacheGet.mockResolvedValueOnce([]);
            await reviewGame({ tree: tree(), gameKey: KEY, preset: "full", engine, depth: 8 });
            expect(mocks.analyzeGame).toHaveBeenCalledTimes(1);
            expect(evalCachePut).toHaveBeenCalledTimes(1);
            const entries = evalCachePut.mock.calls[0][0] as unknown as {
                epd: string;
                depth: number;
            }[];
            expect(entries).toHaveLength(7);
            expect(entries[6]).toMatchObject({
                depth: 8,
                best_uci: "h5f7",
                score_type: "mate",
                score_value: 1,
            });
        } finally {
            delete table.evalCacheGet;
            delete table.evalCachePut;
            delete w.__TAURI_INTERNALS__;
        }
    });
});

describe("enqueueReview", () => {
    it("queues one deduplicated review job per game and registers the handler", async () => {
        const origin = { kind: "database" as const, database: "/tmp/games.db3", gameId: 1 };
        const first = await enqueueReview(origin, {
            playerColor: "black",
            preset: "full",
            title: "Alice – Bob",
        });
        expect(first.gameKey).toBe(KEY);
        expect(hasJobHandler("review")).toBe(true);
        const job = getJob(first.id);
        expect(job).toMatchObject({
            kind: "review",
            status: "queued",
            dedupeKey: `review:${KEY}`,
            payload: { gameKey: KEY, source: origin, playerColor: "black", preset: "full" },
        });
        const second = await enqueueReview(origin, { preset: "blunder_check" });
        expect(second.id).toBe(first.id);
        await expect(enqueueReview({ kind: "none" })).rejects.toMatchObject({
            key: "Review.NoOrigin",
        });
    });
});

describe("loadGameFromOrigin", () => {
    it("finds database games by scanning pages newest first", async () => {
        const page = (ids: number[]) => ({
            data: ids.map((id) => ({
                id,
                moves: "1. e4",
                fen: INITIAL_FEN,
                white: "A",
                black: "B",
                result: "*",
            })),
            count: null,
        });
        mocks.queryGames.mockResolvedValueOnce(page([5, 4])).mockResolvedValueOnce(page([3]));
        const game = await findDatabaseGame("/db.db3", 3, 2, 10);
        expect(game?.id).toBe(3);
        expect(mocks.queryGames).toHaveBeenCalledTimes(2);
        expect(mocks.queryGames.mock.calls[0][1]).toMatchObject({
            options: { page: 1, pageSize: 2, sort: "id", direction: "desc" },
        });
        mocks.queryGames.mockResolvedValueOnce(page([9]));
        expect(await findDatabaseGame("/db.db3", 1, 2, 10)).toBeNull();
    });

    it("loads library documents and rejects scratch tabs", async () => {
        const state = tree();
        await putDoc({
            id: "doc-1",
            kind: "game",
            title: "Alice – Bob",
            data: JSON.stringify({ version: 0, state }),
        });
        const loaded = await loadGameFromOrigin({ kind: "library", docId: "doc-1" });
        expect(loaded.title).toBe("Alice – Bob");
        expect(mainLinePositions(loaded.tree)).toHaveLength(8);
        await expect(
            loadGameFromOrigin({ kind: "library", docId: "missing" }),
        ).rejects.toMatchObject({
            key: "Review.NoGame",
        });
        await expect(loadGameFromOrigin({ kind: "none" })).rejects.toMatchObject({
            key: "Review.NoOrigin",
        });
    });
});
