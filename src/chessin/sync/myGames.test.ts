import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { sessionsAtom, storedDatabasesDirAtom } from "@/state/atoms";
import type { Session } from "@/utils/session";
import {
    accountDatabases,
    accountPlayerNames,
    detectPlayerColor,
    joinPath,
    listMyGames,
    myGameKey,
    parseGameTimestamp,
    type QueryGames,
    sortMyGames,
    toMyGame,
} from "./myGames";

function game(partial: Partial<NormalizedGame> & { id: number }): NormalizedGame {
    return {
        fen: "",
        event: "Rated Blitz game",
        event_id: 0,
        site: "",
        site_id: 0,
        white: "Alice",
        white_id: 0,
        black: "Bob",
        black_id: 0,
        result: "1-0",
        moves: "1. e4 e5",
        date: "2026.10.20",
        time: "12:00:00",
        ...partial,
    };
}

function sessions(): Session[] {
    return [
        {
            player: "Ali",
            lichess: { username: "Alice", account: { username: "Alice" } as never },
            updatedAt: 1,
        },
        {
            chessCom: { username: "bob_cc", stats: {} },
            updatedAt: 2,
        },
    ];
}

function storeWith(dir = "/data/db") {
    const store = createStore();
    store.set(storedDatabasesDirAtom, dir);
    store.set(sessionsAtom, sessions());
    return store;
}

describe("account helpers", () => {
    it("lists usernames and aliases once", () => {
        expect(accountPlayerNames(storeWith())).toEqual(["Alice", "Ali", "bob_cc"]);
    });

    it("derives one database path per account", () => {
        expect(accountDatabases(storeWith())).toEqual([
            { site: "lichess", username: "Alice", path: "/data/db/Alice_lichess.db3" },
            { site: "chesscom", username: "bob_cc", path: "/data/db/bob_cc_chesscom.db3" },
        ]);
        expect(joinPath("C:\\db\\", "x.db3")).toBe("C:\\db\\x.db3");
        expect(joinPath("", "x.db3")).toBe("x.db3");
    });

    it("builds keys with originToString", () => {
        expect(myGameKey("/data/db/Alice_lichess.db3", 12)).toBe(
            "database:/data/db/Alice_lichess.db3#12",
        );
    });

    it("parses PGN dates, tolerating a missing time and rejecting unknown dates", () => {
        expect(parseGameTimestamp("2026.10.20", "12:30:05")).toBe(Date.UTC(2026, 9, 20, 12, 30, 5));
        expect(parseGameTimestamp("2026.10.20", null)).toBe(Date.UTC(2026, 9, 20));
        expect(parseGameTimestamp("????.??.??", "12:00:00")).toBeNull();
        expect(parseGameTimestamp(null)).toBeNull();
    });

    it("detects the player's colour case-insensitively, with aliases as fallback", () => {
        expect(detectPlayerColor({ white: "alice", black: "x" }, "Alice")).toBe("white");
        expect(detectPlayerColor({ white: "x", black: "ALICE" }, "Alice")).toBe("black");
        expect(detectPlayerColor({ white: "x", black: "Ali" }, "Alice", ["Ali"])).toBe("black");
        expect(detectPlayerColor({ white: "x", black: "y" }, "Alice")).toBe("white");
    });
});

describe("listMyGames", () => {
    it("merges every account database, newest first, and skips unreadable ones", async () => {
        const store = storeWith();
        const queryGames = vi.fn<QueryGames>(async (db) => {
            if (db.endsWith("Alice_lichess.db3")) {
                return {
                    count: null,
                    data: [
                        game({ id: 3, date: "2026.10.21", time: "08:00:00", white: "Alice" }),
                        game({
                            id: 1,
                            date: "2026.10.19",
                            time: "08:00:00",
                            black: "alice",
                            white: "Zed",
                        }),
                    ],
                };
            }
            throw new Error("no such database");
        });

        const games = await listMyGames({ store, queryGames });
        expect(queryGames).toHaveBeenCalledTimes(2);
        expect(games.map((g) => g.gameId)).toEqual([3, 1]);
        expect(games[0]).toMatchObject({
            key: "database:/data/db/Alice_lichess.db3#3",
            origin: { kind: "database", database: "/data/db/Alice_lichess.db3", gameId: 3 },
            site: "lichess",
            playerColor: "white",
            date: "2026.10.21",
        });
        expect(games[1].playerColor).toBe("black");
    });

    it("interleaves accounts by date and applies limit and sinceTs", async () => {
        const store = storeWith();
        const queryGames: QueryGames = async (db) => ({
            count: null,
            data: db.includes("lichess")
                ? [
                      game({ id: 10, date: "2026.10.22", time: "10:00:00" }),
                      game({ id: 9, date: "2026.10.20", time: "10:00:00" }),
                  ]
                : [
                      game({ id: 5, date: "2026.10.21", time: "10:00:00", white: "bob_cc" }),
                      game({ id: 4, date: "????.??.??", time: null, white: "bob_cc" }),
                  ],
        });

        const all = await listMyGames({ store, queryGames });
        expect(all.map((g) => `${g.site}#${g.gameId}`)).toEqual([
            "lichess#10",
            "chesscom#5",
            "lichess#9",
            "chesscom#4",
        ]);

        const limited = await listMyGames({ store, queryGames, limit: 2 });
        expect(limited.map((g) => g.gameId)).toEqual([10, 5]);

        const since = await listMyGames({
            store,
            queryGames,
            sinceTs: Date.UTC(2026, 9, 20, 10, 0, 0),
        });
        expect(since.map((g) => g.gameId)).toEqual([10, 5]);
    });

    it("returns nothing without accounts", async () => {
        const store = createStore();
        const queryGames = vi.fn<QueryGames>();
        expect(await listMyGames({ store, queryGames })).toEqual([]);
        expect(queryGames).not.toHaveBeenCalled();
    });

    it("keeps undated games last when sorting", () => {
        const db = { site: "lichess" as const, username: "Alice", path: "/db/a.db3" };
        const sorted = sortMyGames([
            toMyGame(game({ id: 1, date: null, time: null }), db),
            toMyGame(game({ id: 2, date: "2026.01.01" }), db),
            toMyGame(game({ id: 3, date: "2026.02.01" }), db),
        ]);
        expect(sorted.map((g) => g.gameId)).toEqual([3, 2, 1]);
    });
});
