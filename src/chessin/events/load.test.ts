import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { sessionsAtom, storedDatabasesDirAtom } from "@/state/atoms";
import { loadEventRows, rowFromGame } from "./load";

function game(partial: Partial<NormalizedGame> & { id: number }): NormalizedGame {
    return {
        fen: "",
        event: "Rated Blitz game",
        event_id: 1,
        site: "https://lichess.org/abcd1234",
        site_id: 1,
        date: "2026.03.01",
        time: "12:00:00",
        round: "-",
        white: "me",
        white_id: 1,
        white_elo: 1700,
        black: "them",
        black_id: 2,
        black_elo: 1650,
        result: "1-0",
        time_control: "180+2",
        moves: "1. e4 e5",
        ...partial,
    };
}

describe("rowFromGame", () => {
    it("keeps the event headers and detects my colour", () => {
        const db = { site: "lichess" as const, username: "me", path: "/db/me_lichess.db3" };
        const row = rowFromGame(game({ id: 7, round: "3" }), db);
        expect(row).toMatchObject({
            key: "database:/db/me_lichess.db3#7",
            origin: { kind: "database", database: "/db/me_lichess.db3", gameId: 7 },
            event: "Rated Blitz game",
            site: "https://lichess.org/abcd1234",
            round: "3",
            date: "2026.03.01",
            timestamp: Date.UTC(2026, 2, 1, 12),
            playerColor: "white",
            whiteElo: 1700,
            blackElo: 1650,
            result: "1-0",
            timeControl: "180+2",
        });
        const asBlack = rowFromGame(game({ id: 8, white: "them", black: "me", round: null }), db);
        expect(asBlack.playerColor).toBe("black");
        expect(asBlack.round).toBeNull();
    });
});

describe("loadEventRows", () => {
    it("queries every account database and merges newest first", async () => {
        const store = createStore();
        store.set(storedDatabasesDirAtom, "/db");
        store.set(sessionsAtom, [
            { lichess: { username: "me", accessToken: "", account: {} } },
            { chessCom: { username: "me2", stats: {} } },
        ] as never);
        const asked: string[] = [];
        const rows = await loadEventRows({
            limit: 10,
            store,
            queryGames: async (db, query) => {
                asked.push(db);
                expect(query.options?.pageSize).toBe(10);
                if (db.endsWith("me_lichess.db3")) {
                    return {
                        data: [game({ id: 1, date: "2026.03.01" }), game({ id: 2, date: null })],
                        count: null,
                    };
                }
                throw new Error("not downloaded");
            },
        });
        expect(asked).toEqual(["/db/me_lichess.db3", "/db/me2_chesscom.db3"]);
        expect(rows.map((r) => r.gameId)).toEqual([1, 2]);
        expect(rows[1].timestamp).toBeNull();
        expect(
            await loadEventRows({
                store: createStore(),
                queryGames: async () => ({ data: [], count: null }),
            }),
        ).toEqual([]);
    });
});
