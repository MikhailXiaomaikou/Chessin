import { type Card, createEmptyCard, State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { NotebookCard } from "@/chessin/notebook/cards";
import type { LegacyDeck } from "@/chessin/notebook/migration";
import {
    buildQueue,
    countNewGradedToday,
    DAY_MS,
    deadlineTier,
    extraPassWindow,
    itemsFromDecks,
    needsExtraPass,
    orderItems,
    overdueFactor,
    type QueueDeps,
    startOfLocalDay,
} from "./build";
import { DEFAULT_QUEUE_SETTINGS, type QueueSettings } from "./model";

// Fixed clock in local time so the day/morning windows are timezone-independent:
// Thursday 2026-10-22, 10:00.
const NOW = new Date(2026, 9, 22, 10, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
const AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -";
const EPDS = [START, AFTER_E4, AFTER_E4_E5, AFTER_NF3];

let counter = 0;

type CardOpts = {
    kind?: string;
    due?: number;
    reps?: number;
    lastReview?: number;
    meta?: NotebookCard["meta"];
    epd?: string;
    answers?: string[];
};

function card(id: string, opts: CardOpts = {}): NotebookCard {
    const due = opts.due ?? NOW - HOUR;
    const fsrs: Card = createEmptyCard<Card>(new Date(due));
    fsrs.reps = opts.reps ?? 1;
    fsrs.state = fsrs.reps === 0 ? State.New : State.Review;
    if (opts.lastReview !== undefined) fsrs.last_review = new Date(opts.lastReview);
    const epd = opts.epd ?? EPDS[counter++ % EPDS.length];
    return {
        id,
        epd,
        kind: opts.kind ?? "find_move",
        answers: opts.answers ?? ["e2e4"],
        source: { gameKey: "file:/tmp/a.pgn#0", ply: 1 },
        due,
        fsrs,
        meta: opts.meta ?? {},
        createdAt: due,
        updatedAt: due,
    };
}

function settings(overrides: Partial<QueueSettings> = {}): QueueSettings {
    return { ...DEFAULT_QUEUE_SETTINGS, ...overrides };
}

function build(deps: Partial<QueueDeps>, s: Partial<QueueSettings> = {}) {
    return buildQueue(NOW, settings(s), { cards: [], ...deps });
}

function legacyDeck(key: string, fens: { fen: string; answer: string; due: number }[]): LegacyDeck {
    return {
        key,
        file: key.slice("deck-".length, key.lastIndexOf("-")),
        game: 0,
        positions: fens.map((p) => ({
            fen: p.fen,
            answer: p.answer,
            card: { ...createEmptyCard(new Date(p.due)), reps: 1 },
        })),
    };
}

describe("buildQueue — sources", () => {
    it("pulls due notebook cards of every kind into their source", () => {
        const result = build({
            cards: [
                card("fm:a"),
                card("rp:b", { kind: "repertoire" }),
                card("prep:c", { kind: "prep" }),
                card("dev:d", { kind: "deviation" }),
                card("fm:e", { kind: "find_move", due: NOW + HOUR }), // not due
            ],
        });
        expect(result.items).toHaveLength(4);
        expect(result.bySource).toEqual({
            notebook: 1,
            repertoire: 1,
            prep: 1,
            deviation: 1,
            puzzle: 0,
        });
        expect(result.items.map((i) => i.payload.cardId).sort()).toEqual([
            "dev:d",
            "fm:a",
            "prep:c",
            "rp:b",
        ]);
    });

    it("unknown kinds count as notebook cards and carry their card in the payload", () => {
        const result = build({ cards: [card("x:1", { kind: "something_new" })] });
        expect(result.items[0].source).toBe("notebook");
        expect(result.items[0].kind).toBe("something_new");
        expect(result.items[0].payload.card.id).toBe("x:1");
        expect(result.items[0].id).toBe("nb:x:1");
    });

    it("adds due legacy deck positions, skipping positions that already have a notebook card", () => {
        const deck = legacyDeck("deck-/rep/white.pgn-0", [
            { fen: `${START} 0 1`, answer: "e4", due: NOW - DAY_MS },
            { fen: `${AFTER_E4_E5} 0 2`, answer: "Nf3", due: NOW - DAY_MS },
            { fen: `${AFTER_NF3} 0 2`, answer: "Nc6", due: NOW + DAY_MS }, // not due
        ]);
        const result = build({
            cards: [card("rp:start", { kind: "repertoire", epd: START })],
            decks: [deck],
        });
        const legacy = result.items.filter((i) => i.payload.deckKey);
        expect(legacy).toHaveLength(1);
        expect(legacy[0].id).toBe(`legacy:${AFTER_E4_E5}`);
        expect(legacy[0].source).toBe("repertoire");
        expect(legacy[0].payload.answers).toEqual(["g1f3"]);
        expect(legacy[0].payload.fen).toBe(`${AFTER_E4_E5} 0 2`);
        expect(legacy[0].payload.file).toBe("/rep/white.pgn");
        expect(legacy[0].payload.card.meta.legacyDeck).toBe("deck-/rep/white.pgn-0");
        expect(result.bySource.repertoire).toBe(2);
    });

    it("skips cold-shelf positions for repertoire items (decks and rp: cards), not for mistakes", () => {
        const deck = legacyDeck("deck-/rep/w.pgn-0", [
            { fen: `${AFTER_E4_E5} 0 2`, answer: "Nf3", due: NOW - DAY_MS },
        ]);
        const cold = new Set([AFTER_E4_E5, START]);
        const result = build({
            cards: [
                card("rp:start", { kind: "repertoire", epd: START }),
                card("fm:start", { kind: "find_move", epd: START }),
            ],
            decks: [deck],
            isCold: (epd) => cold.has(epd),
        });
        expect(result.items.map((i) => i.id)).toEqual(["nb:fm:start"]);
    });

    it("asks a position only once even when two decks contain it", () => {
        const a = legacyDeck("deck-/rep/a.pgn-0", [
            { fen: `${AFTER_E4_E5} 0 2`, answer: "Nf3", due: NOW - DAY_MS },
        ]);
        const b = legacyDeck("deck-/rep/b.pgn-0", [
            { fen: `${AFTER_E4_E5} 0 2`, answer: "Nf3", due: NOW - DAY_MS },
        ]);
        expect(itemsFromDecks([a, b], NOW, new Set())).toHaveLength(1);
    });

    it("ignores cards without answers", () => {
        expect(build({ cards: [card("fm:x", { answers: [] })] }).items).toHaveLength(0);
    });
});

describe("buildQueue — ordering", () => {
    it("ranks by priority × weight × overdue factor, highest first", () => {
        const result = build({
            cards: [
                card("fm:low", { meta: { drop: 0.1 }, due: NOW }),
                card("fm:high", { meta: { drop: 0.9 }, due: NOW }),
                card("rp:x", { kind: "repertoire", due: NOW }),
            ],
        });
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["fm:high", "rp:x", "fm:low"]);
        // Due right now → overdue factor 1: 0.4 + 0.6 × 0.9 = 0.94 for the big
        // mistake, 0.5 for the repertoire card, 0.46 for the small mistake.
        expect(result.items[0].score).toBeCloseTo(0.94, 5);
        expect(result.items[1].score).toBeCloseTo(0.5, 5);
        expect(result.items[2].score).toBeCloseTo(0.46, 5);
    });

    it("source weights change the order; a weight of 0 pushes a source to the back", () => {
        const cards = [
            card("fm:a", { meta: { drop: 0.5 } }), // 0.7
            card("rp:b", { kind: "repertoire" }), // 0.5
        ];
        const boosted = build(
            { cards },
            { weights: { ...DEFAULT_QUEUE_SETTINGS.weights, repertoire: 2 } },
        );
        expect(boosted.items.map((i) => i.payload.cardId)).toEqual(["rp:b", "fm:a"]);
        const muted = build(
            { cards },
            { weights: { ...DEFAULT_QUEUE_SETTINGS.weights, notebook: 0 } },
        );
        expect(muted.items.map((i) => i.payload.cardId)).toEqual(["rp:b", "fm:a"]);
        expect(muted.items[1].score).toBe(0);
    });

    it("overdue items climb: the factor grows from 1 to 2 over ten days and is 1 for new cards", () => {
        expect(overdueFactor(NOW, NOW, false)).toBe(1);
        expect(overdueFactor(NOW, NOW - 5 * DAY_MS, false)).toBeCloseTo(1.5, 5);
        expect(overdueFactor(NOW, NOW - 30 * DAY_MS, false)).toBe(2);
        expect(overdueFactor(NOW, NOW - 30 * DAY_MS, true)).toBe(1);
        const result = build({
            cards: [
                card("fm:fresh", { meta: { drop: 0.5 }, due: NOW - HOUR }), // 0.7
                card("fm:stale", { meta: { drop: 0.2 }, due: NOW - 10 * DAY_MS }), // 0.52 × 2
            ],
        });
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["fm:stale", "fm:fresh"]);
    });

    it("explicit meta.priority overrides the per-source default", () => {
        const result = build({
            cards: [
                card("prep:a", { kind: "prep" }), // 0.8
                card("rp:b", { kind: "repertoire", meta: { priority: 1 } }),
            ],
        });
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["rp:b", "prep:a"]);
    });

    it("ties break on the earlier due date, then the id", () => {
        const ordered = orderItems(
            build({
                cards: [
                    card("rp:b", { kind: "repertoire", due: NOW - HOUR }),
                    card("rp:a", { kind: "repertoire", due: NOW - HOUR }),
                    card("rp:c", { kind: "repertoire", due: NOW - 2 * HOUR }),
                ],
            }).items,
            settings(),
            NOW,
        );
        expect(ordered.map((i) => i.payload.cardId)).toEqual(["rp:c", "rp:a", "rp:b"]);
    });
});

