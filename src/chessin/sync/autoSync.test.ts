import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import type { EnqueueJobInput, Job } from "@/chessin/jobs/queue";
import { firstRunDoneAtom } from "@/chessin/onboarding/firstRunState";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { workspaceReadyAtom } from "@/chessin/store/workspace";
import { sessionsAtom, storedDatabasesDirAtom } from "@/state/atoms";
import type { Session } from "@/utils/session";
import {
    __resetAutoSyncForTests,
    autoSyncAtom,
    enqueueReviewsFor,
    listGamesAfterId,
    maxGameId,
    type ReviewBridge,
    runAccountSync,
    scheduleStartupSync,
    SYNC_DEDUPE_KEY,
    type SyncReason,
    syncAccounts,
    syncAccountsFromSessions,
} from "./autoSync";
import type { downloadAccountGames } from "./downloadAccount";
import type { QueryGames } from "./myGames";

type Download = typeof downloadAccountGames;
type EnqueueReview = ReviewBridge["enqueueReview"];
type HasReview = NonNullable<ReviewBridge["hasReview"]>;
type StartupSync = (opts: {
    reason: SyncReason;
    store: ReturnType<typeof createStore>;
}) => Promise<null>;

function game(partial: Partial<NormalizedGame> & { id: number }): NormalizedGame {
    return {
        fen: "",
        event: "",
        event_id: 0,
        site: "",
        site_id: 0,
        white: "Alice",
        white_id: 0,
        black: "Bob",
        black_id: 0,
        result: "1-0",
        moves: "1. e4",
        date: "2026.10.20",
        time: "12:00:00",
        ...partial,
    };
}

const lichessSession: Session = {
    lichess: {
        username: "Alice",
        accessToken: "tok",
        account: {
            username: "Alice",
            perfs: { blitz: { games: 40 }, rapid: { games: 2 } },
        } as never,
    },
    updatedAt: 1,
};

const downloaded = {
    pgnPath: "/db/Alice_lichess.pgn",
    dbPath: "/db/Alice_lichess.db3",
    converted: true,
};

/** A fake database whose rows the "download" step appends to. */
function fakeDb(initial: NormalizedGame[]) {
    const rows = [...initial];
    const queryGames = vi.fn<QueryGames>(async (_db, query) => {
        const o = query.options!;
        const sorted = [...rows].sort((a, b) =>
            o.direction === "desc" ? b.id - a.id : a.id - b.id,
        );
        const page = o.page ?? 1;
        const size = o.pageSize ?? sorted.length;
        return { count: rows.length, data: sorted.slice((page - 1) * size, page * size) };
    });
    return { rows, queryGames };
}

function storeWith(sessions: Session[]) {
    const store = createStore();
    store.set(storedDatabasesDirAtom, "/db");
    store.set(sessionsAtom, sessions);
    store.set(firstRunDoneAtom, true);
    return store;
}

beforeEach(() => {
    // `offlineModeAtom` is an atomWithStorage: setting it on any store writes localStorage.
    localStorage.clear();
    __resetAutoSyncForTests();
});

afterEach(() => {
    __resetAutoSyncForTests();
    localStorage.clear();
    vi.useRealTimers();
});

describe("syncAccountsFromSessions", () => {
    it("maps sessions to accounts with the site's total game count", () => {
        const accounts = syncAccountsFromSessions([
            lichessSession,
            {
                chessCom: {
                    username: "bob",
                    stats: {
                        chess_blitz: {
                            last: { rating: 1, date: 1, rd: 1 },
                            record: { win: 3, loss: 2, draw: 1 },
                        },
                    },
                },
                updatedAt: 2,
            },
        ]);
        expect(accounts).toEqual([
            { type: "lichess", username: "Alice", total: 42, token: "tok" },
            { type: "chesscom", username: "bob", total: 6, token: undefined },
        ]);
    });
});

