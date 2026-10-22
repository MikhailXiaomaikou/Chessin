import { describe, expect, it } from "vitest";
import { getWinChance } from "@/utils/score";
import type { GapCandidate } from "./coverage";
import type { ExplorerStats } from "./explorerCache";
import { gapThreshold, MATE_CP, opponentExpectedScore, rankGaps, topReplies } from "./gaps";

function candidate(over: Partial<GapCandidate>): GapCandidate {
    return {
        nodeId: "n",
        path: [0, 0],
        fen: "fen w - - 0 1",
        epd: "fen w - -",
        halfMoves: 2,
        san: "a6",
        uci: "a7a6",
        probability: 0.1,
        games: 100,
        childFen: "child w - - 0 2",
        childEpd: "child w - -",
        inTree: false,
        ...over,
    };
}

describe("rankGaps", () => {
    it("merges the same opponent move reached through transpositions, keeping the shallowest path", () => {
        const gaps = rankGaps(
            [
                candidate({ nodeId: "deep", path: [0, 0, 0, 0], probability: 0.02, games: 10 }),
                candidate({ nodeId: "shallow", path: [0, 0], probability: 0.03, games: 30 }),
            ],
            { coverageTarget: 100, color: "white" },
        );
        expect(gaps).toHaveLength(1);
        expect(gaps[0].id).toBe("fen w - -|a7a6");
        expect(gaps[0].probability).toBeCloseTo(0.05, 9);
        expect(gaps[0].nodeId).toBe("shallow");
        expect(gaps[0].games).toBe(30);
    });

    it("drops moves below 1/coverageTarget", () => {
        const gaps = rankGaps(
            [
                candidate({ uci: "a7a6", san: "a6", probability: 0.009 }),
                candidate({ uci: "b7b5", san: "b5", probability: 0.011 }),
            ],
            { coverageTarget: 100, color: "white" },
        );
        expect(gaps.map((g) => g.san)).toEqual(["b5"]);
        expect(gapThreshold(100)).toBe(0.01);
        expect(gapThreshold(0)).toBe(0);
    });

    it("scores probability × eval loss, with 0.5 when no eval is cached", () => {
        const evals = new Map<string, number>([["child w - -", 300]]);
        const gaps = rankGaps(
            [
                candidate({ uci: "a7a6", san: "a6", probability: 0.15, childEpd: "child w - -" }),
                candidate({ uci: "b7b5", san: "b5", probability: 0.1, childEpd: "other w - -" }),
            ],
            { coverageTarget: 100, color: "white", evals },
        );
        const a6 = gaps.find((g) => g.san === "a6")!;
        const b5 = gaps.find((g) => g.san === "b5")!;
        expect(a6.evalLoss).toBeCloseTo(getWinChance(-300) / 100, 9);
        expect(a6.score).toBeCloseTo(0.15 * (getWinChance(-300) / 100), 9);
        expect(b5.evalLoss).toBeNull();
        expect(b5.score).toBeCloseTo(0.05, 9);
        // The unevaluated, less frequent gap outranks the one behind a bad opponent move.
        expect(gaps.map((g) => g.san)).toEqual(["b5", "a6"]);
    });

    it("converts mate scores and flips the point of view for a black repertoire", () => {
        expect(opponentExpectedScore({ type: "mate", value: 3 }, "black")).toBeCloseTo(
            getWinChance(MATE_CP) / 100,
            9,
        );
        expect(opponentExpectedScore({ type: "mate", value: -3 }, "white")).toBeCloseTo(
            getWinChance(MATE_CP) / 100,
            9,
        );
        expect(opponentExpectedScore(100, "black")).toBeCloseTo(getWinChance(100) / 100, 9);
        expect(opponentExpectedScore(100, "white")).toBeCloseTo(getWinChance(-100) / 100, 9);
    });

    it("orders by score, then probability, then depth", () => {
        const gaps = rankGaps(
            [
                candidate({ uci: "a7a6", san: "a6", probability: 0.2, path: [0, 0, 0, 0] }),
                candidate({ uci: "b7b5", san: "b5", probability: 0.2, path: [0, 0] }),
                candidate({ uci: "c7c5", san: "c5", probability: 0.3 }),
            ],
            { coverageTarget: 10, color: "white" },
        );
        expect(gaps.map((g) => g.san)).toEqual(["c5", "b5", "a6"]);
    });
});

describe("topReplies", () => {
    const stats: ExplorerStats = {
        white: 0,
        draws: 0,
        black: 0,
        moves: [
            { san: "Nf3", uci: "g1f3", white: 50, draws: 30, black: 20 },
            { san: "Nc3", uci: "b1c3", white: 10, draws: 10, black: 30 },
            { san: "d4", uci: "d2d4", white: 5, draws: 0, black: 5 },
            { san: "h4", uci: "h2h4", white: 0, draws: 0, black: 0 },
        ],
    };

    it("returns the most played replies with the user's score", () => {
        const replies = topReplies(stats, "white", 3);
        expect(replies.map((r) => r.san)).toEqual(["Nf3", "Nc3", "d4"]);
        expect(replies[0].games).toBe(100);
        expect(replies[0].share).toBeCloseTo(100 / 160, 9);
        expect(replies[0].userScore).toBeCloseTo(0.65, 9);
        expect(topReplies(stats, "black", 2).map((r) => r.userScore)).toEqual([0.35, 0.7]);
        expect(topReplies(stats, "white", 2)).toHaveLength(2);
    });
});
