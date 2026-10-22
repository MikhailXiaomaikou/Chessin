import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, it } from "vitest";
import { buildMatchQuery, fenAtPly, findMatchedPly } from "./replay";

const AFTER_E4_D5_EXD5_QXD5 = "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";

describe("findMatchedPly", () => {
    it("finds the ply of an exact position (board + side to move)", () => {
        const query = buildMatchQuery(AFTER_E4_D5_EXD5_QXD5, "position")!;
        const hit = findMatchedPly("1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 1-0", undefined, query);
        expect(hit).toEqual({
            ply: 4,
            fen: "rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3",
        });
    });

    it("matches the start position at ply 0", () => {
        const query = buildMatchQuery(INITIAL_FEN, "position")!;
        expect(findMatchedPly("1. e4 e5", "", query)?.ply).toBe(0);
    });

    it("same pawn structure: a superset candidate is rejected, an equal structure is found", () => {
        const query = buildMatchQuery(AFTER_E4_D5_EXD5_QXD5, "pawns")!;
        // Contains every query pawn (plus one on d5) but never equals it.
        expect(findMatchedPly("1. e4 d5 2. exd5 Nf6 3. c4 e6", undefined, query)).toBeNull();
        // Equal structure, other pieces elsewhere.
        const hit = findMatchedPly("1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. Nf3", undefined, query);
        expect(hit?.ply).toBe(4);
    });

    it("pawns + material also requires the same piece counts", () => {
        // Same pawn structure from ply 4 on; a pair of knights is traded on move 6.
        const trade = "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd8 4. Nf3 Nf6 5. Ne5 Nbd7 6. Nxd7 Bxd7";
        const noTrade = "1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. Nf3 Nf6 5. Bc4 c6";
        const afterTrade = fenAtPly(trade, undefined, 12)!;
        const query = buildMatchQuery(afterTrade, "pawnsMaterial")!;
        expect(findMatchedPly(trade, undefined, query)?.ply).toBe(12);
        expect(findMatchedPly(noTrade, undefined, query)).toBeNull();
        // The pawn-only query accepts both lines as soon as the structure appears.
        const pawnsOnly = buildMatchQuery(afterTrade, "pawns")!;
        expect(findMatchedPly(noTrade, undefined, pawnsOnly)?.ply).toBe(4);
    });

    it("returns null for illegal SAN or an unparsable start FEN", () => {
        const query = buildMatchQuery(AFTER_E4_D5_EXD5_QXD5, "position")!;
        expect(findMatchedPly("1. e4 e5 2. Ke2 Qh4#", undefined, query)).toBeNull();
        expect(findMatchedPly("1. e4", "garbage", query)).toBeNull();
    });

    it("replays from a custom start position", () => {
        const start = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
        const query = buildMatchQuery("4k3/8/8/8/4P3/8/8/4K3 b - - 0 1", "position")!;
        expect(findMatchedPly("1. e4 Kd7", start, query)?.ply).toBe(1);
    });
});

describe("fenAtPly", () => {
    it("returns the position after n main-line moves", () => {
        expect(fenAtPly("1. e4 e5 2. Nf3", undefined, 1)).toBe(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        );
        expect(fenAtPly("1. e4 e5 2. Nf3", undefined, 0)).toBe(INITIAL_FEN);
        expect(fenAtPly("1. e4 e5 2. Nf3", undefined, 4)).toBeNull();
    });
});
