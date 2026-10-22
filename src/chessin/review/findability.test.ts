import { Chess, parseSquare } from "chessops";
import { parseFen } from "chessops/fen";
import { describe, expect, it } from "vitest";
import {
    describeMove,
    estimateDepthFound,
    FINDABILITY_WEIGHTS,
    gapTerm,
    obviousness,
    scoreFindability,
    shallowness,
    UNKNOWN_SHALLOWNESS,
} from "./findability";

function pos(fen: string): Chess {
    return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
}

describe("scoreFindability", () => {
    it("is 1 for a shallow recapture with no alternative", () => {
        expect(
            scoreFindability({
                gap: 1,
                depthFound: 1,
                maxDepth: 16,
                isRecapture: true,
                isCapture: true,
            }),
        ).toBe(1);
    });

    it("is 0 for a deep, unique quiet move", () => {
        expect(scoreFindability({ gap: 1, depthFound: 16, maxDepth: 16 })).toBe(0);
    });

    it("is clamped to 0..1", () => {
        for (const input of [
            { gap: 5, depthFound: -3, maxDepth: 1, isRecapture: true, isMateInOne: true },
            { gap: -1, depthFound: 100, maxDepth: 2 },
        ]) {
            const f = scoreFindability(input);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(1);
        }
    });

    it("decreases with the depth at which the move is found", () => {
        const base = { gap: 0.3, maxDepth: 20, isCapture: true };
        const shallow = scoreFindability({ ...base, depthFound: 1 });
        const mid = scoreFindability({ ...base, depthFound: 8 });
        const deep = scoreFindability({ ...base, depthFound: 20 });
        expect(shallow).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(deep);
    });

    it("a big gap helps obvious moves and hurts quiet ones", () => {
        const obvious = (gap: number) =>
            scoreFindability({ gap, depthFound: 2, maxDepth: 16, isCapture: true, isCheck: true });
        const quiet = (gap: number) => scoreFindability({ gap, depthFound: 8, maxDepth: 16 });
        expect(obvious(0.9)).toBeGreaterThan(obvious(0.1));
        expect(quiet(0.9)).toBeLessThan(quiet(0.1));
    });

    it("uses neutral terms when gap and depth are unknown", () => {
        const w = FINDABILITY_WEIGHTS;
        expect(scoreFindability({ gap: null, depthFound: null, maxDepth: 16 })).toBeCloseTo(
            w.depth * UNKNOWN_SHALLOWNESS + w.gap * 0.5,
            6,
        );
    });

    it("exposes its three terms", () => {
        expect(obviousness({ isRecapture: true })).toBe(1);
        expect(obviousness({ isCapture: true, capturesHanging: true })).toBe(1);
        expect(obviousness({ isMateInOne: true })).toBe(0.95);
        expect(obviousness({ isCapture: true, isCheck: true })).toBe(0.9);
        expect(obviousness({ isCapture: true })).toBe(0.7);
        expect(obviousness({ isCheck: true })).toBe(0.6);
        expect(obviousness({})).toBe(0);
        expect(shallowness(1, 16)).toBe(1);
        expect(shallowness(16, 16)).toBe(0);
        expect(shallowness(null, 16)).toBe(UNKNOWN_SHALLOWNESS);
        expect(gapTerm(null, 1)).toBe(0.5);
        expect(gapTerm(1, 1)).toBe(1);
        expect(gapTerm(1, 0)).toBe(0);
        expect(gapTerm(0, 0)).toBeCloseTo(0.6, 6);
    });
});

describe("describeMove", () => {
    // Scholar's mate position: white to play Qxf7#.
    const mateFen = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";

    it("sees captures, checks and mate in one", () => {
        const f = describeMove(pos(mateFen), "h5f7");
        expect(f).toEqual({
            isCapture: true,
            isCheck: true,
            isRecapture: false,
            capturesHanging: false,
            isMateInOne: true,
            isPromotion: false,
        });
    });

    it("flags quiet moves and recaptures", () => {
        const start = Chess.default();
        expect(describeMove(start, "e2e4")).toMatchObject({ isCapture: false, isCheck: false });
        // 1.e4 d5 2.exd5 Qxd5: the queen recaptures on d5.
        const p = pos("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2");
        const f = describeMove(p, "d8d5", { to: parseSquare("d5")!, capture: true });
        expect(f).toMatchObject({ isCapture: true, isRecapture: true, capturesHanging: true });
    });

    it("returns null for illegal moves", () => {
        expect(describeMove(Chess.default(), "e2e5")).toBeNull();
        expect(describeMove(Chess.default(), "zz")).toBeNull();
    });
});

describe("estimateDepthFound", () => {
    it("derives the depth from mate distance and move type", () => {
        expect(estimateDepthFound(null, 3)).toBe(5);
        expect(estimateDepthFound({ isMateInOne: true }, null)).toBe(1);
        expect(estimateDepthFound({ isRecapture: true, isCapture: true }, null)).toBe(1);
        expect(estimateDepthFound({ isCapture: true, isCheck: true }, null)).toBe(2);
        expect(estimateDepthFound({ isCapture: true }, null)).toBe(3);
        expect(estimateDepthFound({}, null)).toBeNull();
        expect(estimateDepthFound(null, null)).toBeNull();
    });
});
