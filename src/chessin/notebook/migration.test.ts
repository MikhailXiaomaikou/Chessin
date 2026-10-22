import { beforeEach, describe, expect, it } from "vitest";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import {
    __setCardBackendForTests,
    createMemoryCardBackend,
    getCard,
    listCards,
    type MemoryCardBackend,
} from "./cards";
import {
    DECKS_MIGRATED_KEY,
    legacyPositionToCard,
    migrateLegacyDecks,
    parseDeckKey,
    readLegacyDecks,
    type StorageLike,
} from "./migration";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const DUE = new Date(T0 + 3 * 24 * 3600 * 1000).toISOString();

function fakeStorage(entries: Record<string, string>): StorageLike {
    const keys = Object.keys(entries);
    return {
        length: keys.length,
        key: (i) => keys[i] ?? null,
        getItem: (k) => entries[k] ?? null,
    };
}

const DECK_KEY = "deck-C:\\Users\\me\\my-white-rep.pgn-0";

function deckStorage(): StorageLike {
    return fakeStorage({
        [DECK_KEY]: JSON.stringify({
            positions: [
                {
                    fen: START,
                    answer: "e4",
                    card: {
                        due: DUE,
                        stability: 4.2,
                        difficulty: 5.1,
                        elapsed_days: 1,
                        scheduled_days: 3,
                        reps: 2,
                        lapses: 0,
                        state: 2,
                        last_review: new Date(T0).toISOString(),
                    },
                },
                {
                    fen: AFTER_E4_E5,
                    answer: "Nf3",
                    card: { stability: 0, difficulty: 0, reps: 0, lapses: 0, state: 0 },
                },
                { fen: AFTER_E4, answer: "Qh5", card: { due: DUE, reps: 0, state: 0 } },
            ],
            logs: [],
        }),
        "deck-broken-1": "{not json",
        "something-else": "ignored",
    });
}

let backend: MemoryCardBackend;

beforeEach(() => {
    backend = createMemoryCardBackend();
    __setCardBackendForTests(backend);
    __setLibraryBackendForTests(createMemoryBackend());
});

describe("legacy deck migration", () => {
    it("parses deck keys with dashes in the file path", () => {
        expect(parseDeckKey(DECK_KEY)).toEqual({
            file: "C:\\Users\\me\\my-white-rep.pgn",
            game: 0,
        });
        expect(parseDeckKey("deck-/a/b.pgn-12")).toEqual({ file: "/a/b.pgn", game: 12 });
        expect(parseDeckKey("deck-nope")).toBeNull();
        expect(parseDeckKey("deck-/a.pgn-x")).toBeNull();
        expect(parseDeckKey("other-/a.pgn-1")).toBeNull();
    });

    it("reads every deck-* key and skips broken ones", () => {
        const decks = readLegacyDecks(deckStorage());
        expect(decks).toHaveLength(1);
        expect(decks[0]).toMatchObject({
            key: DECK_KEY,
            file: "C:\\Users\\me\\my-white-rep.pgn",
            game: 0,
        });
        expect(decks[0].positions).toHaveLength(3);
        expect(readLegacyDecks(null)).toEqual([]);
    });

    it("converts a position with a due date into a repertoire card that keeps its schedule", () => {
        const [deck] = readLegacyDecks(deckStorage());
        const card = legacyPositionToCard(deck.positions[0], deck, T0);
        expect(card).not.toBeNull();
        expect(card!.id).toBe("rp:rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
        expect(card!.kind).toBe("repertoire");
        expect(card!.answers).toEqual(["e2e4"]);
        expect(card!.source).toEqual({ gameKey: "file:C:\\Users\\me\\my-white-rep.pgn#0", ply: 1 });
        expect(card!.meta).toMatchObject({
            san: "e4",
            playerColor: "white",
            title: "my-white-rep",
            game: 0,
        });
        expect(card!.fsrs?.due.toISOString()).toBe(DUE);
        expect(card!.fsrs?.reps).toBe(2);
        expect(card!.fsrs?.state).toBe(2);
        expect(card!.fsrs?.last_review?.getTime()).toBe(T0);

        // No due date → not migrated; illegal answer → not migrated.
        expect(legacyPositionToCard(deck.positions[1], deck, T0)).toBeNull();
        expect(legacyPositionToCard(deck.positions[2], deck, T0)).toBeNull();
    });

    it("migrates once, records the kv flag, and leaves the deck untouched", async () => {
        const storage = deckStorage();
        const first = await migrateLegacyDecks({ storage, now: T0 });
        expect(first).toEqual({ skipped: false, decks: 1, migrated: 1, merged: 0 });
        expect(await getKv(DECKS_MIGRATED_KEY)).toBe("1");
        expect(storage.getItem(DECK_KEY)).toContain('"answer":"e4"');

        const card = await getCard("rp:rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
        expect(card?.due).toBe(new Date(DUE).getTime());
        expect(card?.fsrs.reps).toBe(2);
        expect((await listCards()).map((c) => c.kind)).toEqual(["repertoire"]);

        const second = await migrateLegacyDecks({ storage, now: T0 + 1 });
        expect(second).toEqual({ skipped: true, decks: 0, migrated: 0, merged: 0 });
        expect(backend.records.size).toBe(1);

        const forced = await migrateLegacyDecks({ storage, now: T0 + 2, force: true });
        expect(forced).toEqual({ skipped: false, decks: 1, migrated: 0, merged: 1 });
        expect((await getCard(card!.id))?.due).toBe(card!.due);
    });

    it("handles an empty or missing storage", async () => {
        expect(await migrateLegacyDecks({ storage: fakeStorage({}), now: T0 })).toEqual({
            skipped: false,
            decks: 0,
            migrated: 0,
            merged: 0,
        });
        __setLibraryBackendForTests(createMemoryBackend());
        expect(await migrateLegacyDecks({ storage: null, now: T0 })).toMatchObject({
            decks: 0,
            migrated: 0,
        });
    });
});
