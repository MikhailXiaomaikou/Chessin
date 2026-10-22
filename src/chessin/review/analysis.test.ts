import { Chess } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { makeUci } from "chessops";
import { describe, expect, it } from "vitest";
import type { MoveAnalysis } from "@/bindings";
import { buildReview, explainInputFor, phaseAt, type ReviewPosition } from "./analysis";
import { BLUNDER_DROP, MATE_CP, MISTAKE_DROP } from "./model";

const SCHOLAR = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];

/** Positions of a SAN move list from the initial position (default: scholar's mate). */
function game(sans: string[] = SCHOLAR, clocks: (number | undefined)[] = []): ReviewPosition[] {
    const pos = Chess.default();
    const out: ReviewPosition[] = [
        { fen: makeFen(pos.toSetup()), san: null, uci: null, nodeId: "n0" },
    ];
    sans.forEach((san, i) => {
        const move = parseSan(pos, san)!;
        const uci = makeUci(move);
        const s = makeSan(pos, move);
        pos.play(move);
        out.push({
            fen: makeFen(pos.toSetup()),
            san: s,
            uci,
            nodeId: `n${i + 1}`,
            clock: clocks[i],
        });
    });
    return out;
}

function scholarsMate(clocks: (number | undefined)[] = []): ReviewPosition[] {
    return game(SCHOLAR, clocks);
}

function line(
    uci: string,
    cp: number | { mate: number },
    depth = 12,
    san?: string,
    pv: string[] = [uci],
): MoveAnalysis["best"][number] {
    return {
        depth,
        score: {
            value:
                typeof cp === "number"
                    ? { type: "cp", value: cp }
                    : { type: "mate", value: cp.mate },
            wdl: null,
        },
        uciMoves: pv,
        sanMoves: san ? [san] : [],
        multipv: 1,
        nodes: 0,
        nps: 0,
    };
}

function analysis(best: MoveAnalysis["best"]): MoveAnalysis {
    return { best, novelty: false, is_sacrifice: false };
}

/** Synthetic evaluations (white's view) for the seven non-terminal positions. */
const EVALS: (MoveAnalysis | undefined)[] = [
    analysis([line("e2e4", 30), line("d2d4", 28)]), // start
    analysis([line("e7e5", 30), line("c7c5", 25)]), // after e4
    analysis([line("g1f3", 35), line("d8h5", 10)]), // after e5 (Qh5 is second best)
    analysis([line("g8f6", 10), line("b8c6", 130)]), // after Qh5: Nc6 is a mistake
    analysis([line("b1c3", 130), line("f1c4", 20)]), // after Nc6: Bc4 is an inaccuracy
    analysis([line("g7g6", 20), line("d8e7", 40)]), // after Bc4: Nf6?? loses
    analysis([line("h5f7", { mate: 1 }, 12, "Qxf7#", ["h5f7"]), line("c4f7", 300)]), // after Nf6
    undefined, // checkmate: not analysed
];

const base = {
    gameKey: "test:scholar",
    engine: "Test 1.0",
    depth: 12,
    preset: "full" as const,
    createdAt: 1,
    headers: { white: "A", black: "B", result: "1-0" },
};

