import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearReviewListeners, emitReviewSaved } from "@/chessin/review/events";
import type { KeyMoment, Review } from "@/chessin/review/model";
import {
    __setCardBackendForTests,
    awaitCardWrites,
    createMemoryCardBackend,
    listCards,
} from "./cards";
import {
    addCardsFromReview,
    answersForMoment,
    CARD_PRIORITY_THRESHOLD,
    cardsFromReview,
    isReviewListenerRegistered,
    registerReviewListener,
    reviewTitle,
} from "./hooks";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);

function moment(over: Partial<KeyMoment>): KeyMoment {
    return {
        id: "m1",
        ply: 1,
        fenBefore: START,
        playedUci: "a2a3",
        playedSan: "a3",
        bestUci: "e2e4",
        bestSan: "e4",
        bestPv: ["e2e4", "e7e5"],
        alternatives: [
            { uci: "e2e4", san: "e4", score: 30 },
            { uci: "d2d4", san: "d4", score: 25 },
            { uci: "a2a3", san: "a3", score: -50 },
        ],
        drop: 0.3,
        findability: 0.9,
        priority: 0.27,
        phase: "opening",
        kind: "mistake",
        color: "white",
        explanations: [
            { id: "piece_activity", evidence: "heuristic", severity: 1, params: { piece: "P" } },
        ],
        ...over,
    };
}

function review(moments: KeyMoment[], over: Partial<Review> = {}): Review {
    return {
        version: 1,
        gameKey: "database:/db/me_lichess.db3#7",
        engine: "stockfish 17",
        depth: 18,
        createdAt: T0,
        playerColor: "white",
        preset: "full",
        headers: { white: "Me", black: "Them", result: "0-1" },
        plies: [],
        moments,
        phases: {
            opening: { endPly: 10, loss: 0 },
            middlegame: { endPly: 30, loss: 0 },
            endgame: { endPly: 40, loss: 0 },
        },
        summary: {
            accuracy: { white: 80, black: 85 },
            cpl: { white: 30, black: 20 },
            blunders: 0,
            mistakes: 1,
            inaccuracies: 0,
            timePressureMoves: [],
        },
        ...over,
    };
}

beforeEach(() => {
    __setCardBackendForTests(createMemoryCardBackend());
});

afterEach(() => {
    clearReviewListeners();
});

describe("answersForMoment", () => {
    it("accepts the best move and alternatives within 0.05 expected score", () => {
        expect(answersForMoment(moment({}))).toEqual(["e2e4", "d2d4"]);
    });

    it("uses the mover's point of view for white-view scores", () => {
        const black = moment({
            fenBefore: AFTER_E4,
            color: "black",
            ply: 2,
            bestUci: "e7e5",
            bestSan: "e5",
            playedUci: "f7f6",
            alternatives: [
                { uci: "e7e5", san: "e5", score: 20 },
                { uci: "c7c5", san: "c5", score: 28 },
                { uci: "f7f6", san: "f6", score: 120 },
            ],
        });
        // For black lower is better: c5 (28) is within tolerance of e5 (20); f6 (+120) is not.
        expect(answersForMoment(black)).toEqual(["e7e5", "c7c5"]);
    });

    it("falls back to the best move alone when it is not among the alternatives", () => {
        expect(
            answersForMoment(moment({ alternatives: [{ uci: "d2d4", san: "d4", score: 25 }] })),
        ).toEqual(["e2e4"]);
        expect(answersForMoment(moment({ alternatives: undefined }))).toEqual(["e2e4"]);
    });
});

describe("cardsFromReview", () => {
    it("keeps moments with priority >= 0.25 and de-duplicates positions", () => {
        const inputs = cardsFromReview(
            review([
                moment({ id: "a", priority: 0.4 }),
                moment({ id: "b", priority: CARD_PRIORITY_THRESHOLD }),
                moment({
                    id: "c",
                    priority: 0.1,
                    fenBefore: AFTER_E4,
                    bestUci: "e7e5",
                    color: "black",
                }),
            ]),
        );
        expect(inputs).toHaveLength(1);
        const [input] = inputs;
        expect(input.epd).toBe(START_EPD);
        expect(input.answers).toEqual(["e2e4", "d2d4"]);
        expect(input.source).toEqual({
            gameKey: "database:/db/me_lichess.db3#7",
            ply: 1,
            nodeId: undefined,
        });
        expect(input.meta).toMatchObject({
            san: "e4",
            playedSan: "a3",
            playerColor: "white",
            drop: 0.3,
            explanationIds: ["piece_activity"],
            title: "Me – Them",
            momentKind: "mistake",
            momentId: "a",
        });
        expect(input.meta.explanations).toHaveLength(1);
    });

    it("derives SAN and the title when the review lacks them", () => {
        const r = review(
            [
                moment({
                    priority: 0.5,
                    bestSan: undefined as unknown as string,
                    playedSan: undefined as unknown as string,
                }),
            ],
            {
                headers: undefined,
            },
        );
        const [input] = cardsFromReview(r, { title: "Custom" });
        expect(input.meta.san).toBe("e4");
        expect(input.meta.playedSan).toBe("a3");
        expect(input.meta.title).toBe("Custom");
        expect(reviewTitle(r)).toBeUndefined();
        expect(cardsFromReview(r)[0].meta.title).toBeUndefined();
    });
});

describe("addCardsFromReview", () => {
    it("creates cards once and merges on a second run", async () => {
        const r = review([
            moment({ id: "a", priority: 0.4 }),
            moment({
                id: "b",
                priority: 0.3,
                ply: 2,
                fenBefore: AFTER_E4,
                color: "black",
                bestUci: "e7e5",
                bestSan: "e5",
                playedUci: "f7f6",
                playedSan: "f6",
                alternatives: [],
            }),
        ]);
        const first = await addCardsFromReview(r, {}, T0);
        expect(first).toMatchObject({ added: 2, updated: 0 });
        expect(first.cards.map((c) => c.id).sort()).toEqual(
            [
                `fm:${START_EPD}`,
                "fm:rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3",
            ].sort(),
        );

        const second = await addCardsFromReview(r, {}, T0 + 1000);
        expect(second).toMatchObject({ added: 0, updated: 2 });
        expect(await listCards()).toHaveLength(2);
    });

    it("registerReviewListener subscribes to saved reviews once", async () => {
        const off = registerReviewListener();
        expect(isReviewListenerRegistered()).toBe(true);
        expect(registerReviewListener()).toBe(off);

        emitReviewSaved(review([moment({ priority: 0.5 })]));
        await awaitCardWrites();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await awaitCardWrites();
        expect((await listCards()).map((c) => c.id)).toEqual([`fm:${START_EPD}`]);

        off();
        expect(isReviewListenerRegistered()).toBe(false);
        emitReviewSaved(
            review([
                moment({ priority: 0.5, fenBefore: AFTER_E4, color: "black", bestUci: "e7e5" }),
            ]),
        );
        await awaitCardWrites();
        expect(await listCards()).toHaveLength(1);
    });
});
