import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyMoment, PlyEval, Review } from "@/chessin/review/model";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getDoc,
    listDocs,
} from "@/chessin/store/libraryStore";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, treeIteratorMainLine } from "@/utils/treeReducer";
import {
    answerGuess,
    colorOfPly,
    createGuessSession,
    currentStep,
    currentTarget,
    finishSession,
    GUESS_RESULT_KIND,
    guessResultDocId,
    guessTotals,
    isFinished,
    isGuessResult,
    nextTarget,
    revealCurrent,
    revealOrNext,
    saveGuessResult,
    toGuessResult,
} from "./session";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();
// Scholar's mate: 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#
const SANS = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];
const GAME_KEY = "file:/tmp/scholar.pgn#1";

function nodes() {
    return Array.from(treeIteratorMainLine(store.getState().root)).map((x) => x.node);
}

function ply(
    index: number,
    uci: string,
    san: string,
    best: string,
    score: number,
    bestScore: number,
): PlyEval {
    const fenBefore = nodes()[index - 1].fen;
    return {
        ply: index,
        san,
        uci,
        fenBefore,
        epd: fenBefore.split(" ").slice(0, 4).join(" "),
        color: colorOfPly(index),
        score,
        bestUci: best,
        bestScore,
        winChanceDrop: 0,
        cpLoss: 0,
        depth: 20,
    };
}

/** White's review: 2. Qh5 was a real mistake (best Nf3), 3. Bc4 and 4. Qxf7# were best. */
function review(): Review {
    const plies = [
        ply(3, "d1h5", "Qh5", "g1f3", -200, 30),
        ply(5, "f1c4", "Bc4", "f1c4", 40, 40),
        ply(7, "h5f7", "Qxf7#", "h5f7", 10_000, 10_000),
    ];
    const moment: KeyMoment = {
        id: `${GAME_KEY}#3`,
        ply: 3,
        nodeId: nodes()[3].id,
        fenBefore: plies[0].fenBefore,
        playedUci: "d1h5",
        playedSan: "Qh5",
        bestUci: "g1f3",
        bestSan: "Nf3",
        bestPv: ["g1f3", "b8c6"],
        alternatives: [
            { uci: "g1f3", san: "Nf3", score: 30 },
            { uci: "d2d4", san: "d4", score: 28 },
            { uci: "d1h5", san: "Qh5", score: -200 },
        ],
        drop: 0.2,
        findability: 0.7,
        priority: 0.14,
        phase: "opening",
        kind: "blunder",
        color: "white",
        explanations: [{ id: "hanging_piece", evidence: "likely", severity: 2, params: {} }],
    };
    return {
        version: 1,
        gameKey: GAME_KEY,
        engine: "Test 1",
        depth: 20,
        createdAt: 1000,
        playerColor: "white",
        preset: "full",
        plies,
        moments: [moment],
        phases: {
            opening: { endPly: 7, loss: 2 },
            middlegame: { endPly: 7, loss: 0 },
            endgame: { endPly: 7, loss: 0 },
        },
        summary: {
            accuracy: { white: 80, black: 50 },
            cpl: { white: 60, black: 200 },
            blunders: 1,
            mistakes: 0,
            inaccuracies: 0,
            timePressureMoves: [],
        },
    };
}

beforeEach(() => {
    store.getState().setState(defaultTree());
    store.getState().makeMoves({ payload: SANS });
    __setLibraryBackendForTests(createMemoryBackend(() => 5000));
});