describe("buildReview", () => {
    it("evaluates every ply and derives terminal scores", () => {
        const review = buildReview({
            ...base,
            playerColor: null,
            positions: scholarsMate(),
            analysis: EVALS,
        });
        expect(review.plies).toHaveLength(7);
        expect(review.plies[0]).toMatchObject({
            ply: 1,
            san: "e4",
            uci: "e2e4",
            color: "white",
            bestUci: "e2e4",
        });
        expect(review.plies[6]).toMatchObject({
            ply: 7,
            san: "Qxf7#",
            score: MATE_CP,
            bestScore: MATE_CP,
        });
        expect(review.plies[5].score).toBe(MATE_CP);
        expect(review.plies[5].winChanceDrop).toBeGreaterThan(BLUNDER_DROP);
        expect(review.plies[3].winChanceDrop).toBeGreaterThan(MISTAKE_DROP);
        expect(review.plies[3].winChanceDrop).toBeLessThan(BLUNDER_DROP);
        expect(review.plies[0].epd).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    });

    it("ranks key moments by drop × findability", () => {
        const review = buildReview({
            ...base,
            playerColor: "black",
            positions: scholarsMate(),
            analysis: EVALS,
        });
        expect(review.moments.map((m) => m.ply)).toEqual([6, 4]);
        const [blunder, mistake] = review.moments;
        expect(blunder).toMatchObject({
            kind: "blunder",
            color: "black",
            playedSan: "Nf6",
            playedUci: "g8f6",
            bestUci: "g7g6",
            bestSan: "g6",
            bestPv: ["g7g6"],
            nodeId: "n6",
            phase: "opening",
        });
        // A quiet defensive move with an unknown depth: moderately findable.
        expect(blunder.findability).toBeGreaterThan(0.2);
        expect(blunder.findability).toBeLessThan(0.4);
        expect(blunder.priority).toBeCloseTo(blunder.drop * blunder.findability, 3);
        expect(mistake).toMatchObject({ kind: "mistake", playedSan: "Nc6", bestUci: "g8f6" });
        expect(mistake.priority).toBeLessThan(blunder.priority);
        expect(mistake.alternatives).toEqual([{ uci: "b8c6", san: "Nc6", score: 130 }]);
        for (const m of review.moments) {
            expect(m.findability).toBeGreaterThanOrEqual(0);
            expect(m.findability).toBeLessThanOrEqual(1);
        }
    });

    it("an obvious best move is more findable and card-worthy", () => {
        // 4.Nf3?? instead of 4.Qxf7#: capture + check + mate in one was missed.
        const positions = game([...SCHOLAR.slice(0, 6), "Nf3"]);
        const evals = EVALS.slice(0, 7).concat([
            analysis([line("f6h5", -900), line("d7d5", -300)]),
        ]);
        const review = buildReview({ ...base, playerColor: "white", positions, analysis: evals });
        expect(review.moments).toHaveLength(1);
        const missed = review.moments[0];
        expect(missed).toMatchObject({
            ply: 7,
            kind: "missed_win",
            playedSan: "Nf3",
            bestUci: "h5f7",
            bestSan: "Qxf7#",
        });
        expect(missed.findability).toBeGreaterThan(0.7);
        expect(missed.priority).toBeGreaterThan(0.25);
        expect(review.summary.blunders).toBe(1);
    });

    it("only reviews the chosen colour and counts its errors", () => {
        const review = buildReview({
            ...base,
            playerColor: "white",
            positions: scholarsMate(),
            analysis: EVALS,
        });
        expect(review.moments).toEqual([]);
        expect(review.summary.blunders).toBe(0);
        expect(review.summary.mistakes).toBe(0);
        const black = buildReview({
            ...base,
            playerColor: "black",
            positions: scholarsMate(),
            analysis: EVALS,
        });
        expect(review.summary.inaccuracies).toBe(1);
        expect(black.summary).toMatchObject({ blunders: 1, mistakes: 1, inaccuracies: 0 });
        expect(black.summary.accuracy.white).toBeGreaterThan(black.summary.accuracy.black);
        expect(black.summary.cpl.black).toBeGreaterThan(black.summary.cpl.white);
        expect(black.phases.opening.loss).toBeCloseTo(11.0, 1);
        expect(black.phases.opening.endPly).toBe(7);
    });

    it("blunder check keeps only moments at or above the blunder threshold", () => {
        const review = buildReview({
            ...base,
            preset: "blunder_check",
            playerColor: null,
            positions: scholarsMate(),
            analysis: EVALS,
        });
        expect(review.preset).toBe("blunder_check");
        expect(review.moments.map((m) => m.ply)).toEqual([6]);
    });

    it("marks time pressure", () => {
        const clocks = [300, 300, 290, 280, 280, 5, 270];
        const review = buildReview({
            ...base,
            playerColor: "black",
            positions: scholarsMate(clocks),
            analysis: EVALS,
        });
        expect(review.summary.timePressureMoves).toEqual([6]);
        expect(review.moments[0].clock).toBe(5);
        expect(review.moments[0].kind).toBe("blunder");
    });

    it("classifies missed wins and found only moves", () => {
        const positions = scholarsMate().slice(0, 6); // up to 3.Bc4
        const evals: (MoveAnalysis | undefined)[] = [
            analysis([line("e2e4", 30)]),
            analysis([line("e7e5", 30)]),
            analysis([line("g1f3", 35)]),
            analysis([line("b8c6", 30), line("g8f6", 400)]), // Nc6 is black's only move
            analysis([line("b1c3", 400), line("f1c4", 50)]), // white had a win, Bc4 throws it
            analysis([line("g7g6", 50)]),
        ];
        const review = buildReview({ ...base, playerColor: null, positions, analysis: evals });
        expect(review.moments.map((m) => [m.ply, m.kind])).toEqual([
            [5, "missed_win"],
            [4, "only_move"],
        ]);
        const only = review.moments[1];
        expect(only.drop).toBe(0);
        expect(only.priority).toBeGreaterThan(0);
        expect(only.priority).toBeLessThan(review.moments[0].priority);
        expect(review.summary).toMatchObject({ blunders: 1, mistakes: 0, inaccuracies: 0 });
    });

    it("never flags the engine's own best move", () => {
        const positions = scholarsMate().slice(0, 3);
        // Inconsistent evals across positions (horizon effect): e5 was best but the eval moved.
        const evals = [
            analysis([line("e2e4", 30)]),
            analysis([line("e7e5", 30)]),
            analysis([line("g1f3", 300)]),
        ];
        const review = buildReview({ ...base, playerColor: "black", positions, analysis: evals });
        expect(review.moments).toEqual([]);
        expect(review.plies[1]).toMatchObject({ winChanceDrop: 0, cpLoss: 0 });
        expect(
            review.summary.blunders + review.summary.mistakes + review.summary.inaccuracies,
        ).toBe(0);
    });

    it("phases follow the Lichess divider", () => {
        expect(phaseAt(0, null, null)).toBe("opening");
        expect(phaseAt(10, 8, null)).toBe("middlegame");
        expect(phaseAt(40, 8, 30)).toBe("endgame");
        expect(phaseAt(5, 8, 30)).toBe("opening");
    });

    it("builds explain inputs from the mover's point of view", () => {
        const review = buildReview({
            ...base,
            playerColor: "black",
            positions: scholarsMate(),
            analysis: EVALS,
        });
        const input = explainInputFor(review.moments[0], review.plies);
        expect(input).toMatchObject({
            playedUci: "g8f6",
            bestUci: "g7g6",
            playerColor: "black",
            scoreBefore: -20,
            scoreAfterPlayed: -MATE_CP,
            scoreAfterBest: -20,
        });
    });
});
