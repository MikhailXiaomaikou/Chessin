import type { NotebookCard } from "@/chessin/notebook/cards";
import type { PlayerColor } from "@/chessin/notebook/chess";

/**
 * Unified review queue (contract S4-1, teardown W5-2) — the data model.
 *
 * Everything the training flows produce (notebook "find the move" cards,
 * repertoire cards and the legacy practice decks, prep-pack cards, deviation
 * cards, example puzzles) is pulled into one queue, estimated in minutes,
 * capped per session and ordered by deadline, priority, source weight and
 * how overdue an item is. `build.ts` does the ordering; this module only
 * holds the types, the defaults and the per-card helpers it needs.
 */

export type QueueSource = "notebook" | "repertoire" | "prep" | "deviation" | "puzzle";

/** Display order of the sources ("开局体系 12、赛事失误 9、备战 8、开局偏离 0、兵形范例 0"). */
export const QUEUE_SOURCES: readonly QueueSource[] = [
    "repertoire",
    "notebook",
    "prep",
    "deviation",
    "puzzle",
];

export function isQueueSource(value: unknown): value is QueueSource {
    return typeof value === "string" && (QUEUE_SOURCES as readonly string[]).includes(value);
}

export type QueuePayload = {
    /** Notebook card id; absent for a legacy practice-deck position. */
    cardId?: string;
    /** Legacy deck position (`deck-<file>-<game>` in localStorage). */
    deckKey?: string;
    file?: string;
    game?: number;
    /** Full FEN of the legacy position (the deck keys positions by FEN). */
    fen?: string;
    epd: string;
    /** Accepted moves, standard UCI. */
    answers: string[];
    orientation: PlayerColor;
    title: string;
    /** `source.gameKey` of the card, when it has one. */
    origin?: string;
    san?: string;
    playedSan?: string;
    /** Prep cards: the opponent the pack was built for. */
    opponent?: string;
    /**
     * The card behind the item. Synthesised (never stored) for legacy deck
     * positions so the session can reuse the notebook's source line,
     * explanation rendering and grade preview unchanged.
     */
    card: NotebookCard;
};

export type QueueItem = {
    /** `nb:<card id>` or `legacy:<epd>`. */
    id: string;
    source: QueueSource;
    kind: string;
    /** Unix ms. */
    due: number;
    /** Base priority 0..1 before weighting (see `cardPriority`). */
    priority: number;
    /** 比赛日, unix ms (prep cards). */
    deadline?: number;
    /** Never graded. */
    isNew: boolean;
    /**
     * Included although not due: the day before the deadline and the morning
     * of the deadline every card of that pack gets one extra pass.
     */
    extraPass: boolean;
    /** Ordering score = priority × source weight × overdue factor. */
    score: number;
    payload: QueuePayload;
};

export type QueueSettings = {
    /** Minutes per session, 5–60. */
    minutesCap: number;
    /** New (never graded) cards admitted per local day. */
    newPerDay: number;
    /** Per-source multiplier of the priority (default 1). */
    weights: Record<QueueSource, number>;
    /** Catch-up mode when overdue items > factor × what fits in the cap. */
    catchUpFactor: number;
};

export const MINUTES_CAP_MIN = 5;
export const MINUTES_CAP_MAX = 60;
export const NEW_PER_DAY_MAX = 200;
export const WEIGHT_MAX = 5;
export const CATCH_UP_FACTOR_MIN = 1;
export const CATCH_UP_FACTOR_MAX = 10;

export const DEFAULT_WEIGHTS: Record<QueueSource, number> = {
    notebook: 1,
    repertoire: 1,
    prep: 1,
    deviation: 1,
    puzzle: 1,
};

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
    minutesCap: 10,
    newPerDay: 15,
    weights: DEFAULT_WEIGHTS,
    catchUpFactor: 2,
};

