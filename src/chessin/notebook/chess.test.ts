import { describe, expect, it } from "vitest";
import {
    epdOf,
    fenFromEpd,
    matchesAnswer,
    moveNumberLabel,
    plyFromFen,
    sanFromUci,
    sideToMove,
    uciFromSan,
    uniqueAnswers,
} from "./chess";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
/** White can castle short. */
const CASTLE = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";

describe("notebook chess helpers", () => {
    it("keys positions by EPD and rebuilds a FEN", () => {
        expect(epdOf(START)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
        expect(epdOf("  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR   w KQkq - 12 40 ")).toBe(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
        );
        expect(fenFromEpd(epdOf(AFTER_E4))).toBe(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        );
        expect(fenFromEpd(START)).toBe(START);
    });

    it("reads the side to move and the ply of a position", () => {
        expect(sideToMove(START)).toBe("white");
        expect(sideToMove(AFTER_E4)).toBe("black");
        expect(plyFromFen(START)).toBe(1);
        expect(plyFromFen(AFTER_E4)).toBe(2);
        expect(plyFromFen(CASTLE)).toBe(7);
        expect(moveNumberLabel(1)).toBe("1.");
        expect(moveNumberLabel(2)).toBe("1…");
        expect(moveNumberLabel(7)).toBe("4.");
    });

    it("converts between SAN and UCI", () => {
        expect(sanFromUci(START, "e2e4")).toBe("e4");
        expect(sanFromUci(START, "g1f3")).toBe("Nf3");
        expect(sanFromUci(CASTLE, "e1g1")).toBe("O-O");
        expect(sanFromUci(START, "e2e5")).toBeNull();
        expect(uciFromSan(START, "e4")).toBe("e2e4");
        expect(uciFromSan(START, "Nf3")).toBe("g1f3");
        expect(uciFromSan(CASTLE, "O-O")).toBe("e1g1");
        expect(uciFromSan(START, "e2e4")).toBe("e2e4");
        expect(uciFromSan(START, "Qh5")).toBeNull();
        expect(uciFromSan("not a fen", "e4")).toBeNull();
    });

    it("matches answers regardless of the castling spelling", () => {
        expect(matchesAnswer(CASTLE, "e1g1", ["e1h1"])).toBe(true);
        expect(matchesAnswer(CASTLE, "e1h1", ["e1g1"])).toBe(true);
        expect(matchesAnswer(CASTLE, "d2d3", ["e1g1"])).toBe(false);
        expect(uniqueAnswers(CASTLE, ["e1g1", "e1h1", "d2d3", " D2D3 "])).toEqual(["e1g1", "d2d3"]);
        expect(uniqueAnswers("garbage", ["a", "a", "b"])).toEqual(["a", "b"]);
    });
});
