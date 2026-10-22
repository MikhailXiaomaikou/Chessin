import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { NormalizedGame } from "@/bindings";
import {
    applyFilters,
    clusterIds,
    DEFAULT_SIMILAR_FILTERS,
    dedupeByKey,
    formatSummary,
    hasClientOnlyFilters,
    indexFallbackReason,
    indexFilterFor,
    indexResultOf,
    MAX_INDEX_PLY,
    resultOf,
    sortOpenings,
    summarizeGames,
    summarizeStats,
    toNormalizedGame,
    toOpenings,
    uniqueIds,
    wholeYearOf,
    withDecisiveOnly,
    wholeYearOf as year,
} from "./mapping";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const DEEP = "8/8/8/8/8/8/8/8 b - - 0 21"; // ply 41

function game(partial: Partial<NormalizedGame>): NormalizedGame {
    return {
        id: 1,
        fen: START,
        event: "",
        event_id: 0,
        site: "",
        site_id: 0,
        white: "A",
        white_id: 0,
        black: "B",
        black_id: 0,
        result: "*",
        moves: "",
        ...partial,
    };
}

const t = ((key: string, values?: Record<string, unknown>) =>
    `${key}${values ? ` ${JSON.stringify(values)}` : ""}`) as unknown as TFunction;

describe("explorer rows", () => {
    it("maps index move stats to Opening rows, with '*' for the game end", () => {
        expect(
            toOpenings([
                {
                    uci: "e2e4",
                    san: "e4",
                    white: 3,
                    draw: 2,
                    black: 1,
                    games: 6,
                    avg_elo: 2400,
                    last_year: 2020,
                },
                {
                    uci: "",
                    san: "",
                    white: 0,
                    draw: 1,
                    black: 0,
                    games: 1,
                    avg_elo: 0,
                    last_year: 0,
                },
            ]),
        ).toEqual([
            { move: "e4", white: 3, black: 1, draw: 2 },
            { move: "*", white: 0, black: 0, draw: 1 },
        ]);
    });

    it("sorts most played first without mutating the input", () => {
        const rows = [
            { move: "d4", white: 1, draw: 0, black: 0 },
            { move: "e4", white: 2, draw: 1, black: 0 },
        ];
        expect(sortOpenings(rows).map((r) => r.move)).toEqual(["e4", "d4"]);
        expect(rows[0].move).toBe("d4");
    });
});

