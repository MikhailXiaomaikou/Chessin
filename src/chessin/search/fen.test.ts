import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, it } from "vitest";
import {
    mainLinePathToPly,
    materialKey,
    parseSetup,
    pawnKey,
    plyFromFen,
    positionKey,
    reduceFen,
} from "./fen";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
// Same pawns as AFTER_E4_E5, knights developed, castling gone.
const SAME_PAWNS_OTHER_PIECES = "r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w - - 4 4";

describe("plyFromFen", () => {
    it("counts plies from the fullmove number and side to move", () => {
        expect(plyFromFen(INITIAL_FEN)).toBe(0);
        expect(plyFromFen(AFTER_E4)).toBe(1);
        expect(plyFromFen(AFTER_E4_E5)).toBe(2);
        expect(plyFromFen("8/8/8/8/8/8/8/8 w - - 0 21")).toBe(40);
        expect(plyFromFen("8/8/8/8/8/8/8/8 b - - 0 21")).toBe(41);
    });

    it("tolerates missing or broken counters", () => {
        expect(plyFromFen("8/8/8/8/8/8/8/8 w - -")).toBe(0);
        expect(plyFromFen("8/8/8/8/8/8/8/8 b - - 0 x")).toBe(1);
        expect(plyFromFen("")).toBe(0);
    });
});

describe("reduceFen", () => {
    it("keeps only the pawns and clears castling / en passant", () => {
        expect(reduceFen(AFTER_E4, "pawns")).toBe("8/pppppppp/8/8/4P3/8/PPPP1PPP/8 b - - 0 1");
    });

    it("keeps the kings with `pawnsKings`", () => {
        expect(reduceFen(AFTER_E4_E5, "pawnsKings")).toBe(
            "4k3/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/4K3 w - - 0 2",
        );
    });

    it("returns null for an unparsable FEN", () => {
        expect(reduceFen("not a fen", "pawns")).toBeNull();
        expect(parseSetup("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1")).toBeNull();
    });
});

describe("structure keys", () => {
    it("pawnKey ignores pieces and side to move", () => {
        expect(pawnKey(AFTER_E4_E5)).toBe(pawnKey(SAME_PAWNS_OTHER_PIECES));
        expect(pawnKey(AFTER_E4)).not.toBe(pawnKey(AFTER_E4_E5));
    });

    it("pawnKey distinguishes colours on the same squares", () => {
        expect(pawnKey("8/8/8/8/4P3/8/8/8 w - - 0 1")).not.toBe(
            pawnKey("8/8/8/8/4p3/8/8/8 w - - 0 1"),
        );
    });

    it("materialKey counts queens, rooks, bishops and knights per colour", () => {
        expect(materialKey(INITIAL_FEN)).toBe("w1222/b1222");
        expect(
            materialKey("r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w - - 4 4"),
        ).toBe("w1222/b1222");
        expect(materialKey("4k3/8/8/8/8/8/8/R3K3 w - - 0 1")).toBe("w0100/b0000");
    });

    it("positionKey includes the side to move but not clocks or castling", () => {
        expect(positionKey(AFTER_E4)).toBe(
            positionKey("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 5 9"),
        );
        expect(positionKey(AFTER_E4)).not.toBe(
            positionKey("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1"),
        );
    });
});

describe("mainLinePathToPly", () => {
    it("is one main-line step per ply", () => {
        expect(mainLinePathToPly(0)).toEqual([]);
        expect(mainLinePathToPly(3)).toEqual([0, 0, 0]);
        expect(mainLinePathToPly(-2)).toEqual([]);
    });
});
