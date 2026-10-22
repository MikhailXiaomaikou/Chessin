import { describe, expect, it } from "vitest";
import type { DeviationDoc } from "@/chessin/deviation/detect";
import type { KeyMoment, PlyEval, Review } from "@/chessin/review/model";
import {
    detectThemes,
    exitMoveNumber,
    type GameEvidence,
    hasMidgameLoss,
    hasTimePressureMistake,
    isEarlyExit,
    isUnconvertedWin,
    keyMoments,
    midgameLossCp,
    peakScoreFor,
} from "./themes";

/** Plies with white-view scores after each move (and cp losses for the mover). */
function plies(scores: number[], losses: number[] = []): PlyEval[] {
    return scores.map((score, i) => ({
        ply: i + 1,
        san: "x",
        uci: "a1a1",
        fenBefore: "",
        epd: "",
        color: i % 2 === 0 ? "white" : "black",
        score,
        bestUci: "a1a1",
        bestScore: score,
        winChanceDrop: 0,
        cpLoss: losses[i] ?? 0,
        depth: 1,
    }));
}

function moment(ply: number, priority: number, kind: KeyMoment["kind"] = "mistake"): KeyMoment {
    return {
        id: `m${ply}`,
        ply,
        fenBefore: "",
        playedUci: "a1a1",
        playedSan: "a",
        bestUci: "a1a1",
        bestSan: "b",
        bestPv: [],
        alternatives: [],
        drop: priority,
        findability: 1,
        priority,
        phase: "middlegame",
        kind,
        color: "white",
    };
}

function review(partial: Partial<Review> = {}): Review {
    return {
        version: 1,
        gameKey: "g",
        engine: "t",
        depth: 1,
        createdAt: 0,
        playerColor: "white",
        preset: "full",
        plies: [],
        moments: [],
        phases: {
            opening: { endPly: 0, loss: 0 },
            middlegame: { endPly: 0, loss: 0 },
            endgame: { endPly: 0, loss: 0 },
        },
        summary: {
            accuracy: { white: 0, black: 0 },
            cpl: { white: 0, black: 0 },
            blunders: 0,
            mistakes: 0,
            inaccuracies: 0,
            timePressureMoves: [],
        },
        ...partial,
    };
}

function deviation(ply: number | null, kind: "mine" | "theirs" = "mine"): DeviationDoc {
    return {
        version: 1,
        gameKey: "g",
        playerColor: "white",
        createdAt: 0,
        status: "ok",
        repertoire: { path: "/r.pgn", name: "r" },
        enteredPly: 1,
        exit: { kind: ply === null ? "end" : kind, ply: ply ?? 20 },
        deviation:
            ply === null
                ? null
                : {
                      kind,
                      ply,
                      color: kind === "mine" ? "white" : "black",
                      fenBefore: "",
                      epd: "",
                      playedSan: "x",
                      playedUci: "a1a1",
                      repertoire: { path: "/r.pgn", name: "r" },
                      node: { id: "n", path: [], fen: "", epd: "" },
                  },
        dismissed: false,
        snoozed: false,
    };
}

/** Plies long enough to cover moves 30–40 with `loss` cp lost by white on each move in the window. */
function midgamePlies(loss: number, color: "white" | "black" = "white"): PlyEval[] {
    const scores = Array.from({ length: 84 }, () => 0);
    const losses = scores.map((_, i) => {
        const move = Math.ceil((i + 1) / 2);
        const mover = i % 2 === 0 ? "white" : "black";
        return mover === color && move >= 30 && move <= 40 ? loss : 0;
    });
    return plies(scores, losses);
}

describe("keyMoments", () => {
    it("keeps the three highest-priority moments in move order", () => {
        const r = review({
            moments: [moment(30, 0.5), moment(12, 0.9), moment(40, 0.1), moment(5, 0.7)],
        });
        expect(keyMoments(r).map((m) => m.ply)).toEqual([5, 12, 30]);
        expect(keyMoments(r, 1).map((m) => m.ply)).toEqual([12]);
        expect(keyMoments(null)).toEqual([]);
    });
});

