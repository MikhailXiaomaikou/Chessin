import { Chess, parseUci } from "chessops";
import { parseFen } from "chessops/fen";
import { describe, expect, it } from "vitest";
import { canonicalUci, isSameUci, standardUci, toStandardUci } from "./uci";

const CASTLE_FEN = "r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R w KQkq - 0 1";

function pos(fen: string): Chess {
    return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
}

describe("uci helpers", () => {
    it("treats both castling spellings as the same move", () => {
        const p = pos(CASTLE_FEN);
        expect(canonicalUci(p, "e1g1")).toBe("e1h1");
        expect(canonicalUci(p, "e1h1")).toBe("e1h1");
        expect(isSameUci(p, "e1g1", "e1h1")).toBe(true);
        expect(isSameUci(p, "e1c1", "e1a1")).toBe(true);
        expect(isSameUci(p, "e1g1", "e1c1")).toBe(false);
        expect(canonicalUci(p, "nonsense")).toBeNull();
    });

    it("prints castling the engine way", () => {
        const p = pos(CASTLE_FEN);
        expect(standardUci(p, parseUci("e1h1")!)).toBe("e1g1");
        expect(standardUci(p, parseUci("e1a1")!)).toBe("e1c1");
        expect(toStandardUci(p, "e1h1")).toBe("e1g1");
        expect(toStandardUci(p, "e1g1")).toBe("e1g1");
        expect(toStandardUci(Chess.default(), "e2e4")).toBe("e2e4");
        expect(toStandardUci(Chess.default(), "e7e8q")).toBe("e7e8q");
    });
});