describe("toNormalizedGame", () => {
    it("maps an index_games row onto the NormalizedGame shape", () => {
        const game = toNormalizedGame({
            id: 7,
            white: "Carlsen, M",
            black: "",
            white_elo: 2850,
            black_elo: null,
            result: "1-0",
            date: "2021.07.??",
            event: "Norway Chess",
            site: "Stavanger",
            eco: "C65",
            ply_count: 81,
            fen: null,
            moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5",
        });
        expect(game).toMatchObject({
            id: 7,
            fen: START,
            white: "Carlsen, M",
            black: "",
            white_id: 0,
            black_id: 0,
            event_id: 0,
            site_id: 0,
            white_elo: 2850,
            black_elo: null,
            result: "1-0",
            date: "2021.07.??",
            eco: "C65",
            ply_count: 81,
            moves: "1. e4 e5 2. Nf3 Nc6 3. Bb5",
        });
    });

    it("keeps a custom start FEN and normalises unknown results to '*'", () => {
        const game = toNormalizedGame({
            id: 1,
            white: "A",
            black: "B",
            white_elo: null,
            black_elo: null,
            result: "unfinished",
            date: null,
            event: "",
            site: "",
            eco: null,
            ply_count: null,
            fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
            moves: "",
        });
        expect(game.result).toBe("*");
        expect(game.fen).toBe("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
        expect(game.date).toBeNull();
    });
});

describe("index filters", () => {
    it("maps the panel's result option to PGN result codes", () => {
        expect(indexResultOf("whitewon")).toBe("1-0");
        expect(indexResultOf("blackwon")).toBe("0-1");
        expect(indexResultOf("draw")).toBe("1/2-1/2");
        expect(indexResultOf("any")).toBeUndefined();
    });

    it("accepts whole-year dates only", () => {
        expect(wholeYearOf(undefined, "start")).toBeUndefined();
        expect(year("", "end")).toBeUndefined();
        expect(wholeYearOf("2020.01.01", "start")).toBe(2020);
        expect(wholeYearOf("2020", "start")).toBe(2020);
        expect(wholeYearOf("2020.12.31", "end")).toBe(2020);
        expect(wholeYearOf("2020.06.01", "start")).toBeNull();
        expect(wholeYearOf("2020.01.01", "end")).toBeNull();
        expect(wholeYearOf("junk", "start")).toBeNull();
    });

    it("builds an IndexFilter from the panel options", () => {
        expect(
            indexFilterFor({ result: "draw", start_date: "2010.01.01", end_date: "2019.12.31" }),
        ).toEqual({ result: "1/2-1/2", year_from: 2010, year_to: 2019 });
        expect(indexFilterFor({ result: "any" })).toEqual({});
    });

    it("explains why a query falls back to search_position", () => {
        const base = { fen: START, type: "exact" as const, player: null };
        expect(indexFallbackReason(base, "ready", false)).toBe("unavailable");
        expect(indexFallbackReason(base, "none")).toBe("not_ready");
        expect(indexFallbackReason(base, "building")).toBe("not_ready");
        expect(indexFallbackReason({ ...base, type: "partial" }, "ready")).toBe("partial");
        expect(indexFallbackReason({ ...base, fen: DEEP }, "ready")).toBe("ply");
        expect(indexFallbackReason({ ...base, player: 7 }, "ready")).toBe("player");
        expect(indexFallbackReason({ ...base, start_date: "2020.03.01" }, "ready")).toBe("dates");
        expect(indexFallbackReason({ ...base, end_date: "2020.03.01" }, "ready")).toBe("dates");
        expect(indexFallbackReason({ ...base, start_date: "2020.01.01" }, "ready")).toBeNull();
        expect(indexFallbackReason(base, "ready")).toBeNull();
        expect(MAX_INDEX_PLY).toBe(40);
    });
});

describe("drawer filters", () => {
    const games = [
        game({ id: 1, result: "1-0", white_elo: 2500, black_elo: 2450, date: "2021.05.01" }),
        game({ id: 2, result: "1/2-1/2", white_elo: 2600, black_elo: 2200, date: "2019.01.01" }),
        game({ id: 3, result: "0-1", white_elo: 0, black_elo: 2700, date: "2022.??.??" }),
        game({ id: 4, result: "*", white_elo: 2400, black_elo: 2400, date: null }),
    ];

    it("maps results", () => {
        expect(games.map(resultOf)).toEqual(["white", "draw", "black", "unknown"]);
    });

    it("min Elo applies to both players and excludes unrated games", () => {
        expect(
            applyFilters(games, { ...DEFAULT_SIMILAR_FILTERS, minElo: 2300 }).map((g) => g.id),
        ).toEqual([1, 4]);
    });

    it("decisive-only keeps wins and losses", () => {
        expect(
            applyFilters(games, { ...DEFAULT_SIMILAR_FILTERS, decisiveOnly: true }).map(
                (g) => g.id,
            ),
        ).toEqual([1, 3]);
    });

    it("year-from reads the year prefix of the date", () => {
        expect(
            applyFilters(games, { ...DEFAULT_SIMILAR_FILTERS, yearFrom: 2021 }).map((g) => g.id),
        ).toEqual([1, 3]);
    });

    it("knows which chips cannot be pushed into the backend query", () => {
        expect(hasClientOnlyFilters(DEFAULT_SIMILAR_FILTERS, "scan")).toBe(false);
        expect(
            hasClientOnlyFilters({ ...DEFAULT_SIMILAR_FILTERS, decisiveOnly: true }, "index"),
        ).toBe(true);
        expect(hasClientOnlyFilters({ ...DEFAULT_SIMILAR_FILTERS, minElo: 2300 }, "scan")).toBe(
            true,
        );
        expect(hasClientOnlyFilters({ ...DEFAULT_SIMILAR_FILTERS, minElo: 2300 }, "index")).toBe(
            false,
        );
    });
});

describe("summary", () => {
    it("totals move statistics and weights the rating by games", () => {
        const s = summarizeStats([
            { white: 6, draw: 2, black: 2, games: 10, avg_elo: 2500 },
            { white: 10, draw: 20, black: 0, games: 30, avg_elo: 2300 },
            { white: 1, draw: 0, black: 0 },
        ]);
        expect(s).toEqual({ games: 41, white: 17, draw: 22, black: 2, avgElo: 2350 });
    });

    it("totals games and averages every known rating", () => {
        const s = summarizeGames([
            game({ result: "1-0", white_elo: 2400, black_elo: 2200 }),
            game({ result: "0-1", white_elo: 0, black_elo: 2600 }),
            game({ result: "*", white_elo: null, black_elo: null }),
        ]);
        expect(s).toEqual({ games: 3, white: 1, draw: 1, black: 1, avgElo: 2400 });
        expect(summarizeGames([]).avgElo).toBeNull();
    });

    it("drops draws for decisive-only", () => {
        expect(withDecisiveOnly({ games: 10, white: 5, draw: 3, black: 2, avgElo: 2000 })).toEqual({
            games: 7,
            white: 5,
            draw: 0,
            black: 2,
            avgElo: 2000,
        });
    });

    it("formats the summary line with rounded percentages", () => {
        expect(
            formatSummary({ games: 1240, white: 694, draw: 384, black: 162, avgElo: 2410 }, t),
        ).toBe(
            `Search.Summary ${JSON.stringify({ games: "1,240", white: 56, draw: 31, elo: 2410 })}`,
        );
        expect(formatSummary({ games: 3, white: 1, draw: 1, black: 1, avgElo: null }, t)).toBe(
            `Search.Summary.NoElo ${JSON.stringify({ games: "3", white: 33, draw: 33, elo: 0 })}`,
        );
        expect(formatSummary({ games: 0, white: 0, draw: 0, black: 0, avgElo: null }, t)).toBe(
            "Search.Empty",
        );
    });
});

describe("dedupe", () => {
    it("keeps the lowest ply per key in first-seen order", () => {
        const rows = [
            { id: 7, ply: 12 },
            { id: 3, ply: 4 },
            { id: 7, ply: 8 },
            { id: 3, ply: 9 },
        ];
        expect(dedupeByKey(rows, (r) => String(r.id))).toEqual([
            { id: 7, ply: 8 },
            { id: 3, ply: 4 },
        ]);
    });

    it("uniqueIds keeps first occurrences", () => {
        expect(uniqueIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    });

    it("clusters sorted ids by gap", () => {
        expect(clusterIds([1, 2, 3, 70, 71, 500], 64)).toEqual([
            [1, 3],
            [70, 71],
            [500, 500],
        ]);
        expect(clusterIds([], 64)).toEqual([]);
    });
});