describe("createGuessSession", () => {
    it("walks the player's plies of the main line from `from`, with the review's engine data", () => {
        const session = createGuessSession({
            review: review(),
            tree: store.getState(),
            playerColor: "white",
            from: 3,
            now: 1234,
        });
        expect(session.targets.map((t) => t.ply)).toEqual([3, 5, 7]);
        expect(session.hasReview).toBe(true);
        expect(session.gameKey).toBe(GAME_KEY);
        expect(session.startedAt).toBe(1234);
        expect(session.finishedAt).toBeNull();

        const [qh5, bc4] = session.targets;
        expect(qh5.playedUci).toBe("d1h5");
        expect(qh5.playedSan).toBe("Qh5");
        expect(qh5.fenBefore).toBe(nodes()[2].fen);
        expect(qh5.parentPath).toEqual([0, 0]);
        expect(qh5.path).toEqual([0, 0, 0]);
        expect(qh5.nodeId).toBe(nodes()[3].id);
        expect(qh5.bestUci).toBe("g1f3");
        expect(qh5.bestSan).toBe("Nf3");
        expect(qh5.bestPv).toEqual(["g1f3", "b8c6"]);
        expect(qh5.moment?.id).toBe(`${GAME_KEY}#3`);
        expect(qh5.explanations).toHaveLength(1);
        // played first, then best, then the alternative within tolerance (d4); Qh5 itself is far worse.
        expect(qh5.answers).toEqual(["d1h5", "g1f3", "d2d4"]);

        expect(bc4.bestUci).toBe("f1c4");
        expect(bc4.answers).toEqual(["f1c4"]);
        expect(bc4.moment).toBeNull();
        expect(bc4.scores).toEqual({ afterBest: 40, afterPlayed: 40 });
    });

    it("asks about black's moves when the player is black, from the first ply by default", () => {
        const session = createGuessSession({
            tree: store.getState(),
            playerColor: "black",
        });
        expect(session.targets.map((t) => t.ply)).toEqual([2, 4, 6]);
        expect(session.targets.every((t) => t.color === "black")).toBe(true);
        expect(session.targets[0].playedSan).toBe("e5");
        expect(session.from).toBe(1);
    });

    it("falls back to played-move-only answers without a review", () => {
        const session = createGuessSession({ tree: store.getState(), playerColor: "white" });
        expect(session.hasReview).toBe(false);
        expect(session.gameKey).toBeNull();
        expect(session.targets.map((t) => t.answers)).toEqual([
            ["e2e4"],
            ["d1h5"],
            ["f1c4"],
            ["h5f7"],
        ]);
        expect(session.targets.every((t) => t.bestUci === null && t.scores === null)).toBe(true);
    });

    it("ignores review plies whose position no longer matches the tree", () => {
        const stale = review();
        stale.plies[0] = { ...stale.plies[0], fenBefore: "8/8/8/8/8/8/8/K6k w - - 0 1" };
        const session = createGuessSession({
            review: stale,
            tree: store.getState(),
            playerColor: "white",
            from: 3,
        });
        expect(session.targets[0].bestUci).toBeNull();
        expect(session.targets[0].moment).toBeNull();
        expect(session.targets[0].answers).toEqual(["d1h5"]);
        // The other plies still match, so the session counts as reviewed.
        expect(session.targets[1].bestUci).toBe("f1c4");
        expect(session.hasReview).toBe(true);
    });

    it("is finished right away when there is nothing to guess", () => {
        const session = createGuessSession({
            tree: store.getState(),
            playerColor: "white",
            from: 99,
            now: 7,
        });
        expect(session.targets).toEqual([]);
        expect(isFinished(session)).toBe(true);
        expect(session.finishedAt).toBe(7);
        expect(currentTarget(session)).toBeNull();
    });
});