describe("delta detection", () => {
    it("finds the highest id and the games above the previous maximum, paging", async () => {
        const { queryGames } = fakeDb(Array.from({ length: 7 }, (_, i) => game({ id: i + 1 })));
        expect(await maxGameId("/db/x.db3", queryGames)).toBe(7);
        const fresh = await listGamesAfterId("/db/x.db3", 4, queryGames, 2);
        expect(fresh.map((g) => g.id)).toEqual([7, 6, 5]);
        expect(await listGamesAfterId("/db/x.db3", null, queryGames, 3)).toHaveLength(7);
        expect(await listGamesAfterId("/db/x.db3", 7, queryGames)).toEqual([]);
    });

    it("treats an unreadable database as empty", async () => {
        const failing: QueryGames = async () => {
            throw new Error("missing");
        };
        expect(await maxGameId("/db/none.db3", failing)).toBeNull();
    });
});

describe("runAccountSync", () => {
    it("downloads the delta, reviews only the new games of the user and notifies", async () => {
        const store = storeWith([lichessSession]);
        const { rows, queryGames } = fakeDb([
            game({ id: 1, date: "2026.10.18", time: "09:00:00" }),
            game({ id: 2, date: "2026.10.19", time: "09:00:00" }),
        ]);
        const download = vi.fn<Download>(async () => {
            rows.push(
                game({ id: 3, date: "2026.10.20", time: "09:00:00", white: "Zed", black: "alice" }),
                game({ id: 4, date: "2026.10.21", time: "09:00:00" }),
            );
            return downloaded;
        });
        const enqueueReview = vi.fn<EnqueueReview>(async () => undefined);
        const notify = vi.fn<(n: number) => void>();
        const refresh = vi.fn<(store: ReturnType<typeof createStore>) => void>();
        const progress: number[] = [];

        const result = await runAccountSync(
            { reason: "startup", ctx: { setProgress: (p) => progress.push(p), offline: false } },
            {
                store,
                queryGames,
                download,
                gameCount: async () => 2,
                loadReview: async () => ({ enqueueReview }),
                notify,
                refresh,
            },
        );

        expect(download).toHaveBeenCalledTimes(1);
        expect(download.mock.calls[0][0]).toMatchObject({
            type: "lichess",
            username: "Alice",
            databasesDir: "/db",
            lastGameDate: Date.UTC(2026, 9, 19, 9, 0, 0),
            remaining: 40,
            token: "tok",
        });
        expect(result.newGames.map((g) => g.gameId)).toEqual([4, 3]);
        expect(result.reviewsEnqueued).toBe(2);
        expect(enqueueReview).toHaveBeenCalledTimes(2);
        expect(enqueueReview).toHaveBeenNthCalledWith(
            1,
            { kind: "database", database: "/db/Alice_lichess.db3", gameId: 4 },
            {
                playerColor: "white",
                preset: "full",
                title: "Alice - Bob",
                dedupeKey: "review:database:/db/Alice_lichess.db3#4",
            },
        );
        expect(enqueueReview).toHaveBeenNthCalledWith(
            2,
            { kind: "database", database: "/db/Alice_lichess.db3", gameId: 3 },
            {
                playerColor: "black",
                preset: "full",
                title: "Zed - alice",
                dedupeKey: "review:database:/db/Alice_lichess.db3#3",
            },
        );
        expect(notify).toHaveBeenCalledWith(2);
        expect(refresh).toHaveBeenCalledWith(store);
        expect(progress[0]).toBe(0);
        expect(progress[progress.length - 1]).toBe(1);
    });

    it("does not re-enqueue reviews for games synced earlier, nor for reviewed games", async () => {
        const store = storeWith([lichessSession]);
        const { rows, queryGames } = fakeDb([game({ id: 1 })]);
        let next = 2;
        const download = vi.fn<Download>(async () => {
            rows.push(game({ id: next++ }));
            return downloaded;
        });
        const enqueueReview = vi.fn<EnqueueReview>(async () => undefined);
        const hasReview = vi.fn<HasReview>(async (key) => key.endsWith("#3"));
        const deps = {
            store,
            queryGames,
            download,
            gameCount: async () => rows.length,
            loadReview: async () => ({ enqueueReview, hasReview }),
            notify: () => {},
            refresh: () => {},
        };

        const first = await runAccountSync({ reason: "manual" }, deps);
        expect(first.newGames.map((g) => g.gameId)).toEqual([2]);
        expect(enqueueReview).toHaveBeenCalledTimes(1);

        // A second sync adds game 3, which already has a review: nothing new is enqueued.
        const second = await runAccountSync({ reason: "manual" }, deps);
        expect(second.newGames.map((g) => g.gameId)).toEqual([3]);
        expect(second.reviewsEnqueued).toBe(0);
        expect(enqueueReview).toHaveBeenCalledTimes(1);

        // Re-running the review step for the same games is a no-op (dedupe set).
        expect(await enqueueReviewsFor(first.newGames, deps)).toBe(0);
    });

    it("caps automatic reviews and skips games silently when the review module is missing", async () => {
        const store = storeWith([lichessSession]);
        const { rows, queryGames } = fakeDb([]);
        const download: Download = async () => {
            for (let i = 1; i <= 5; i++) rows.push(game({ id: i }));
            return downloaded;
        };
        const enqueueReview = vi.fn<EnqueueReview>(async () => undefined);
        const base = {
            store,
            queryGames,
            download,
            gameCount: async () => 0,
            notify: () => {},
            refresh: () => {},
        };

        const capped = await runAccountSync(
            { reason: "manual" },
            { ...base, loadReview: async () => ({ enqueueReview }), maxAutoReviews: 2 },
        );
        expect(capped.newGames).toHaveLength(5);
        expect(capped.reviewsEnqueued).toBe(2);
        expect(enqueueReview.mock.calls.map((c) => c[0])).toEqual([
            { kind: "database", database: "/db/Alice_lichess.db3", gameId: 5 },
            { kind: "database", database: "/db/Alice_lichess.db3", gameId: 4 },
        ]);

        __resetAutoSyncForTests();
        rows.length = 0;
        const noModule = await runAccountSync(
            { reason: "manual" },
            { ...base, loadReview: async () => null as ReviewBridge | null },
        );
        expect(noModule.newGames).toHaveLength(5);
        expect(noModule.reviewsEnqueued).toBe(0);
    });

    it("keeps startup syncs incremental: an account without a database is skipped", async () => {
        const store = storeWith([lichessSession]);
        const { rows, queryGames } = fakeDb([]);
        const download = vi.fn<Download>(async () => {
            rows.push(game({ id: 1 }));
            return downloaded;
        });
        const result = await runAccountSync(
            { reason: "startup" },
            {
                store,
                queryGames,
                download,
                gameCount: async () => 0,
                notify: () => {},
                refresh: () => {},
                loadReview: async () => null,
            },
        );
        expect(download).not.toHaveBeenCalled();
        expect(result.accounts).toHaveLength(1);
        expect(result.newGames).toHaveLength(0);
    });

    it("does nothing while offline or without accounts", async () => {
        const download = vi.fn<Download>();
        const offline = storeWith([lichessSession]);
        offline.set(offlineModeAtom, true);
        const r1 = await runAccountSync({ reason: "startup" }, { store: offline, download });
        expect(r1.accounts).toEqual([]);
        localStorage.clear();

        const r2 = await runAccountSync(
            { reason: "startup", ctx: { offline: true } },
            { store: storeWith([lichessSession]), download },
        );
        expect(r2.accounts).toEqual([]);

        const r3 = await runAccountSync({ reason: "manual" }, { store: storeWith([]), download });
        expect(r3.accounts).toEqual([]);
        expect(download).not.toHaveBeenCalled();
    });

    it("fails the job only when every account failed", async () => {
        const store = storeWith([
            lichessSession,
            { chessCom: { username: "bob", stats: {} }, updatedAt: 2 },
        ]);
        const { queryGames } = fakeDb([]);
        const download = vi.fn<Download>(async ({ type }) => {
            if (type === "chesscom") throw new Error("boom");
            return downloaded;
        });
        const deps = {
            store,
            queryGames,
            download,
            gameCount: async () => 0,
            notify: () => {},
            refresh: () => {},
            loadReview: async () => null,
        };

        const partial = await runAccountSync({ reason: "manual" }, deps);
        expect(partial.accounts.map((a) => a.error)).toEqual([undefined, "boom"]);

        const allFail = vi.fn<Download>(async () => {
            throw new Error("down");
        });
        await expect(
            runAccountSync({ reason: "manual" }, { ...deps, download: allFail }),
        ).rejects.toThrow(/down/);
    });
});

