import { describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { INITIAL_FEN } from "chessops/fen";
import { DEFAULT_SIMILAR_FILTERS } from "./mapping";
import {
    fetchSimilar,
    type SimilarDeps,
    type SimilarQuery,
    similarUnavailableKey,
} from "./similar";

const DB = "/collections/mega.db3";
const AFTER_E4_D5_EXD5_QXD5 = "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";

function game(partial: Partial<NormalizedGame>): NormalizedGame {
    return {
        id: 1,
        fen: INITIAL_FEN,
        event: "",
        event_id: 0,
        site: "",
        site_id: 0,
        white: "A",
        white_id: 0,
        black: "B",
        black_id: 0,
        result: "1-0",
        white_elo: 2500,
        black_elo: 2500,
        moves: "1. e4 e5",
        ...partial,
    };
}

function query(partial: Partial<SimilarQuery>): SimilarQuery {
    return {
        kind: "similar",
        mode: "position",
        fen: AFTER_E4_D5_EXD5_QXD5,
        source: { kind: "local", path: DB, title: "mega" },
        filters: DEFAULT_SIMILAR_FILTERS,
        lane: "similar:t1",
        token: "",
        lichessOptions: {} as SimilarQuery["lichessOptions"],
        masterOptions: {} as SimilarQuery["masterOptions"],
        ...partial,
    };
}

function deps(partial: Partial<SimilarDeps>): SimilarDeps {
    return {
        indexState: () => "none",
        indexPosition: vi.fn<SimilarDeps["indexPosition"]>(async () => ({
            ply: 0,
            moves: [],
            games: [],
            total: 0,
        })),
        indexPawnCandidates: vi.fn<SimilarDeps["indexPawnCandidates"]>(async () => []),
        getGamesByIds: vi.fn<SimilarDeps["getGamesByIds"]>(async () => []),
        searchPosition: vi.fn<SimilarDeps["searchPosition"]>(async () => [[], []]),
        lichess: vi.fn<SimilarDeps["lichess"]>(async () => null),
        lichessGames: vi.fn<SimilarDeps["lichessGames"]>(async () => []),
        ...partial,
    };
}

const EQUAL = game({ id: 1, moves: "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. Nf3 1-0" });
const SUPERSET = game({ id: 2, moves: "1. e4 d5 2. exd5 Nf6 3. c4 e6 1/2-1/2", result: "1/2-1/2" });

describe("fetchSimilar — same pawn structure", () => {
    it("verifies partial-match candidates by replay and reports the sample", async () => {
        const d = deps({
            searchPosition: vi.fn<SimilarDeps["searchPosition"]>(async () => [
                [{ move: "*", white: 30, draw: 10, black: 10 }],
                [EQUAL, SUPERSET],
            ]),
        });
        const result = await fetchSimilar(query({ mode: "pawns" }), d);
        expect(result.via).toBe("scan");
        expect(result.approximate).toBe(true);
        expect(result.sample).toEqual({ candidates: 50, checked: 2, verified: 1 });
        expect(result.rows.map((r) => [r.game.id, r.ply])).toEqual([[1, 4]]);
        expect(
            result.rows[0].fen.startsWith("rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w"),
        ).toBe(true);
        expect(result.rows[0].database).toBe(DB);
        expect(result.summary).toEqual({ games: 1, white: 1, draw: 0, black: 0, avgElo: 2500 });
        // The scan was asked for the pawns-only FEN as a partial query.
        const [options] = vi.mocked(d.searchPosition).mock.calls[0];
        expect(options).toMatchObject({
            type: "partial",
            fen: "8/ppp1pppp/8/8/8/8/PPPP1PPP/8 w - - 0 3",
        });
    });

    it("uses the index's pawn candidates when the index is ready", async () => {
        const d = deps({
            indexState: () => "ready",
            indexPawnCandidates: vi.fn<SimilarDeps["indexPawnCandidates"]>(async () => [2, 1]),
            getGamesByIds: vi.fn<SimilarDeps["getGamesByIds"]>(async () => [SUPERSET, EQUAL]),
        });
        const result = await fetchSimilar(query({ mode: "pawnsMaterial" }), d);
        expect(result.via).toBe("index");
        expect(result.rows.map((r) => r.game.id)).toEqual([1]);
        expect(result.sample).toEqual({ candidates: 2, checked: 2, verified: 1 });
        expect(d.searchPosition).not.toHaveBeenCalled();
    });
});

describe("fetchSimilar — same position", () => {
    it("reads the index, dedupes repeated games and keeps the matched ply", async () => {
        const d = deps({
            indexState: () => "ready",
            indexPosition: vi.fn<SimilarDeps["indexPosition"]>(async () => ({
                ply: 4,
                total: 3,
                moves: [
                    {
                        uci: "b1c3",
                        san: "Nc3",
                        white: 2,
                        draw: 0,
                        black: 0,
                        games: 2,
                        avg_elo: 2600,
                        last_year: 2021,
                    },
                    {
                        uci: "g1f3",
                        san: "Nf3",
                        white: 0,
                        draw: 1,
                        black: 0,
                        games: 1,
                        avg_elo: 2300,
                        last_year: 2019,
                    },
                ],
                games: [
                    { id: 1, ply: 8 },
                    { id: 1, ply: 4 },
                ],
            })),
            getGamesByIds: vi.fn<SimilarDeps["getGamesByIds"]>(async () => [EQUAL]),
        });
        const result = await fetchSimilar(query({}), d);
        expect(result.via).toBe("index");
        expect(result.approximate).toBe(false);
        expect(result.summary).toEqual({ games: 3, white: 2, draw: 1, black: 0, avgElo: 2500 });
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].ply).toBe(4);
        expect(d.getGamesByIds).toHaveBeenCalledWith(DB, [1]);
        expect(d.indexPosition).toHaveBeenCalledWith(DB, AFTER_E4_D5_EXD5_QXD5, {}, 100);
    });

    it("falls back to the exact scan beyond the index depth and applies client-only chips", async () => {
        const d = deps({
            indexState: () => "ready",
            searchPosition: vi.fn<SimilarDeps["searchPosition"]>(async () => [
                [{ move: "Qa5", white: 5, draw: 4, black: 1 }],
                [EQUAL, game({ id: 3, result: "1/2-1/2", moves: "1. e4 d5 2. exd5 Qxd5 1/2-1/2" })],
            ]),
        });
        const deep = "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 30";
        const result = await fetchSimilar(
            query({ fen: deep, filters: { ...DEFAULT_SIMILAR_FILTERS, decisiveOnly: true } }),
            d,
        );
        expect(d.indexPosition).not.toHaveBeenCalled();
        expect(result.via).toBe("scan");
        expect(result.approximate).toBe(true);
        expect(result.sample).toEqual({ candidates: 10, checked: 2, verified: 1 });
        expect(result.rows.map((r) => r.game.id)).toEqual([1]);
        expect(result.summary.games).toBe(1);
    });

    it("answers Lichess sources from the explorer API", async () => {
        const d = deps({
            lichess: vi.fn<SimilarDeps["lichess"]>(async () => ({
                white: 10,
                black: 5,
                draws: 5,
                moves: [
                    { uci: "b1c3", san: "Nc3", averageRating: 2400, white: 10, black: 5, draws: 5 },
                ],
                topGames: [],
            })),
            lichessGames: vi.fn<SimilarDeps["lichessGames"]>(async () => [
                game({ id: 0, moves: "1. e4 d5 2. exd5 Qxd5 3. Nc3 1-0" }),
            ]),
        });
        const result = await fetchSimilar(query({ source: { kind: "lichess-masters" } }), d);
        expect(result.via).toBe("lichess");
        expect(result.summary).toEqual({ games: 20, white: 10, draw: 5, black: 5, avgElo: 2400 });
        expect(result.rows[0]).toMatchObject({ ply: 4, database: null, key: "lichess#0" });
    });

    it("keeps the pawn tabs local-only", async () => {
        await expect(
            fetchSimilar(query({ mode: "pawns", source: { kind: "lichess" } }), deps({})),
        ).rejects.toThrow("Search.LocalOnly");
        expect(similarUnavailableKey({ kind: "lichess" }, "pawns")).toBe("Search.LocalOnly");
        expect(similarUnavailableKey({ kind: "lichess" }, "position")).toBeNull();
        expect(similarUnavailableKey({ kind: "chessdb" }, "position")).toBe("Sources.Unsupported");
        expect(similarUnavailableKey({ kind: "local", path: DB, title: "" }, "pawns")).toBeNull();
    });
});
