import { createEmptyCard } from "ts-fsrs";
import { beforeEach, describe, expect, it } from "vitest";
import {
    __setCardBackendForTests,
    addCard,
    createMemoryCardBackend,
    getCard,
    type MemoryCardBackend,
} from "@/chessin/notebook/cards";
import { gradeLegacyDeckPosition, gradeQueueItem, legacyDeckOf } from "./grade";
import type { QueueItem } from "./model";

const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
const FEN = `${AFTER_E4_E5} 0 2`;
const DECK_KEY = "deck-/rep/white.pgn-0";
const T0 = new Date(2026, 9, 22, 10, 0).getTime();

class MemoryStorage {
    private map = new Map<string, string>();
    get length() {
        return this.map.size;
    }
    key(i: number) {
        return Array.from(this.map.keys())[i] ?? null;
    }
    getItem(k: string) {
        return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.map.set(k, v);
    }
}

function deckJson(due: number) {
    return JSON.stringify({
        positions: [{ fen: FEN, answer: "Nf3", card: createEmptyCard(new Date(due)) }],
        logs: [],
    });
}

let backend: MemoryCardBackend;
let storage: MemoryStorage;

beforeEach(() => {
    backend = createMemoryCardBackend();
    __setCardBackendForTests(backend);
    storage = new MemoryStorage();
    storage.setItem(DECK_KEY, deckJson(T0 - 1000));
});

describe("gradeLegacyDeckPosition", () => {
    it("reschedules the position through the practice panel's updater and appends a log", () => {
        const ok = gradeLegacyDeckPosition(DECK_KEY, AFTER_E4_E5, 3, { storage, syncAtom: false });
        expect(ok).toBe(true);
        const deck = JSON.parse(storage.getItem(DECK_KEY)!);
        expect(deck.positions[0].card.reps).toBe(1);
        expect(new Date(deck.positions[0].card.due).getTime()).toBeGreaterThan(Date.now());
        expect(deck.logs).toHaveLength(1);
        expect(deck.logs[0].fen).toBe(FEN);
        expect(deck.logs[0].rating).toBe(3);
    });

    it("returns false for an unknown deck, unknown position or broken JSON", () => {
        expect(
            gradeLegacyDeckPosition("deck-/nope.pgn-0", AFTER_E4_E5, 3, {
                storage,
                syncAtom: false,
            }),
        ).toBe(false);
        expect(
            gradeLegacyDeckPosition(DECK_KEY, "8/8/8/8/8/8/8/8 w - -", 3, {
                storage,
                syncAtom: false,
            }),
        ).toBe(false);
        storage.setItem(DECK_KEY, "{");
        expect(
            gradeLegacyDeckPosition(DECK_KEY, AFTER_E4_E5, 3, { storage, syncAtom: false }),
        ).toBe(false);
        expect(gradeLegacyDeckPosition(DECK_KEY, AFTER_E4_E5, 3, { storage: null })).toBe(false);
    });
});

describe("gradeQueueItem", () => {
    function item(payload: Partial<QueueItem["payload"]>): QueueItem {
        return {
            id: "x",
            source: "repertoire",
            kind: "repertoire",
            due: T0,
            priority: 0.5,
            isNew: true,
            extraPass: false,
            score: 0.5,
            payload: {
                epd: AFTER_E4_E5,
                answers: ["g1f3"],
                orientation: "white",
                title: "white",
                card: {} as QueueItem["payload"]["card"],
                ...payload,
            },
        };
    }

    it("grades a notebook card through gradeCard and keeps its migrated deck position in step", async () => {
        const { card } = await addCard(
            {
                id: `rp:${AFTER_E4_E5}`,
                epd: AFTER_E4_E5,
                kind: "repertoire",
                answers: ["g1f3"],
                meta: { legacyDeck: DECK_KEY, file: "/rep/white.pgn", game: 0 },
            },
            T0,
        );
        const result = await gradeQueueItem(item({ cardId: card.id, card }), 4, T0 + 60_000, {
            storage,
            syncAtom: false,
        });
        expect(result).toEqual({ notebook: true, legacy: true });
        const graded = await getCard(card.id);
        expect(graded?.fsrs.reps).toBe(1);
        expect(graded?.due).toBeGreaterThan(T0 + 60_000);
        expect(backend.logs).toHaveLength(1);
        expect(JSON.parse(storage.getItem(DECK_KEY)!).positions[0].card.reps).toBe(1);
    });

    it("grades a legacy-only item through the deck and fails when there is nothing to grade", async () => {
        const result = await gradeQueueItem(
            item({ deckKey: DECK_KEY, fen: FEN, file: "/rep/white.pgn", game: 0 }),
            2,
            T0,
            { storage, syncAtom: false },
        );
        expect(result).toEqual({ notebook: false, legacy: true });
        expect(backend.logs).toHaveLength(0);
        await expect(
            gradeQueueItem(item({ deckKey: "deck-/gone.pgn-0", fen: FEN }), 2, T0, {
                storage,
                syncAtom: false,
            }),
        ).rejects.toThrow(/nothing to grade/);
    });

    it("legacyDeckOf reads the migration's meta.legacyDeck", () => {
        expect(legacyDeckOf({ meta: { legacyDeck: DECK_KEY } })).toBe(DECK_KEY);
        expect(legacyDeckOf({ meta: { legacyDeck: "other" } })).toBeUndefined();
        expect(legacyDeckOf(undefined)).toBeUndefined();
    });
});