describe("syncAccounts", () => {
    it("enqueues one deduped 'sync' job and returns null without accounts", async () => {
        const store = storeWith([lichessSession]);
        const enqueue = vi.fn<(input: EnqueueJobInput) => Promise<Job>>(async (input) => ({
            id: "j1",
            kind: input.kind,
            title: input.title,
            status: "queued" as const,
            payload: input.payload,
            progress: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            dedupeKey: input.dedupeKey,
        }));

        const job = await syncAccounts({ reason: "startup", store, enqueue });
        expect(job?.kind).toBe("sync");
        expect(enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "sync",
                payload: { reason: "startup" },
                dedupeKey: SYNC_DEDUPE_KEY,
            }),
        );

        expect(await syncAccounts({ reason: "startup", store: storeWith([]), enqueue })).toBeNull();
        expect(enqueue).toHaveBeenCalledTimes(1);
    });
});

describe("scheduleStartupSync", () => {
    it("syncs once after the workspace is ready, when auto-sync is on and online", () => {
        const store = storeWith([lichessSession]);
        const sync = vi.fn<StartupSync>(async () => null);
        scheduleStartupSync(store, { sync, firstRunOpen: () => false });
        expect(sync).not.toHaveBeenCalled();

        store.set(workspaceReadyAtom, true);
        expect(sync).toHaveBeenCalledTimes(1);
        expect(sync.mock.calls[0][0]).toMatchObject({ reason: "startup" });

        store.set(workspaceReadyAtom, false);
        store.set(workspaceReadyAtom, true);
        expect(sync).toHaveBeenCalledTimes(1);
    });

    it("skips when auto-sync is off or offline, and is scheduled at most once", () => {
        const sync = vi.fn<StartupSync>(async () => null);
        const off = storeWith([lichessSession]);
        off.set(autoSyncAtom, false);
        off.set(workspaceReadyAtom, true);
        scheduleStartupSync(off, { sync, firstRunOpen: () => false });
        expect(sync).not.toHaveBeenCalled();

        // Already scheduled in this process: a second call is a no-op.
        const online = storeWith([lichessSession]);
        online.set(workspaceReadyAtom, true);
        scheduleStartupSync(online, { sync, firstRunOpen: () => false });
        expect(sync).not.toHaveBeenCalled();

        __resetAutoSyncForTests();
        const offline = storeWith([lichessSession]);
        offline.set(offlineModeAtom, true);
        offline.set(workspaceReadyAtom, true);
        scheduleStartupSync(offline, { sync, firstRunOpen: () => false });
        expect(sync).not.toHaveBeenCalled();
    });

    it("waits for the first-run screen to close", () => {
        vi.useFakeTimers();
        const store = storeWith([lichessSession]);
        store.set(workspaceReadyAtom, true);
        let open = true;
        const sync = vi.fn<StartupSync>(async () => null);
        scheduleStartupSync(store, { sync, firstRunOpen: () => open, pollMs: 100 });
        expect(sync).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(sync).not.toHaveBeenCalled();

        open = false;
        vi.advanceTimersByTime(100);
        expect(sync).toHaveBeenCalledTimes(1);
    });
});
