import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { __setIndexDepsForTests, type IndexDeps } from "@/chessin/search/index";
import { getGamesByIds, getGamesByIdsByOffset } from "@/utils/db";

/**
 * `getGamesByIds` (src/utils/db.ts) over a fake `get_games`: ids are served by
 * offset (`(page - 1) * pageSize`) like the Rust command, so deleted ids shift
 * later games to earlier offsets.
 */

type GetGamesQuery = { options?: { page?: number | null; pageSize?: number | null } };

const calls: { page: number; pageSize: number }[] = [];
let table: number[] = [];

function row(id: number): NormalizedGame {
    return {
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
        result: "*",
        moves: "",
    };
}

vi.mock("@/bindings", () => ({
    commands: {
        getGames: vi.fn<(file: string, query: GetGamesQuery) => Promise<unknown>>(
            async (_file, query) => {
                const page = query.options?.page ?? 1;
                const pageSize = query.options?.pageSize ?? 10;
                calls.push({ page, pageSize });
                const offset = (page - 1) * pageSize;
                return {
                    status: "ok",
                    data: { data: table.slice(offset, offset + pageSize).map(row), count: null },
                };
            },
        ),
    },
}));

beforeEach(() => {
    calls.length = 0;
    table = Array.from({ length: 100 }, (_, i) => i + 1);
});

afterEach(() => {
    __setIndexDepsForTests(null);
});

/** Index deps where only `index_games` exists (as in a build with S3-1 but no sidecar yet). */
function withIndexGames(games: IndexDeps["games"]): void {
    __setIndexDepsForTests({
        available: () => false,
        status: async () => null,
        build: async () => {
            throw new Error("unused");
        },
        remove: async () => {},
        position: async () => ({ ply: 0, moves: [], games: [], total: 0 }),
        pawnCandidates: async () => [],
        listenProgress: async () => () => {},
        gamesAvailable: () => true,
        games,
    });
}

describe("getGamesByIds with index_games", () => {
    it("asks index_games for the ids and never pages", async () => {
        const asked: number[][] = [];
        withIndexGames(async (_db, ids) => {
            asked.push(ids);
            return ids.filter((id) => id !== 999).map(row);
        });
        const games = await getGamesByIds("/x.db3", [9, 3, 999]);
        expect(games.map((g) => g.id)).toEqual([9, 3]);
        expect(asked).toEqual([[9, 3, 999]]);
        expect(calls).toEqual([]);
    });

    it("falls back to paging when index_games fails", async () => {
        withIndexGames(async () => {
            throw new Error("no such command");
        });
        const games = await getGamesByIds("/x.db3", [4]);
        expect(games.map((g) => g.id)).toEqual([4]);
        expect(calls.length).toBeGreaterThan(0);
    });
});

describe("getGamesByIdsByOffset", () => {
    it("is what getGamesByIds uses without index_games", async () => {
        const games = await getGamesByIds("/x.db3", [5]);
        expect(games.map((g) => g.id)).toEqual([5]);
        expect(calls.length).toBeGreaterThan(0);
    });

    it("returns the games in the requested order, dropping unknown and duplicate ids", async () => {
        const games = await getGamesByIdsByOffset("/x.db3", [9, 3, 4, 3, 999]);
        expect(games.map((g) => g.id)).toEqual([9, 3, 4]);
        expect(games[0].white).toBe("W9");
    });

    it("fetches one window per id cluster instead of one query per id", async () => {
        await getGamesByIdsByOffset("/x.db3", [20, 21, 22, 23, 24, 25]);
        // span 6 → pages 4 and 5 of size 6 cover offsets 18..29.
        expect(calls).toEqual([
            { page: 4, pageSize: 6 },
            { page: 5, pageSize: 6 },
        ]);
    });

    it("still finds a game shifted by a deleted earlier id", async () => {
        table = table.filter((id) => id !== 3);
        const games = await getGamesByIdsByOffset("/x.db3", [6]);
        expect(games.map((g) => g.id)).toEqual([6]);
        // Offset 5 now holds id 7, page 7 holds id 8, page 5 holds id 6.
        expect(calls.map((c) => c.page).sort((a, b) => a - b)).toEqual([5, 6, 7]);
    });

    it("gives up on ids shifted further than a window", async () => {
        table = table.filter((id) => id > 10);
        expect(await getGamesByIdsByOffset("/x.db3", [50])).toEqual([]);
        expect(await getGamesByIdsByOffset("/x.db3", [])).toEqual([]);
    });
});
