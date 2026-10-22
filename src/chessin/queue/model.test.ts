import { describe, expect, it } from "vitest";
import {
    cardDeadline,
    cardPriority,
    DEFAULT_QUEUE_SETTINGS,
    isQueueSource,
    normalizeQueueSettings,
    parseQueueSettings,
    serializeQueueSettings,
    sourceForKind,
} from "./model";

describe("queue settings", () => {
    it("defaults: 10 minutes, 15 new per day, weight 1 everywhere, catch-up factor 2", () => {
        expect(DEFAULT_QUEUE_SETTINGS).toEqual({
            minutesCap: 10,
            newPerDay: 15,
            weights: { notebook: 1, repertoire: 1, prep: 1, deviation: 1, puzzle: 1 },
            catchUpFactor: 2,
        });
        expect(parseQueueSettings(null)).toEqual(DEFAULT_QUEUE_SETTINGS);
        expect(parseQueueSettings("nope")).toEqual(DEFAULT_QUEUE_SETTINGS);
    });

    it("normalizes partial / out-of-range input: the cap stays within 5–60", () => {
        expect(normalizeQueueSettings({ minutesCap: 2 }).minutesCap).toBe(5);
        expect(normalizeQueueSettings({ minutesCap: 120 }).minutesCap).toBe(60);
        expect(normalizeQueueSettings({ minutesCap: "25" }).minutesCap).toBe(25);
        const s = normalizeQueueSettings({
            newPerDay: -3,
            weights: { prep: 2.5, bogus: 9, notebook: "0.5" },
            catchUpFactor: 0,
        });
        expect(s.newPerDay).toBe(0);
        expect(s.weights).toEqual({
            notebook: 0.5,
            repertoire: 1,
            prep: 2.5,
            deviation: 1,
            puzzle: 1,
        });
        expect(s.catchUpFactor).toBe(1);
    });

    it("round-trips through the kv JSON", () => {
        const s = normalizeQueueSettings({ minutesCap: 15, newPerDay: 5, weights: { puzzle: 0 } });
        expect(parseQueueSettings(serializeQueueSettings(s))).toEqual(s);
    });
});

describe("per-card helpers", () => {
    it("maps card kinds to sources", () => {
        expect(sourceForKind("find_move")).toBe("notebook");
        expect(sourceForKind("repertoire")).toBe("repertoire");
        expect(sourceForKind("prep")).toBe("prep");
        expect(sourceForKind("deviation")).toBe("deviation");
        expect(sourceForKind("puzzle")).toBe("puzzle");
        expect(sourceForKind("anything")).toBe("notebook");
        expect(isQueueSource("prep")).toBe(true);
        expect(isQueueSource("games")).toBe(false);
    });

    it("priorities: drop-scaled for mistakes, fixed per source, meta.priority wins", () => {
        expect(cardPriority({ meta: {} }, "notebook")).toBe(0.5);
        expect(cardPriority({ meta: { drop: 0 } }, "notebook")).toBeCloseTo(0.4, 5);
        expect(cardPriority({ meta: { drop: 1 } }, "notebook")).toBeCloseTo(1, 5);
        expect(cardPriority({ meta: { drop: 5 } }, "notebook")).toBeCloseTo(1, 5);
        expect(cardPriority({ meta: {} }, "repertoire")).toBe(0.5);
        expect(cardPriority({ meta: {} }, "prep")).toBe(0.8);
        expect(cardPriority({ meta: {} }, "deviation")).toBe(0.7);
        expect(cardPriority({ meta: {} }, "puzzle")).toBe(0.4);
        expect(cardPriority({ meta: { priority: 0.25 } }, "prep")).toBe(0.25);
        expect(cardPriority({ meta: { priority: 7 } }, "prep")).toBe(1);
    });

    it("reads the deadline leniently", () => {
        expect(cardDeadline({ meta: {} })).toBeUndefined();
        expect(cardDeadline({ meta: { deadline: 1_700_000_000_000 } })).toBe(1_700_000_000_000);
        expect(cardDeadline({ meta: { deadline: "1700000000000" } })).toBe(1_700_000_000_000);
        expect(cardDeadline({ meta: { deadline: new Date(5) } })).toBe(5);
        expect(cardDeadline({ meta: { deadline: 0 } })).toBeUndefined();
        expect(cardDeadline({ meta: { deadline: "soon" } })).toBeUndefined();
    });
});