describe("buildQueue — deadlines", () => {
    const saturday = new Date(2026, 9, 24, 0, 0, 0).getTime();

    it("deadlineTier is 0 within two days (today included) and 1 for later or past deadlines", () => {
        expect(deadlineTier(NOW, undefined)).toBe(1);
        expect(deadlineTier(NOW, saturday)).toBe(0); // 38 h away
        expect(deadlineTier(NOW, NOW - 2 * HOUR)).toBe(0); // earlier today still counts
        expect(deadlineTier(NOW, NOW + 3 * DAY_MS)).toBe(1);
        expect(deadlineTier(NOW, startOfLocalDay(NOW) - 1)).toBe(1); // yesterday
    });

    it("items with a deadline within two days come first, nearest deadline first, before any score", () => {
        const result = build({
            cards: [
                card("fm:big", { meta: { drop: 1 }, due: NOW - 10 * DAY_MS }), // score 2
                card("prep:sat", { kind: "prep", meta: { deadline: saturday } }),
                card("prep:fri", { kind: "prep", meta: { deadline: saturday - DAY_MS } }),
                card("prep:next", { kind: "prep", meta: { deadline: saturday + 7 * DAY_MS } }),
            ],
        });
        expect(result.items.map((i) => i.payload.cardId)).toEqual([
            "prep:fri",
            "prep:sat",
            "fm:big",
            "prep:next",
        ]);
        expect(result.items[0].deadline).toBe(saturday - DAY_MS);
    });

    it("accepts the deadline as a number, numeric string or date string", () => {
        const items = build({
            cards: [
                card("p:1", { kind: "prep", meta: { deadline: saturday } }),
                card("p:2", { kind: "prep", meta: { deadline: String(saturday) } }),
                card("p:3", { kind: "prep", meta: { deadline: "2026-10-24T00:00:00" } }),
                card("p:4", { kind: "prep", meta: { deadline: "not a date" } }),
            ],
        }).items;
        const byId = Object.fromEntries(items.map((i) => [i.payload.cardId, i.deadline]));
        expect(byId["p:1"]).toBe(saturday);
        expect(byId["p:2"]).toBe(saturday);
        expect(byId["p:3"]).toBe(saturday);
        expect(byId["p:4"]).toBeUndefined();
    });

    it("the day before the deadline is an extra-pass window, as is the morning of the deadline", () => {
        const friday10 = new Date(2026, 9, 23, 10, 0).getTime();
        const saturday9 = new Date(2026, 9, 24, 9, 0).getTime();
        const saturday14 = new Date(2026, 9, 24, 14, 0).getTime();
        expect(extraPassWindow(friday10, saturday)?.kind).toBe("eve");
        expect(extraPassWindow(saturday9, saturday)?.kind).toBe("morning");
        expect(extraPassWindow(saturday14, saturday)).toBeNull();
        expect(extraPassWindow(NOW, saturday)).toBeNull(); // Thursday: two days before
    });

    it("extra pass: prep cards not due are queued the day before / the morning of, unless graded in that window", () => {
        const friday10 = new Date(2026, 9, 23, 10, 0).getTime();
        const notDue = card("prep:a", {
            kind: "prep",
            due: friday10 + 3 * DAY_MS,
            meta: { deadline: saturday },
        });
        const gradedThisMorning = card("prep:b", {
            kind: "prep",
            due: friday10 + 3 * DAY_MS,
            lastReview: friday10 - HOUR,
            meta: { deadline: saturday },
        });
        const gradedYesterday = card("prep:c", {
            kind: "prep",
            due: friday10 + 3 * DAY_MS,
            lastReview: friday10 - DAY_MS,
            meta: { deadline: saturday },
        });
        expect(needsExtraPass(notDue, friday10)).toBe(true);
        expect(needsExtraPass(gradedThisMorning, friday10)).toBe(false);
        expect(needsExtraPass(gradedYesterday, friday10)).toBe(true);
        expect(needsExtraPass(notDue, NOW)).toBe(false); // Thursday: no window

        const result = buildQueue(friday10, settings(), {
            cards: [notDue, gradedThisMorning, gradedYesterday],
        });
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["prep:a", "prep:c"]);
        expect(result.items.every((i) => i.extraPass)).toBe(true);
        expect(result.extraPass).toBe(2);
        expect(result.overdue).toBe(0);
    });
});

