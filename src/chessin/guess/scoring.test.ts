import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, it } from "vitest";
import { expectedScore, type KeyMoment, type PlyEval } from "@/chessin/review/model";
import {
    acceptedMoves,
    bestExpected,
    candidatesFromReview,
    gradeGuess,
    gradeLabelKey,
    type GuessScoringTarget,
    isWithinTolerance,
    sameMove,
} from "./scoring";

const START = INITIAL_FEN;

/** Best d4 (0.55); e4 played and nearly as good (0.54); Nf3 close (0.52); a3 clearly worse (0.45). */
const reviewed: GuessScoringTarget = {
    fenBefore: START,
    playedUci: "e2e4",
    bestUci: "d2d4",
    candidates: [
        { uci: "d2d4", san: "d4", expected: 0.55 },
        { uci: "e2e4", san: "e4", expected: 0.54 },
        { uci: "g1f3", san: "Nf3", expected: 0.52 },
        { uci: "a2a3", san: "a3", expected: 0.45 },
    ],
};

/** The played move was a real mistake: a3 (0.45) against best d4 (0.55). */
const playedWorse: GuessScoringTarget = {
    ...reviewed,
    playedUci: "a2a3",
};

const unreviewed: GuessScoringTarget = {
    fenBefore: START,
    playedUci: "e2e4",
    bestUci: null,
    candidates: [],
};

describe("gradeGuess", () => {
    it("3 points for the engine's best move", () => {
        expect(gradeGuess(reviewed, "d2d4")).toBe(3);
        expect(gradeGuess(playedWorse, "d2d4")).toBe(3);
    });

    it("2 points for a move within 0.05 of the best, the played move included", () => {
        expect(gradeGuess(reviewed, "g1f3")).toBe(2);
        expect(gradeGuess(reviewed, "e2e4")).toBe(2);
        expect(isWithinTolerance(reviewed, "a2a3")).toBe(false);
    });

    it("1 point for the played move when the engine rates it worse", () => {
        expect(gradeGuess(playedWorse, "a2a3")).toBe(1);
    });

    it("0 points for a miss or for revealing without a guess", () => {
        expect(gradeGuess(reviewed, "h2h4")).toBe(0);
        expect(gradeGuess(playedWorse, "g1f3")).toBe(2);
        expect(gradeGuess(playedWorse, "h2h4")).toBe(0);
        expect(gradeGuess(reviewed, null)).toBe(0);
    });

    it("without a review only the played move scores (3 points)", () => {
        expect(gradeGuess(unreviewed, "e2e4")).toBe(3);
        expect(gradeGuess(unreviewed, "d2d4")).toBe(0);
        expect(bestExpected(unreviewed)).toBeNull();
    });

    it("compares castling in both UCI spellings", () => {
        const fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
        const target: GuessScoringTarget = {
            fenBefore: fen,
            playedUci: "e1g1",
            bestUci: "e1g1",
            candidates: [{ uci: "e1g1", san: "O-O", expected: 0.6 }],
        };
        expect(sameMove(fen, "e1g1", "e1h1")).toBe(true);
        expect(gradeGuess(target, "e1h1")).toBe(3);
        expect(gradeGuess({ ...target, bestUci: null, candidates: [] }, "e1h1")).toBe(3);
    });

    it("labels map to Guess.Grade.N keys", () => {
        expect(gradeLabelKey(3)).toBe("Guess.Grade.3");
        expect(gradeLabelKey(0)).toBe("Guess.Grade.0");
    });
});

describe("acceptedMoves", () => {
    it("lists the played move first, then best and every move within tolerance, without duplicates", () => {
        expect(acceptedMoves(reviewed)).toEqual(["e2e4", "d2d4", "g1f3"]);
        expect(acceptedMoves(playedWorse)).toEqual(["a2a3", "d2d4", "e2e4", "g1f3"]);
        expect(acceptedMoves(unreviewed)).toEqual(["e2e4"]);
    });
});

describe("candidatesFromReview", () => {
    const ply: PlyEval = {
        ply: 1,
        san: "e4",
        uci: "e2e4",
        fenBefore: START,
        epd: START,
        color: "white",
        score: 20,
        bestUci: "d2d4",
        bestScore: 35,
        winChanceDrop: 0.01,
        cpLoss: 15,
        depth: 20,
    };

    it("takes the best and played moves from the ply and the alternatives from the moment", () => {
        const moment = {
            bestUci: "d2d4",
            bestSan: "d4",
            alternatives: [
                { uci: "d2d4", san: "d4", score: 35 },
                { uci: "g1f3", san: "Nf3", score: 30 },
            ],
        } as unknown as KeyMoment;
        const out = candidatesFromReview(ply, "white", moment, () => "?");
        expect(out.map((c) => c.uci)).toEqual(["d2d4", "e2e4", "g1f3"]);
        expect(out[0].san).toBe("d4");
        expect(out[0].expected).toBeCloseTo(expectedScore(35, "white"), 6);
        expect(out[1].expected).toBeCloseTo(expectedScore(20, "white"), 6);
    });

    it("resolves SAN through the callback when the review has none, and dedupes played = best", () => {
        const same: PlyEval = { ...ply, uci: "d2d4", san: "d4" };
        const out = candidatesFromReview(same, "white", null, (uci) => `san(${uci})`);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ uci: "d2d4", san: "san(d2d4)" });
    });

    it("uses the mover's point of view for black", () => {
        const black: PlyEval = {
            ...ply,
            ply: 2,
            color: "black",
            fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            uci: "e7e5",
            san: "e5",
            bestUci: "c7c5",
            score: 40,
            bestScore: 10,
        };
        const out = candidatesFromReview(black, "black", null, () => "?");
        // A white-view +10 is better for black than +40.
        expect(out[0].expected).toBeGreaterThan(out[1].expected);
    });
});
