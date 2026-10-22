import { clamp, type QueueItem, type QueueSource } from "./model";

/**
 * Minute estimation for the review queue (contract S4-1).
 *
 * Every item costs the average seconds of its source: 20 s "find the move",
 * 12 s repertoire, 30 s prep, 20 s deviation, 30 s puzzle by default. The
 * session measures how long each item really took and keeps a running
 * average per source in the library kv (`queue.durations`); once a source
 * has `MIN_SAMPLES` measurements its learned average replaces the default.
 * (`card_logs` rows carry the FSRS log only — no duration — so the session
 * is the only place durations can be learned from.)
 */

export const DEFAULT_SECONDS: Record<QueueSource, number> = {
    notebook: 20,
    repertoire: 12,
    prep: 30,
    deviation: 20,
    puzzle: 30,
};

/** Learned average seconds per source (sources without enough samples are absent). */
export type LearnedSeconds = Partial<Record<QueueSource, number>>;

export type DurationStats = Partial<Record<QueueSource, { avg: number; n: number }>>;

/** Library kv key of the running averages (JSON `DurationStats`). */
export const QUEUE_DURATIONS_KEY = "queue.durations";
/** Measurements before a learned average is trusted. */
export const MIN_SAMPLES = 5;
/** The average forgets slowly: the sample count saturates here. */
export const MAX_SAMPLE_WEIGHT = 50;
/** A measured duration is clamped into this range (seconds) — pauses and misclicks. */
export const DURATION_MIN_SECONDS = 3;
export const DURATION_MAX_SECONDS = 180;

export function secondsFor(source: QueueSource, learned?: LearnedSeconds): number {
    const value = learned?.[source];
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : DEFAULT_SECONDS[source];
}

export type Estimate = {
    /** Σ seconds of every item. */
    totalSeconds: number;
    /** Minutes of the whole queue, rounded up. */
    totalMinutes: number;
    /** Minutes of the session: the total capped at `capMinutes`, rounded up. */
    minutes: number;
    /** Items that fit in the cap in queue order (at least 1 when there are items). */
    fits: number;
};

export function estimateQueue(
    items: readonly Pick<QueueItem, "source">[],
    capMinutes: number,
    learned?: LearnedSeconds,
): Estimate {
    const capSeconds = Math.max(0, capMinutes) * 60;
    let totalSeconds = 0;
    let fits = 0;
    for (const item of items) {
        totalSeconds += secondsFor(item.source, learned);
        if (totalSeconds <= capSeconds) fits++;
    }
    if (items.length > 0 && fits === 0) fits = 1;
    return {
        totalSeconds,
        totalMinutes: Math.ceil(totalSeconds / 60),
        minutes: Math.ceil(Math.min(totalSeconds, capSeconds) / 60),
        fits,
    };
}

/** Folds one measured duration into the running average of its source. */
export function recordDuration(
    stats: DurationStats,
    source: QueueSource,
    seconds: number,
): DurationStats {
    if (!Number.isFinite(seconds)) return stats;
    const sample = clamp(seconds, DURATION_MIN_SECONDS, DURATION_MAX_SECONDS);
    const prev = stats[source];
    if (!prev || !(prev.n > 0)) return { ...stats, [source]: { avg: sample, n: 1 } };
    const n = Math.min(prev.n, MAX_SAMPLE_WEIGHT);
    const avg = (prev.avg * n + sample) / (n + 1);
    return { ...stats, [source]: { avg, n: prev.n + 1 } };
}

/** The averages that have enough samples to be used. */
export function learnedSeconds(stats: DurationStats): LearnedSeconds {
    const out: LearnedSeconds = {};
    for (const [source, entry] of Object.entries(stats) as [
        QueueSource,
        { avg: number; n: number } | undefined,
    ][]) {
        if (entry && entry.n >= MIN_SAMPLES && Number.isFinite(entry.avg) && entry.avg > 0) {
            out[source] = entry.avg;
        }
    }
    return out;
}

export function parseDurationStats(json: string | null | undefined): DurationStats {
    if (!json) return {};
    try {
        const raw = JSON.parse(json);
        if (!raw || typeof raw !== "object") return {};
        const out: DurationStats = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            const entry = value as { avg?: unknown; n?: unknown } | null;
            if (!entry || typeof entry !== "object") continue;
            const avg = Number(entry.avg);
            const n = Number(entry.n);
            if (!Number.isFinite(avg) || !Number.isFinite(n) || n <= 0 || avg <= 0) continue;
            if (!isSource(key)) continue;
            out[key] = { avg, n: Math.floor(n) };
        }
        return out;
    } catch {
        return {};
    }
}

function isSource(key: string): key is QueueSource {
    return key in DEFAULT_SECONDS;
}

export function serializeDurationStats(stats: DurationStats): string {
    return JSON.stringify(stats);
}

/** `mm:ss` for the session countdown (negative values clamp to `00:00`). */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
