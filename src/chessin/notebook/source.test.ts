import { describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { findDatabaseGame, gameKeyLabel, mainLinePath, parseGameKey } from "./source";

type ProbeQuery = { options?: { page?: number; pageSize?: number; skipCount?: boolean } };

const { games, queryGames } = vi.hoisted(() => {
    const games = [3, 4, 7, 8, 9, 15].map((id) => ({
        id,
        fen: "",
        event: "",
        event_id: 0,
        site: "",
        site_id: 0,
        white: `W${id}`,
        white_id: 0,
        black: `B${id}`,
        black_id: 0,
        result: "*" as const,
        moves: "1. e4 e5",
    }));
    const queryGames = vi.fn<
        (db: string, query: ProbeQuery) => Promise<{ data: typeof games; count: number | null }>
    >(async (_db, query) => {
        const page = query.options?.page ?? 1;
        const size = query.options?.pageSize ?? 10;
        const data = games.slice((page - 1) * size, page * size);
        return { data, count: query.options?.skipCount ? null : games.length };
    });
    return { games, queryGames };
});

vi.mock("@/utils/db", () => ({ query_games: queryGames }));

const allGames: NormalizedGame[] = games;

describe("game keys", () => {
    it("parses the three key forms", () => {
        expect(parseGameKey("file:/home/me/games-2024.pgn#3")).toEqual({
            kind: "file",
            path: "/home/me/games-2024.pgn",
            gameNumber: 3,
        });
        expect(parseGameKey("database:C:\\db\\me_lichess.db3#120")).toEqual({
            kind: "database",
            database: "C:\\db\\me_lichess.db3",
            gameId: 120,
        });
        expect(parseGameKey("library:abcd1234")).toEqual({ kind: "library", docId: "abcd1234" });
        expect(parseGameKey("file:/no-hash.pgn")).toBeNull();
        expect(parseGameKey("database:/x.db3#nan")).toBeNull();
        expect(parseGameKey("library:")).toBeNull();
        expect(parseGameKey("weird")).toBeNull();
    });

    it("labels keys and builds main-line paths", () => {
        expect(gameKeyLabel("file:/home/me/games.pgn#0")).toBe("games.pgn #1");
        expect(gameKeyLabel("database:/db/me_lichess.db3#120")).toBe("me_lichess.db3 #120");
        expect(gameKeyLabel("library:doc")).toBe("doc");
        expect(gameKeyLabel("???")).toBe("???");
        expect(mainLinePath(1)).toEqual([]);
        expect(mainLinePath(4)).toEqual([0, 0, 0]);
        expect(mainLinePath(0)).toEqual([]);
    });
});

describe("findDatabaseGame", () => {
    it("finds a game by id even when ids are not contiguous", async () => {
        queryGames.mockClear();
        expect((await findDatabaseGame("/db", 3))?.white).toBe("W3");
        expect((await findDatabaseGame("/db", 9))?.white).toBe("W9");
        expect((await findDatabaseGame("/db", 15))?.white).toBe("W15");
        expect(await findDatabaseGame("/db", 5)).toBeNull();
        expect(await findDatabaseGame("/db", 100)).toBeNull();
        expect(allGames).toHaveLength(6);
        // Every probe asks for one game sorted by id.
        for (const call of queryGames.mock.calls) {
            expect(call[1].options).toMatchObject({ pageSize: 1 });
        }
    });
});
