import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import {
    __setCardBackendForTests,
    addCard,
    createMemoryCardBackend,
    gradeCard,
} from "@/chessin/notebook/cards";
import type { StorageLike } from "@/chessin/notebook/migration";
import { createEmptyCard } from "ts-fsrs";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import { QUEUE_DURATIONS_KEY } from "./estimate";
import {
    awaitQueueWrites,
    bumpNewGradedToday,
    loadQueue,
    loadQueueDeps,
    localDayKey,
    QUEUE_NEW_TODAY_KEY,
    readNewGradedToday,
    recordItemDuration,
} from "./load";
import { QUEUE_SETTINGS_KEY } from "./model";
import {
    __resetQueueSettingsForTests,
    loadQueueSettings,
    queueSettingsAtom,
    saveQueueSettings,
} from "./settings";

const T0 = new Date(2026, 9, 22, 10, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";

class MemoryStorage implements StorageLike {
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

beforeEach(() => {
    __setCardBackendForTests(createMemoryCardBackend());
    __setLibraryBackendForTests(createMemoryBackend(() => T0));
    __resetQueueSettingsForTests();
});

describe("daily counters", () => {
    it("counts new cards graded per local day and forgets yesterday", async () => {
        expect(localDayKey(T0)).toBe("2026-10-22");
        expect(await readNewGradedToday(T0)).toBe(0);
        await bumpNewGradedToday(T0);
        await bumpNewGradedToday(T0 + 60_000);
        expect(await readNewGradedToday(T0 + 3600_000)).toBe(2);
        expect(await readNewGradedToday(T0 + DAY)).toBe(0);
        expect(JSON.parse((await getKv(QUEUE_NEW_TODAY_KEY))!)).toEqual({
            day: "2026-10-22",
            count: 2,
        });
    });

    it("records item durations into the kv averages", async () => {
        await recordItemDuration("notebook", 10);
        await recordItemDuration("notebook", 20);
        await awaitQueueWrites();
        expect(JSON.parse((await getKv(QUEUE_DURATIONS_KEY))!)).toEqual({
            notebook: { avg: 15, n: 2 },
        });
    });
});

describe("settings persistence", () => {
    it("loads defaults, saves to the kv and updates the atom", async () => {
        const store = createStore();
        expect((await loadQueueSettings(store)).minutesCap).toBe(10);
        await saveQueueSettings({ ...(await loadQueueSettings(store)), minutesCap: 25 }, store);
        expect(store.get(queueSettingsAtom).minutesCap).toBe(25);
        expect(JSON.parse((await getKv(QUEUE_SETTINGS_KEY))!).minutesCap).toBe(25);
        expect((await loadQueueSettings(store, true)).minutesCap).toBe(25);
    });
});

describe("loadQueue", () => {
    it("gathers notebook cards, legacy decks and the counters, then builds", async () => {
        await addCard(
            { id: "fm:x", epd: START, kind: "find_move", answers: ["e2e4"], meta: { drop: 0.5 } },
            T0 - DAY,
        );
        const { card: fresh } = await addCard(
            { id: "fm:y", epd: AFTER_E4_E5, kind: "find_move", answers: ["g1f3"] },
            T0 - DAY,
        );
        await gradeCard(fresh.id, 4, T0 - 3600_000); // graded this morning → due later
        const storage = new MemoryStorage();
        storage.setItem(
            "deck-/rep/w.pgn-0",
            JSON.stringify({
                positions: [
                    {
                        fen: `${AFTER_E4_E5} 0 2`,
                        answer: "Nf3",
                        card: createEmptyCard(new Date(T0 - DAY)),
                    },
                ],
                logs: [],
            }),
        );

        const deps = await loadQueueDeps(T0, { storage });
        expect(deps.cards).toHaveLength(2);
        expect(deps.decks).toHaveLength(1);
        expect(deps.newGradedToday).toBe(1); // derived floor: fm:y's only review was today

        const { build, settings } = await loadQueue(T0, { storage });
        expect(settings.minutesCap).toBe(10);
        // fm:x is due; fm:y is not; the deck position shares fm:y's EPD → skipped.
        expect(build.items.map((i) => i.id)).toEqual(["nb:fm:x"]);
        expect(build.bySource.notebook).toBe(1);
        expect(build.bySource.repertoire).toBe(0);
    });

    it("builds an empty queue from an empty library and no storage", async () => {
        const { build } = await loadQueue(T0, { storage: null });
        expect(build.items).toEqual([]);
        expect(build.minutes).toBe(0);
    });
});