/** Library kv key of the persisted settings (JSON `QueueSettings`). */
export const QUEUE_SETTINGS_KEY = "queue.settings";

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function finite(value: unknown): number | null {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Fills missing fields with the defaults and clamps every value into its range. */
export function normalizeQueueSettings(raw: unknown): QueueSettings {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const weightsRaw = (r.weights && typeof r.weights === "object" ? r.weights : {}) as Record<
        string,
        unknown
    >;
    const weights = { ...DEFAULT_WEIGHTS };
    for (const source of QUEUE_SOURCES) {
        const w = finite(weightsRaw[source]);
        if (w !== null) weights[source] = clamp(w, 0, WEIGHT_MAX);
    }
    const cap = finite(r.minutesCap) ?? DEFAULT_QUEUE_SETTINGS.minutesCap;
    const newPerDay = finite(r.newPerDay) ?? DEFAULT_QUEUE_SETTINGS.newPerDay;
    const factor = finite(r.catchUpFactor) ?? DEFAULT_QUEUE_SETTINGS.catchUpFactor;
    return {
        minutesCap: Math.round(clamp(cap, MINUTES_CAP_MIN, MINUTES_CAP_MAX)),
        newPerDay: Math.round(clamp(newPerDay, 0, NEW_PER_DAY_MAX)),
        weights,
        catchUpFactor: clamp(factor, CATCH_UP_FACTOR_MIN, CATCH_UP_FACTOR_MAX),
    };
}

export function parseQueueSettings(json: string | null | undefined): QueueSettings {
    if (!json) return DEFAULT_QUEUE_SETTINGS;
    try {
        return normalizeQueueSettings(JSON.parse(json));
    } catch {
        return DEFAULT_QUEUE_SETTINGS;
    }
}

export function serializeQueueSettings(settings: QueueSettings): string {
    return JSON.stringify(normalizeQueueSettings(settings));
}

// ---------------------------------------------------------------------------
// Per-card helpers

/** Notebook card kind → queue source. Unknown kinds count as notebook cards. */
export function sourceForKind(kind: string): QueueSource {
    switch (kind) {
        case "repertoire":
            return "repertoire";
        case "prep":
            return "prep";
        case "deviation":
            return "deviation";
        case "puzzle":
            return "puzzle";
        default:
            return "notebook";
    }
}

/** `meta.deadline` (比赛日) as unix ms: a number, a numeric string or a parseable date. */
export function cardDeadline(card: Pick<NotebookCard, "meta">): number | undefined {
    const raw = card.meta?.deadline;
    if (raw == null || raw === "") return undefined;
    if (raw instanceof Date) {
        const t = raw.getTime();
        return Number.isFinite(t) ? t : undefined;
    }
    const n = finite(raw);
    if (n !== null) return n > 0 ? n : undefined;
    if (typeof raw === "string") {
        const t = new Date(raw).getTime();
        return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
}

/**
 * Base priority 0..1 of a card.
 *
 * `meta.priority` (0..1) wins when a producer set one. Otherwise: "find the
 * move" cards scale with the expected-score drop of the mistake
 * (0.4 + 0.6 × drop), repertoire 0.5, prep 0.8, deviation 0.7, puzzle 0.4.
 */
export function cardPriority(card: Pick<NotebookCard, "meta">, source: QueueSource): number {
    const explicit = finite(card.meta?.priority);
    if (explicit !== null) return clamp(explicit, 0, 1);
    switch (source) {
        case "notebook": {
            const drop = finite(card.meta?.drop);
            return drop === null ? 0.5 : 0.4 + 0.6 * clamp(drop, 0, 1);
        }
        case "repertoire":
            return 0.5;
        case "prep":
            return 0.8;
        case "deviation":
            return 0.7;
        case "puzzle":
            return 0.4;
    }
}

export function cardOpponent(card: Pick<NotebookCard, "meta">): string | undefined {
    const raw = card.meta?.opponent;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function emptyBySource(): Record<QueueSource, number> {
    return { notebook: 0, repertoire: 0, prep: 0, deviation: 0, puzzle: 0 };
}
