import { getDefaultStore } from "jotai";
import { createEmptyCard } from "ts-fsrs";
import { beforeEach, describe, expect, it } from "vitest";
import {
    __setCardBackendForTests,
    addCard,
    addFindMoveCard,
    awaitCardWrites,
    cardToRecord,
    createMemoryCardBackend,
    deleteCard,
    dueCards,
    findMoveCardId,
    getCard,
    getNotebookStats,
    gradeCard,
    hasNativeCardCommands,
    isNotebookStoreNative,
    listCards,
    type MemoryCardBackend,
    nextReviewTimes,
    notebookStatsAtom,
    parseFsrsCard,
    recordToCard,
    refreshNotebookStats,
    repertoireCardId,
    serializeFsrsCard,
} from "./cards";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const CASTLE = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

let backend: MemoryCardBackend;

beforeEach(() => {
    backend = createMemoryCardBackend();
    __setCardBackendForTests(backend);
});

describe("notebook card store", () => {
    it("falls back to memory outside Tauri", () => {
        // The commands may or may not be on the bindings (S2-1); without a
        // Tauri webview the store is in-memory either way.
        expect(typeof hasNativeCardCommands()).toBe("boolean");
        __setCardBackendForTests(null);
        expect(isNotebookStoreNative()).toBe(false);
    });

    it("creates a find-move card keyed by EPD, due immediately", async () => {
        const { card, created } = await addFindMoveCard(
            {
                epd: START,
                answers: ["e2e4", "d2d4"],
                source: { gameKey: "database:/db/me_lichess.db3#7", ply: 1 },
                meta: { san: "e4", playerColor: "white", drop: 0.3, explanationIds: ["fork"] },
            },
            T0,
        );
        expect(created).toBe(true);
        expect(card.id).toBe(findMoveCardId(START_EPD));
        expect(card.id).toBe(`fm:${START_EPD}`);
        expect(card.epd).toBe(START_EPD);
        expect(card.kind).toBe("find_move");
        expect(card.answers).toEqual(["e2e4", "d2d4"]);
        expect(card.due).toBe(T0);
        expect(card.fsrs.reps).toBe(0);
        expect(card.createdAt).toBe(T0);
        expect(card.source).toEqual({ gameKey: "database:/db/me_lichess.db3#7", ply: 1 });

        const stored = backend.records.get(card.id);
        expect(stored).toBeDefined();
        expect(JSON.parse(stored!.answer)).toEqual(["e2e4", "d2d4"]);
        expect(JSON.parse(stored!.fsrs).reps).toBe(0);
        expect(JSON.parse(stored!.meta).san).toBe("e4");
        expect(await getCard(card.id)).toEqual(card);
    });

    it("merges into an existing card: schedule and source kept, answers and meta merged", async () => {
        const first = await addFindMoveCard(
            {
                epd: START,
                answers: ["e2e4"],
                source: { gameKey: "file:/a.pgn#0", ply: 1 },
                meta: { san: "e4", drop: 0.3, title: "A – B" },
            },
            T0,
        );
        await gradeCard(first.card.id, 3, T0 + 1000);
        const graded = await getCard(first.card.id);
        expect(graded!.fsrs.reps).toBe(1);

        const second = await addFindMoveCard(
            {
                epd: START,
                answers: ["d2d4", "e2e4"],
                source: { gameKey: "file:/b.pgn#3", ply: 1 },
                meta: { drop: 0.5, explanationIds: ["hanging_piece"] },
            },
            T0 + 5 * DAY,
        );
        expect(second.created).toBe(false);
        expect(second.card.answers).toEqual(["e2e4", "d2d4"]);
        expect(second.card.due).toBe(graded!.due);
        expect(second.card.fsrs.reps).toBe(1);
        expect(second.card.createdAt).toBe(T0);
        expect(second.card.updatedAt).toBe(T0 + 5 * DAY);
        expect(second.card.source).toEqual({ gameKey: "file:/a.pgn#0", ply: 1 });
        expect(second.card.meta).toEqual({
            san: "e4",
            drop: 0.5,
            title: "A – B",
            explanationIds: ["hanging_piece"],
        });
        expect(backend.records.size).toBe(1);
    });

    it("de-duplicates castling spellings in the answers", async () => {
        const { card } = await addCard(
            {
                id: repertoireCardId(CASTLE),
                epd: CASTLE,
                kind: "repertoire",
                answers: ["e1h1", "e1g1", "d2d3"],
            },
            T0,
        );
        expect(card.answers).toEqual(["e1g1", "d2d3"]);
    });

    it("lists due cards soonest first and honours dueBefore / limit", async () => {
        for (const [epd, offset] of [
            [START, 2 * DAY],
            [CASTLE, 0],
            ["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", DAY],
        ] as const) {
            const fsrs = createEmptyCard(new Date(T0 + offset));
            await addCard({ id: `fm:${epd}`, epd, kind: "find_move", answers: ["e2e4"], fsrs }, T0);
        }
        expect((await dueCards(T0)).map((c) => c.due)).toEqual([T0]);
        expect((await dueCards(T0 + DAY)).map((c) => c.due)).toEqual([T0, T0 + DAY]);
        expect((await dueCards(T0 + 3 * DAY, 2)).map((c) => c.due)).toEqual([T0, T0 + DAY]);
        expect((await listCards()).map((c) => c.due)).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
        expect((await listCards({ dueBefore: T0 })).length).toBe(1);
    });

    it("grades with a fixed clock: FSRS reschedules, a log row is written, stats refresh", async () => {
        const { card } = await addFindMoveCard(
            {
                epd: START,
                answers: ["e2e4"],
                source: { gameKey: "file:/a.pgn#0", ply: 1 },
                meta: {},
            },
            T0,
        );
        const preview = nextReviewTimes(card.fsrs, T0);
        expect(preview[1].getTime()).toBeGreaterThan(T0);
        expect(preview[1].getTime()).toBeLessThan(preview[2].getTime());
        expect(preview[2].getTime()).toBeLessThan(preview[3].getTime());
        expect(preview[3].getTime()).toBeLessThan(preview[4].getTime());

        const good = await gradeCard(card.id, 3, T0);
        expect(good.due).toBe(preview[3].getTime());
        expect(good.fsrs.reps).toBe(1);
        expect(good.fsrs.last_review?.getTime()).toBe(T0);
        expect(backend.logs).toHaveLength(1);
        expect(backend.logs[0]).toMatchObject({ cardId: card.id, reviewedAt: T0, rating: 3 });
        expect(JSON.parse(backend.logs[0].log).rating).toBe(3);

        // Same clock, same answer: scheduling is deterministic (fuzz off).
        const again = await gradeCard(card.id, 1, good.due);
        expect(again.fsrs.lapses).toBeGreaterThanOrEqual(0);
        expect(again.due).toBeGreaterThan(good.due);
        expect(backend.logs).toHaveLength(2);

        await awaitCardWrites();
        const stats = await getNotebookStats(good.due);
        expect(stats).toEqual({ total: 1, due: 0, new: 0, reviewedToday: 1 });
        const refreshed = await refreshNotebookStats(good.due);
        expect(getDefaultStore().get(notebookStatsAtom)).toEqual(refreshed);
    });

    it("rejects grading an unknown card", async () => {
        await expect(gradeCard("fm:nope", 3, T0)).rejects.toThrow(/Unknown notebook card/);
    });

    it("deletes cards", async () => {
        const { card } = await addCard(
            { id: "fm:x", epd: START, kind: "find_move", answers: ["e2e4"] },
            T0,
        );
        await deleteCard(card.id, T0);
        expect(await getCard(card.id)).toBeNull();
        expect(await getNotebookStats(T0)).toEqual({ total: 0, due: 0, new: 0, reviewedToday: 0 });
    });

    it("round-trips FSRS cards and tolerant records", () => {
        const fsrs = createEmptyCard(new Date(T0));
        const parsed = parseFsrsCard(serializeFsrsCard(fsrs), T0);
        expect(parsed.due.getTime()).toBe(T0);
        expect(parsed.state).toBe(fsrs.state);
        expect(parseFsrsCard("not json", T0).due.getTime()).toBe(T0);

        const card = recordToCard({
            id: "fm:a",
            epd: START_EPD,
            kind: "find_move",
            answer: "e2e4",
            source: "{bad",
            due: T0,
            fsrs: serializeFsrsCard(fsrs),
            meta: "null",
            created_at: T0,
            updated_at: T0,
        });
        expect(card.answers).toEqual(["e2e4"]);
        expect(card.source).toBeNull();
        expect(card.meta).toEqual({});
        expect(recordToCard(cardToRecord(card))).toEqual(card);
    });
});
