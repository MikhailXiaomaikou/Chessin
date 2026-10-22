import { describe, expect, it } from "vitest";
import {
    compareRounds,
    type EventGameRow,
    eventId,
    eventIdForHeaders,
    eventName,
    groupGames,
    normalizeSite,
    opponentOf,
    outcomeFor,
    roundParts,
    tallyOf,
    yearOf,
} from "./group";

function row(partial: Partial<EventGameRow> & { gameId: number }): EventGameRow {
    const date = partial.date ?? "2026.03.01";
    const [y, m, d] = date.split(".").map(Number);
    return {
        key: `database:/db/me_lichess.db3#${partial.gameId}`,
        origin: { kind: "database", database: "/db/me_lichess.db3", gameId: partial.gameId },
        database: "/db/me_lichess.db3",
        event: "Rated Blitz game",
        site: "https://lichess.org/abcd1234",
        round: null,
        date,
        timestamp: y && m && d ? Date.UTC(y, m - 1, d) : null,
        white: "me",
        black: "them",
        whiteElo: 1700,
        blackElo: 1650,
        result: "1-0",
        playerColor: "white",
        timeControl: "180+2",
        ...partial,
    };
}

describe("normalizeSite / yearOf / ids", () => {
    it("reduces URL sites to their host and keeps plain sites", () => {
        expect(normalizeSite("https://lichess.org/abcd1234")).toBe("lichess.org");
        expect(normalizeSite("https://www.chess.com/game/live/1")).toBe("chess.com");
        expect(normalizeSite("Wijk aan Zee NED")).toBe("Wijk aan Zee NED");
        expect(normalizeSite("?")).toBe("");
        expect(normalizeSite(null)).toBe("");
    });

    it("extracts the year and builds stable ids", () => {
        expect(yearOf("2026.03.01")).toBe("2026");
        expect(yearOf("2026.??.??")).toBe("2026");
        expect(yearOf("????.??.??")).toBe("?");
        expect(yearOf(null)).toBe("?");
        expect(eventName(" ? ")).toBe("");
        expect(eventId("Tata Steel", "https://lichess.org/x", "2026")).toBe(
            "2026|lichess.org|Tata Steel",
        );
        expect(
            eventIdForHeaders({ event: "Tata Steel", site: "Wijk aan Zee", date: "2026.01.20" }),
        ).toBe("2026|Wijk aan Zee|Tata Steel");
        expect(eventIdForHeaders({ event: "?", site: "?", date: null })).toBeNull();
        expect(eventIdForHeaders({ event: "", site: "https://lichess.org/x" })).toBe(
            "?|lichess.org|",
        );
    });
});

describe("outcomeFor / rounds / opponent", () => {
    it("maps results to the user's outcome", () => {
        expect(outcomeFor("1-0", "white")).toBe("win");
        expect(outcomeFor("1-0", "black")).toBe("loss");
        expect(outcomeFor("0-1", "black")).toBe("win");
        expect(outcomeFor("1/2-1/2", "white")).toBe("draw");
        expect(outcomeFor("*", "white")).toBe("unknown");
        expect(outcomeFor(null, "white")).toBe("unknown");
    });

    it("orders rounds numerically, then by date, then by id", () => {
        expect(roundParts("3.1")).toEqual([3, 1]);
        expect(roundParts("-")).toEqual([]);
        expect(roundParts(null)).toEqual([]);
        const a = row({ gameId: 1, round: "10" });
        const b = row({ gameId: 2, round: "9" });
        const c = row({ gameId: 3, round: "9.2" });
        const d = row({ gameId: 4, round: null, date: "2026.02.01" });
        const e = row({ gameId: 5, round: null, date: "2026.02.02" });
        expect([a, b, c, d, e].sort(compareRounds).map((r) => r.gameId)).toEqual([2, 3, 1, 4, 5]);
        expect(compareRounds(row({ gameId: 7 }), row({ gameId: 6 }))).toBeGreaterThan(0);
    });

    it("names the opponent with their rating", () => {
        expect(opponentOf(row({ gameId: 1 }))).toEqual({ name: "them", elo: 1650 });
        expect(
            opponentOf(row({ gameId: 1, playerColor: "black", white: "x", whiteElo: null })),
        ).toEqual({ name: "x", elo: null });
    });
});

describe("groupGames", () => {
    it("groups by event, site host and year, newest event first", () => {
        const rows = [
            row({ gameId: 1, date: "2026.03.01" }),
            row({ gameId: 2, date: "2026.03.02", site: "https://lichess.org/efgh5678" }),
            row({ gameId: 3, date: "2025.12.31", result: "0-1" }),
            row({
                gameId: 4,
                event: "Club Championship",
                site: "Shanghai",
                date: "2026.04.10",
                round: "2",
                result: "1/2-1/2",
            }),
            row({
                gameId: 5,
                event: "Club Championship",
                site: "Shanghai",
                date: "2026.04.09",
                round: "1",
                playerColor: "black",
                result: "1-0",
            }),
            row({ gameId: 6, event: "?", site: "?", date: "????.??.??" }),
        ];
        const groups = groupGames(rows);
        expect(groups.map((g) => g.id)).toEqual([
            "2026|Shanghai|Club Championship",
            "2026|lichess.org|Rated Blitz game",
            "2025|lichess.org|Rated Blitz game",
            "?||",
        ]);
        expect(groups[0].games.map((g) => g.gameId)).toEqual([5, 4]);
        expect(groups[0].tally).toEqual({ wins: 0, draws: 1, losses: 1, unknown: 0 });
        expect(groups[1].games.map((g) => g.gameId)).toEqual([1, 2]);
        expect(groups[1].earliest).toBe(Date.UTC(2026, 2, 1));
        expect(groups[1].latest).toBe(Date.UTC(2026, 2, 2));
        expect(groups[2].tally).toEqual({ wins: 0, draws: 0, losses: 1, unknown: 0 });
        expect(groups[3]).toMatchObject({ event: "", site: "", year: "?", latest: null });
        expect(groupGames([])).toEqual([]);
    });

    it("tallies unknown results", () => {
        expect(tallyOf([row({ gameId: 1, result: "*" }), row({ gameId: 2 })])).toEqual({
            wins: 1,
            draws: 0,
            losses: 0,
            unknown: 1,
        });
    });
});