describe("stepping", () => {
    function start() {
        return createGuessSession({
            review: review(),
            tree: store.getState(),
            playerColor: "white",
            from: 3,
            now: 1,
        });
    }

    it("grades the first guess, ignores later ones, and only steps on after the reveal", () => {
        let s = start();
        expect(currentStep(s)).toBeNull();
        expect(nextTarget(s)).toBe(s); // nothing revealed yet

        s = answerGuess(s, "d2d4");
        expect(currentStep(s)).toEqual({ ply: 3, guess: "d2d4", grade: 2, revealed: true });
        expect(answerGuess(s, "g1f3")).toBe(s); // one guess per target
        expect(revealCurrent(s)).toBe(s);

        s = nextTarget(s, 2);
        expect(s.index).toBe(1);
        expect(currentTarget(s)?.ply).toBe(5);
        expect(currentStep(s)).toBeNull();
    });

    it("revealing without a guess scores 0; revealOrNext reveals first and then advances", () => {
        let s = start();
        s = revealOrNext(s);
        expect(currentStep(s)).toEqual({ ply: 3, guess: null, grade: 0, revealed: true });
        s = revealOrNext(s);
        expect(s.index).toBe(1);
        expect(guessTotals(s)).toMatchObject({ answered: 1, correct: 0, points: 0 });
    });

    it("totals the points and finishes after the last target", () => {
        let s = start();
        s = nextTarget(answerGuess(s, "g1f3"), 10); // 3: best
        s = nextTarget(answerGuess(s, "a2a3"), 11); // 0: miss
        expect(isFinished(s)).toBe(false);
        s = answerGuess(s, "h5f7"); // 3: best (= played)
        expect(isFinished(s)).toBe(false);
        s = nextTarget(s, 12);
        expect(isFinished(s)).toBe(true);
        expect(s.finishedAt).toBe(12);
        expect(currentTarget(s)).toBeNull();
        expect(guessTotals(s)).toEqual({
            answered: 3,
            correct: 2,
            points: 6,
            maxSoFar: 9,
            max: 9,
            total: 3,
        });
        expect(nextTarget(s)).toBe(s);
        expect(answerGuess(s, "e2e4")).toBe(s);
    });

    it("grades the played move as 1 when the engine rates it worse", () => {
        const s = answerGuess(start(), "d1h5");
        expect(currentStep(s)?.grade).toBe(1);
        expect(guessTotals(s)).toMatchObject({ correct: 1, points: 1 });
    });

    it("stops early with what was answered", () => {
        let s = start();
        s = nextTarget(answerGuess(s, "g1f3"), 10);
        s = finishSession(s, 20);
        expect(isFinished(s)).toBe(true);
        expect(s.finishedAt).toBe(20);
        expect(s.targets).toHaveLength(1);
        expect(guessTotals(s)).toEqual({
            answered: 1,
            correct: 1,
            points: 3,
            maxSoFar: 3,
            max: 3,
            total: 1,
        });
        expect(finishSession(s, 30)).toBe(s);
    });
});

describe("results", () => {
    it("stores a guess_result document keyed by game key and finish time", async () => {
        let s = createGuessSession({
            review: review(),
            tree: store.getState(),
            playerColor: "white",
            from: 3,
            now: 1,
        });
        s = nextTarget(answerGuess(s, "g1f3"), 10);
        s = nextTarget(revealCurrent(s), 11);
        s = nextTarget(answerGuess(s, "h5f7"), 12);

        const result = await saveGuessResult(s, "Scholar · 猜着");
        expect(result).not.toBeNull();
        expect(result).toMatchObject({
            version: 1,
            gameKey: GAME_KEY,
            playerColor: "white",
            hasReview: true,
            from: 3,
            startedAt: 1,
            finishedAt: 12,
            total: 3,
            answered: 3,
            correct: 2,
            points: 6,
            max: 9,
        });
        expect(result?.steps.map((x) => [x.ply, x.guess, x.grade, x.playedUci, x.bestUci])).toEqual(
            [
                [3, "g1f3", 3, "d1h5", "g1f3"],
                [5, null, 0, "f1c4", "f1c4"],
                [7, "h5f7", 3, "h5f7", "h5f7"],
            ],
        );

        const id = guessResultDocId(GAME_KEY, 12);
        expect(id).toBe(`guess:${GAME_KEY}:12`);
        const doc = await getDoc(id);
        expect(doc?.kind).toBe(GUESS_RESULT_KIND);
        expect(doc?.origin).toBe(GAME_KEY);
        expect(doc?.title).toBe("Scholar · 猜着");
        const parsed: unknown = JSON.parse(doc?.data ?? "null");
        expect(isGuessResult(parsed)).toBe(true);
        expect((await listDocs(GUESS_RESULT_KIND)).map((m) => m.id)).toEqual([id]);
    });

    it("stores nothing without a game key or without any answered target", async () => {
        const noKey = createGuessSession({ tree: store.getState(), playerColor: "white" });
        expect(toGuessResult(answerGuess(noKey, "e2e4"))).toBeNull();
        const keyed = createGuessSession({
            tree: store.getState(),
            playerColor: "white",
            gameKey: GAME_KEY,
        });
        expect(await saveGuessResult(keyed, "x")).toBeNull();
        expect(await listDocs(GUESS_RESULT_KIND)).toEqual([]);
        expect(isGuessResult({ version: 1 })).toBe(false);
    });
});
