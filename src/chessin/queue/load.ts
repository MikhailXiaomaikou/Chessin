import { listCards } from "@/chessin/notebook/cards";
import { readLegacyDecks, type StorageLike } from "@/chessin/notebook/migration";
import { isColdNode } from "@/chessin/repertoire/cold";
import { getKv, setKv } from "@/chessin/store/libraryStore";
import {
    buildQueue,
    countNewGradedToday,
    type QueueBuild,
    type QueueDeps,
    startOfLocalDay,
} from "./build";
import {
    type DurationStats,
    learnedSeconds,
    parseDurationStats,
    QUEUE_DURATIONS_KEY,
    recordDuration,
    serializeDurationStats,
} from "./estimate";
import type { QueueSettings, QueueSource } from "./model";
import { loadQueueSettings } from "./settings";

/**
 * Assembles `buildQueue`'s inputs from the stores: every notebook card, the
 * legacy practice decks in localStorage, the cold shelf, the "new cards
 * graded today" counter and the learned durations — then builds the queue.
 */

/** Library kv: `{ "day": "2026-10-22", "count": 3 }` (local day). */
export const QUEUE_NEW_TODAY_KEY = "queue.newToday";
export const CARDS_LIMIT = 5000;

/** `YYYY-MM-DD` of the local day. */
export function localDayKey(ms: number): string {
    const d = new Date(startOfLocalDay(ms));
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

type NewTodayRecord = { day: string; count: number };

function parseNewToday(raw: string | null): NewTodayRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<NewTodayRecord>;
        if (typeof parsed?.day !== "string") return null;
        const count = Number(parsed.count);
        return { day: parsed.day, count: Number.isFinite(count) ? Math.max(0, count) : 0 };
    } catch {
        return null;
    }
}

export async function readNewGradedToday(now = Date.now()): Promise<number> {
    try {
        const record = parseNewToday(await getKv(QUEUE_NEW_TODAY_KEY));
        return record && record.day === localDayKey(now) ? record.count : 0;
    } catch {
        return 0;
    }
}

// kv read-modify-writes are chained so two grades in a row never lose a count.
let kvChain: Promise<unknown> = Promise.resolve();

function chained<T>(task: () => Promise<T>): Promise<T> {
    const next = kvChain.catch(() => undefined).then(task);
    kvChain = next;
    return next;
}

/** Counts a new card graded now; returns the day's total. */
export function bumpNewGradedToday(now = Date.now(), by = 1): Promise<number> {
    return chained(async () => {
        const count = (await readNewGradedToday(now)) + by;
        await setKv(QUEUE_NEW_TODAY_KEY, JSON.stringify({ day: localDayKey(now), count }));
        return count;
    });
}

export async function loadDurationStats(): Promise<DurationStats> {
    try {
        return parseDurationStats(await getKv(QUEUE_DURATIONS_KEY));
    } catch {
        return {};
    }
}

/** Folds one measured item duration into the per-source running averages. */
export function recordItemDuration(source: QueueSource, seconds: number): Promise<void> {
    return chained(async () => {
        const stats = recordDuration(await loadDurationStats(), source, seconds);
        await setKv(QUEUE_DURATIONS_KEY, serializeDurationStats(stats));
    });
}

/** Resolves once every queued kv write has settled (tests). */
export async function awaitQueueWrites(): Promise<void> {
    await kvChain.catch(() => undefined);
}

export type LoadDepsOptions = {
    /** Legacy deck storage; `undefined` = `localStorage`, `null` = none. */
    storage?: StorageLike | null;
};

export async function loadQueueDeps(
    now = Date.now(),
    opts: LoadDepsOptions = {},
): Promise<QueueDeps> {
    const [cards, newToday, stats] = await Promise.all([
        listCards({ dueBefore: null, limit: CARDS_LIMIT }),
        readNewGradedToday(now),
        loadDurationStats(),
    ]);
    const decks = opts.storage === null ? [] : readLegacyDecks(opts.storage);
    return {
        cards,
        decks,
        isCold: (epd) => isColdNode(epd),
        newGradedToday: Math.max(newToday, countNewGradedToday(cards, now)),
        durations: learnedSeconds(stats),
    };
}

export type LoadedQueue = { build: QueueBuild; settings: QueueSettings; builtAt: number };

/** The queue as of `now`: settings from the kv, inputs from the stores. */
export async function loadQueue(
    now = Date.now(),
    opts: LoadDepsOptions = {},
): Promise<LoadedQueue> {
    const [settings, deps] = await Promise.all([loadQueueSettings(), loadQueueDeps(now, opts)]);
    return { build: buildQueue(now, settings, deps), settings, builtAt: now };
}