describe("per-game predicates", () => {
    it("recognises early repertoire exits of either kind", () => {
        expect(exitMoveNumber(deviation(13))).toBe(7);
        expect(exitMoveNumber(deviation(null))).toBeNull();
        expect(isEarlyExit(deviation(13))).toBe(true);
        expect(isEarlyExit(deviation(14, "theirs"))).toBe(true);
        expect(isEarlyExit(deviation(15))).toBe(false);
        expect(isEarlyExit(deviation(null))).toBe(false);
        expect(isEarlyExit(null)).toBe(false);
    });

    it("sums the player's centipawn loss over moves 30–40 only", () => {
        const r = review({ plies: midgamePlies(20) });
        // 11 white moves × 20 cp = 220.
        expect(midgameLossCp(r, "white")).toBe(220);
        expect(midgameLossCp(r, "black")).toBe(0);
        expect(hasMidgameLoss(r, "white")).toBe(true);
        expect(hasMidgameLoss(review({ plies: midgamePlies(10) }), "white")).toBe(false);
        expect(hasMidgameLoss(review({ plies: midgamePlies(20, "black") }), "black")).toBe(true);
    });

    it("flags winning positions that were not won", () => {
        const r = review({ plies: plies([50, 120, 250, 180, -30, 0]) });
        expect(peakScoreFor(r, "white")).toBe(250);
        expect(peakScoreFor(r, "black")).toBe(30);
        expect(isUnconvertedWin(r, "white", "1/2-1/2")).toBe(true);
        expect(isUnconvertedWin(r, "white", "0-1")).toBe(true);
        expect(isUnconvertedWin(r, "white", "1-0")).toBe(false);
        expect(isUnconvertedWin(r, "black", "1/2-1/2")).toBe(false);
        const mate = review({ plies: plies([0, -10000]) });
        expect(isUnconvertedWin(mate, "black", "1/2-1/2")).toBe(true);
    });

    it("reads time-pressure errors from the summary", () => {
        expect(hasTimePressureMistake(review())).toBe(false);
        expect(
            hasTimePressureMistake(
                review({ summary: { ...review().summary, timePressureMoves: [41] } }),
            ),
        ).toBe(true);
    });
});

describe("detectThemes", () => {
    const evidence = (
        key: string,
        color: "white" | "black",
        result: string,
        r: Review | null,
        d: DeviationDoc | null,
    ): GameEvidence => ({ key, playerColor: color, result, review: r, deviation: d });

    it("needs at least three supporting games", () => {
        const two = [
            evidence("a", "black", "0-1", null, deviation(10)),
            evidence("b", "black", "0-1", null, deviation(12)),
        ];
        expect(detectThemes(two)).toEqual([]);
        expect(detectThemes(two, { minGames: 2 }).map((c) => c.id)).toEqual([
            "EarlyRepertoireExit:black",
        ]);
    });

    it("counts early exits per colour with the totals in the params", () => {
        const games = [
            evidence("a", "black", "0-1", null, deviation(10)),
            evidence("b", "black", "1-0", null, deviation(12, "theirs")),
            evidence("c", "black", "1/2-1/2", null, deviation(6)),
            evidence("d", "black", "0-1", null, deviation(20)),
            evidence("e", "black", "0-1", null, deviation(null)),
            evidence("f", "white", "1-0", null, deviation(4)),
        ];
        const cards = detectThemes(games);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({
            theme: "EarlyRepertoireExit",
            key: "Events.Theme.EarlyRepertoireExit",
            params: { total: 5, count: 3, move: 8, color: "black" },
            games: ["a", "b", "c"],
        });
    });

    it("builds the midgame, unconverted and time-pressure cards from reviews", () => {
        const lossy = review({ plies: midgamePlies(20) });
        const winning = review({ plies: plies([0, 300, 250]) });
        const pressure = review({ summary: { ...review().summary, timePressureMoves: [50] } });
        const games = [
            evidence("a", "white", "1/2-1/2", lossy, null),
            evidence("b", "white", "0-1", lossy, null),
            evidence("c", "white", "1-0", lossy, null),
            evidence("d", "white", "1/2-1/2", winning, null),
            evidence("e", "white", "0-1", winning, null),
            evidence("f", "white", "1-0", winning, null),
            evidence("g", "white", "1/2-1/2", winning, null),
            evidence("h", "white", "1/2-1/2", pressure, null),
            evidence("i", "white", "1/2-1/2", pressure, null),
            evidence("j", "white", "1/2-1/2", pressure, null),
            evidence("k", "white", "1/2-1/2", null, null),
        ];
        const cards = detectThemes(games);
        expect(cards.map((c) => c.theme)).toEqual([
            "MidgameLoss",
            "UnconvertedWins",
            "TimePressure",
        ]);
        expect(cards[0].params).toEqual({ count: 3, from: 30, to: 40 });
        expect(cards[0].games).toEqual(["a", "b", "c"]);
        // "f" was won: not unconverted.
        expect(cards[1]).toMatchObject({ params: { count: 3 }, games: ["d", "e", "g"] });
        expect(cards[2]).toMatchObject({ params: { count: 3 }, games: ["h", "i", "j"] });
    });

    it("uses the game's colour when the review was run for both sides", () => {
        const both = review({ playerColor: null, plies: midgamePlies(20, "black") });
        const games = [
            evidence("a", "black", "0-1", both, null),
            evidence("b", "black", "0-1", both, null),
            evidence("c", "black", "0-1", both, null),
            evidence("d", "white", "1-0", both, null),
        ];
        const [card] = detectThemes(games);
        expect(card.theme).toBe("MidgameLoss");
        expect(card.games).toEqual(["a", "b", "c"]);
    });
});
