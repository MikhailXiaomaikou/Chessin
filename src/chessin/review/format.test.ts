import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, it } from "vitest";
import { formatClock, lineToSan, moveLabel, percent } from "./format";

describe("format helpers", () => {
    it("labels moves by colour", () => {
        expect(moveLabel(1, "e4")).toBe("1. e4");
        expect(moveLabel(2, "e5")).toBe("1... e5");
        expect(moveLabel(23, "Nf3")).toBe("12. Nf3");
    });

    it("renders a UCI line as numbered SAN and stops at illegal moves", () => {
        expect(lineToSan(INITIAL_FEN, ["e2e4", "e7e5", "g1f3", "b8c6"])).toBe(
            "1. e4 e5 2. Nf3 Nc6",
        );
        expect(lineToSan(INITIAL_FEN, ["e2e4", "e7e5", "a1a8"])).toBe("1. e4 e5");
        expect(
            lineToSan("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2", [
                "g8f6",
                "b1c3",
            ]),
        ).toBe("2... Nf6 3. Nc3");
        expect(lineToSan("bad fen", ["e2e4"])).toBe("e2e4");
    });

    it("formats clocks and percentages", () => {
        expect(formatClock(65)).toBe("1:05");
        expect(formatClock(7)).toBe("0:07");
        expect(formatClock(3723)).toBe("1:02:03");
        expect(percent(0.256)).toBe("26");
        expect(percent(0.256, 1)).toBe("25.6");
    });
});