describe("buildQueue — caps and estimation", () => {
    it("estimates minutes from per-source seconds and caps at minutesCap", () => {
        const cards = [
            card("fm:1"), // 20 s
            card("fm:2"), // 20 s
            card("rp:3", { kind: "repertoire" }), // 12 s
            card("prep:4", { kind: "prep" }), // 30 s
        ];
        const result = build({ cards }, { minutesCap: 10 });
        expect(result.minutes).toBe(2); // 82 s → 2 min
        expect(result.totalMinutes).toBe(2);
        expect(result.fits).toBe(4);

        const many = Array.from({ length: 25 }, (_, i) => card(`fm:${i}`)); // 500 s
        const capped = build({ cards: many }, { minutesCap: 5 });
        expect(capped.minutes).toBe(5);
        expect(capped.totalMinutes).toBe(9);
        expect(capped.fits).toBe(15); // 15 × 20 s = 300 s
        expect(capped.items).toHaveLength(25); // not catch-up: 25 ≤ 2 × 15
        expect(capped.catchUp).toBe(false);
    });

    it("learned durations replace the defaults in the estimate", () => {
        const cards = Array.from({ length: 10 }, (_, i) => card(`fm:${i}`));
        const result = build({ cards, durations: { notebook: 60 } }, { minutesCap: 5 });
        expect(result.totalMinutes).toBe(10);
        expect(result.fits).toBe(5);
    });

    it("admits new cards up to newPerDay minus those graded today, in queue order", () => {
        const cards = [
            card("fm:new1", { reps: 0, meta: { drop: 0.9 } }),
            card("fm:old", { reps: 3, meta: { drop: 0.3 } }),
            card("fm:new2", { reps: 0, meta: { drop: 0.5 } }),
            card("fm:new3", { reps: 0, meta: { drop: 0.1 } }),
        ];
        const result = build({ cards, newGradedToday: 1 }, { newPerDay: 3 });
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["fm:new1", "fm:new2", "fm:old"]);
        expect(result.newCapped).toBe(1);
        expect(result.items.filter((i) => i.isNew)).toHaveLength(2);
    });

    it("newPerDay 0 holds back every new card", () => {
        const result = build(
            { cards: [card("fm:new", { reps: 0 }), card("fm:old")] },
            { newPerDay: 0 },
        );
        expect(result.items.map((i) => i.payload.cardId)).toEqual(["fm:old"]);
        expect(result.newCapped).toBe(1);
    });

    it("catch-up mode cuts the queue to what fits and reports the dropped low-priority items", () => {
        // 15 fit in 5 minutes; 40 overdue > 2 × 15 → catch-up.
        const cards = Array.from({ length: 40 }, (_, i) =>
            card(`fm:${String(i).padStart(2, "0")}`, { meta: { drop: i / 40 } }),
        );
        const result = build({ cards }, { minutesCap: 5, catchUpFactor: 2 });
        expect(result.catchUp).toBe(true);
        expect(result.items).toHaveLength(15);
        expect(result.dropped).toBe(25);
        expect(result.overdue).toBe(40);
        expect(result.minutes).toBe(5);
        // The kept items are the highest-priority ones.
        expect(result.items[0].payload.cardId).toBe("fm:39");
        expect(result.items[14].payload.cardId).toBe("fm:25");
        expect(result.bySource.notebook).toBe(15);
        // A higher factor leaves the backlog alone.
        const relaxed = build({ cards }, { minutesCap: 5, catchUpFactor: 3 });
        expect(relaxed.catchUp).toBe(false);
        expect(relaxed.items).toHaveLength(40);
        expect(relaxed.dropped).toBe(0);
    });

    it("deadline items survive catch-up mode because they are at the front", () => {
        const saturday = new Date(2026, 9, 24, 0, 0, 0).getTime();
        const cards = Array.from({ length: 40 }, (_, i) => card(`fm:${i}`, { meta: { drop: 1 } }));
        cards.push(card("prep:x", { kind: "prep", meta: { deadline: saturday, priority: 0 } }));
        const result = build({ cards }, { minutesCap: 5, catchUpFactor: 2 });
        expect(result.catchUp).toBe(true);
        expect(result.items[0].payload.cardId).toBe("prep:x");
    });

    it("an empty library builds an empty queue", () => {
        const result = build({ cards: [] });
        expect(result.items).toEqual([]);
        expect(result.minutes).toBe(0);
        expect(result.fits).toBe(0);
        expect(result.catchUp).toBe(false);
        expect(result.bySource).toEqual({
            notebook: 0,
            repertoire: 0,
            prep: 0,
            deviation: 0,
            puzzle: 0,
        });
    });
});

describe("countNewGradedToday", () => {
    it("counts cards whose only review happened today", () => {
        const dayStart = startOfLocalDay(NOW);
        const cards = [
            card("a", { reps: 1, lastReview: dayStart + HOUR }),
            card("b", { reps: 1, lastReview: dayStart - HOUR }), // yesterday
            card("c", { reps: 2, lastReview: dayStart + HOUR }), // reviewed before
            card("d", { reps: 0 }),
        ];
        expect(countNewGradedToday(cards, NOW)).toBe(1);
    });
});
