import { atom, getDefaultStore } from "jotai";
import {
    type Card,
    createEmptyCard,
    fixState,
    fsrs,
    generatorParameters,
    type Grade,
    type ReviewLog,
    State,
} from "ts-fsrs";
import { commands } from "@/chessin/bindings";
import { hasTauri, unwrapResult } from "@/chessin/store/libraryStore";
import { epdOf, type PlayerColor, uniqueAnswers } from "./chess";

/**
 * Mistake notebook — card storage and FSRS scheduling (contract S2-5).
 *
 * Storage goes through S2-1's `card_*` plugin commands (`cards` /
 * `card_logs` tables of library.sqlite) when they exist on the generated
 * bindings; otherwise (vitest, the browser dev server, builds before S2-1
 * lands) an in-memory backend with the same semantics is used — the same
 * pattern as `@/chessin/store/libraryStore`. Scheduling itself (ts-fsrs)
 * always runs here; Rust is storage only, so the FSRS `Card` travels as JSON
 * in the `fsrs` column and `due` is duplicated as a sortable unix-ms column.
 *
 * Card ids are stable per position: `fm:<epd>` for "find the move" cards
 * (from reviews) and `rp:<epd>` for repertoire cards migrated from the legacy
 * localStorage decks. Adding a card that already exists keeps its schedule
 * and merges answers / metadata.
 */

export type NotebookRating = 1 | 2 | 3 | 4;
export type CardKind = "find_move" | "repertoire" | (string & {});

export type CardSource = {
    /** `originToString(origin)` or `library:<docId>` (same key as reviews). */
    gameKey: string;
    /** 1-based half-move index of the move to find. */
    ply: number;
    nodeId?: string;
};

export type CardMeta = {
    /** SAN of the best move (the answer). */
    san?: string;
    /** SAN of the move actually played in the game. */
    playedSan?: string;
    /** Side to move = the side whose mistake this was. */
    playerColor?: PlayerColor | null;
    /** Expected-score drop 0..1 of the played move. */
    drop?: number;
    explanationIds?: string[];
    /** S2-4 `Explanation[]`, rendered after an attempt. */
    explanations?: unknown[];
    /** "White – Black" of the source game, for the "来自 …" line. */
    title?: string;
    momentKind?: string;
    momentId?: string;
    [key: string]: unknown;
};

export type NotebookCard = {
    id: string;
    epd: string;
    kind: CardKind;
    /** Accepted moves, standard UCI. */
    answers: string[];
    source: CardSource | null;
    /** Unix milliseconds (mirror of `fsrs.due`). */
    due: number;
    fsrs: Card;
    meta: CardMeta;
    createdAt: number;
    updatedAt: number;
};

/** Wire shape of S2-1's `CardRecord` (snake_case; i64 columns may arrive as bigint). */
export type CardRecord = {
    id: string;
    epd: string;
    kind: string;
    /** JSON array of UCI moves. */
    answer: string;
    /** JSON `CardSource` or null. */
    source: string | null;
    due: number;
    /** JSON of the ts-fsrs `Card`. */
    fsrs: string;
    /** JSON `CardMeta`. */
    meta: string;
    created_at: number;
    updated_at: number;
};

export type NotebookStats = {
    total: number;
    /** Cards with `due <= now` (new cards included). */
    due: number;
    /** Cards never graded. */
    new: number;
    reviewedToday: number;
};

export const EMPTY_STATS: NotebookStats = { total: 0, due: 0, new: 0, reviewedToday: 0 };

export const FIND_MOVE_PREFIX = "fm:";
export const REPERTOIRE_PREFIX = "rp:";

export function findMoveCardId(epd: string): string {
    return FIND_MOVE_PREFIX + epdOf(epd);
}

export function repertoireCardId(epd: string): string {
    return REPERTOIRE_PREFIX + epdOf(epd);
}

// ---------------------------------------------------------------------------
// FSRS

const params = generatorParameters({ enable_fuzz: false });
const scheduler = fsrs(params);

function toDate(value: unknown): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number" || typeof value === "string") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

function num(value: unknown, fallback: number): number {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Rebuilds a ts-fsrs `Card` from parsed JSON (dates as ISO strings). */
export function normalizeFsrsCard(input: unknown, now = Date.now()): Card {
    const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    let state: State;
    try {
        state = fixState(r.state ?? State.New);
    } catch {
        state = State.New;
    }
    const lastReview = toDate(r.last_review);
    const card: Card = {
        due: toDate(r.due) ?? new Date(now),
        stability: num(r.stability, 0),
        difficulty: num(r.difficulty, 0),
        elapsed_days: num(r.elapsed_days, 0),
        scheduled_days: num(r.scheduled_days, 0),
        reps: num(r.reps, 0),
        lapses: num(r.lapses, 0),
        state,
    };
    if (lastReview) card.last_review = lastReview;
    return card;
}

export function parseFsrsCard(raw: string | null | undefined, now = Date.now()): Card {
    if (!raw) return createEmptyCard<Card>(new Date(now));
    try {
        return normalizeFsrsCard(JSON.parse(raw), now);
    } catch {
        return createEmptyCard<Card>(new Date(now));
    }
}

export function serializeFsrsCard(card: Card): string {
    return JSON.stringify(card);
}

/** Applies a rating at `now`; returns the rescheduled card and the review log. */
export function scheduleCard(
    card: Card,
    rating: NotebookRating,
    now = Date.now(),
): { card: Card; log: ReviewLog } {
    const record = scheduler.repeat(card, new Date(now));
    const item = record[rating as Grade];
    return { card: item.card, log: item.log };
}

/** Due date of each rating, for the "重来 / 困难 / 良好 / 简单" preview. */
export function nextReviewTimes(card: Card, now = Date.now()): Record<NotebookRating, Date> {
    const record = scheduler.repeat(card, new Date(now));
    return {
        1: record[1].card.due,
        2: record[2].card.due,
        3: record[3].card.due,
        4: record[4].card.due,
    };
}

// ---------------------------------------------------------------------------
// Backend selection

export interface CardBackend {
    readonly native: boolean;
    upsert(records: CardRecord[]): Promise<void>;
    /** Due ascending; `dueBefore` null = every card. */
    list(dueBefore: number | null, limit: number): Promise<CardRecord[]>;
    get(id: string): Promise<CardRecord | null>;
    delete(id: string): Promise<void>;
    log(cardId: string, reviewedAt: number, rating: number, log: string): Promise<void>;
    stats(now: number): Promise<NotebookStats>;
}

const NATIVE_COMMANDS = [
    "cardUpsert",
    "cardList",
    "cardGet",
    "cardDelete",
    "cardLog",
    "cardStats",
] as const;

type NativeCommands = Record<
    (typeof NATIVE_COMMANDS)[number],
    (...args: unknown[]) => Promise<unknown>
>;

/** True when every `card_*` command exists on the generated bindings. */
export function hasNativeCardCommands(): boolean {
    const table = commands as unknown as Record<string, unknown>;
    return NATIVE_COMMANDS.every((name) => typeof table[name] === "function");
}

function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
    return camel in record ? record[camel] : record[snake];
}

function normalizeRecord(raw: unknown): CardRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string") return null;
    return {
        id: r.id,
        epd: String(r.epd ?? ""),
        kind: String(r.kind ?? "find_move"),
        answer: String(r.answer ?? "[]"),
        source: r.source == null ? null : String(r.source),
        due: num(r.due, 0),
        fsrs: String(r.fsrs ?? ""),
        meta: String(r.meta ?? "{}"),
        created_at: num(field(r, "createdAt", "created_at"), 0),
        updated_at: num(field(r, "updatedAt", "updated_at"), 0),
    };
}

function normalizeStats(raw: unknown): NotebookStats {
    if (!raw || typeof raw !== "object") return EMPTY_STATS;
    const r = raw as Record<string, unknown>;
    return {
        total: num(r.total, 0),
        due: num(r.due, 0),
        new: num(r.new, 0),
        reviewedToday: num(field(r, "reviewedToday", "reviewed_today"), 0),
    };
}

/**
 * Backend over the plugin commands. i64 arguments are sent as plain JSON
 * numbers (unix ms fit in 2^53 and serde accepts them for `i64`), and i64
 * results are accepted as number or bigint.
 */
function createTauriBackend(): CardBackend {
    const table = commands as unknown as NativeCommands;
    return {
        native: true,
        async upsert(records) {
            unwrapResult<unknown>(await table.cardUpsert(records));
        },
        async list(dueBefore, limit) {
            const raw = unwrapResult<unknown>(await table.cardList(dueBefore, limit));
            if (!Array.isArray(raw)) return [];
            return raw.map(normalizeRecord).filter((r): r is CardRecord => r !== null);
        },
        async get(id) {
            return normalizeRecord(unwrapResult<unknown>(await table.cardGet(id)));
        },
        async delete(id) {
            unwrapResult<unknown>(await table.cardDelete(id));
        },
        async log(cardId, reviewedAt, rating, log) {
            unwrapResult<unknown>(await table.cardLog(cardId, reviewedAt, rating, log));
        },
        async stats(now) {
            return normalizeStats(unwrapResult<unknown>(await table.cardStats(now)));
        },
    };
}

export type MemoryCardLog = { cardId: string; reviewedAt: number; rating: number; log: string };

export type MemoryCardBackend = CardBackend & {
    readonly records: Map<string, CardRecord>;
    readonly logs: MemoryCardLog[];
};

function startOfLocalDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** In-memory backend with the same semantics (tests, browser dev server, pre-S2-1 builds). */
export function createMemoryCardBackend(): MemoryCardBackend {
    const records = new Map<string, CardRecord>();
    const logs: MemoryCardLog[] = [];
    return {
        native: false,
        records,
        logs,
        async upsert(input) {
            for (const r of input) records.set(r.id, { ...r });
        },
        async list(dueBefore, limit) {
            return Array.from(records.values())
                .filter((r) => dueBefore === null || r.due <= dueBefore)
                .sort(
                    (a, b) =>
                        a.due - b.due || a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
                )
                .slice(0, Math.max(0, limit))
                .map((r) => ({ ...r }));
        },
        async get(id) {
            const r = records.get(id);
            return r ? { ...r } : null;
        },
        async delete(id) {
            records.delete(id);
        },
        async log(cardId, reviewedAt, rating, log) {
            logs.push({ cardId, reviewedAt, rating, log });
        },
        async stats(now) {
            const all = Array.from(records.values());
            const dayStart = startOfLocalDay(now);
            const reviewedToday = new Set(
                logs
                    .filter((l) => l.reviewedAt >= dayStart && l.reviewedAt <= now)
                    .map((l) => l.cardId),
            );
            let fresh = 0;
            for (const r of all) {
                if (parseFsrsCard(r.fsrs, now).reps === 0) fresh++;
            }
            return {
                total: all.length,
                due: all.filter((r) => r.due <= now).length,
                new: fresh,
                reviewedToday: reviewedToday.size,
            };
        },
    };
}

let backend: CardBackend | null = null;

function resolveBackend(): CardBackend {
    if (!backend) {
        backend =
            hasTauri() && hasNativeCardCommands()
                ? createTauriBackend()
                : createMemoryCardBackend();
    }
    return backend;
}

/** True when cards are written to library.sqlite (false on the in-memory fallback). */
export function isNotebookStoreNative(): boolean {
    return resolveBackend().native;
}

/** Test hook: replaces the backend (null restores automatic selection). */
export function __setCardBackendForTests(next: CardBackend | null): void {
    backend = next;
}

// ---------------------------------------------------------------------------
// Record <-> card

function parseAnswers(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((a): a is string => typeof a === "string");
        if (typeof parsed === "string") return [parsed];
    } catch {
        // A bare UCI string written by another client.
    }
    return raw.trim() ? [raw.trim()] : [];
}

function parseJsonObject<T extends object>(raw: string | null | undefined): T | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as T) : null;
    } catch {
        return null;
    }
}

export function recordToCard(r: CardRecord): NotebookCard {
    const card = parseFsrsCard(r.fsrs, r.due || Date.now());
    const source = parseJsonObject<CardSource>(r.source);
    return {
        id: r.id,
        epd: r.epd,
        kind: r.kind,
        answers: parseAnswers(r.answer),
        source: source && typeof source.gameKey === "string" ? source : null,
        due: r.due || card.due.getTime(),
        fsrs: card,
        meta: parseJsonObject<CardMeta>(r.meta) ?? {},
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export function cardToRecord(card: NotebookCard): CardRecord {
    return {
        id: card.id,
        epd: card.epd,
        kind: card.kind,
        answer: JSON.stringify(card.answers),
        source: card.source ? JSON.stringify(card.source) : null,
        due: card.due,
        fsrs: serializeFsrsCard(card.fsrs),
        meta: JSON.stringify(card.meta),
        created_at: card.createdAt,
        updated_at: card.updatedAt,
    };
}

// ---------------------------------------------------------------------------
// Change tracking

/** Bumped after every write; pages re-query their lists when it changes. */
export const notebookChangedAtom = atom(0);

/** Latest stats; refreshed after grading / adding / deleting. */
export const notebookStatsAtom = atom<NotebookStats>(EMPTY_STATS);

type JotaiStore = ReturnType<typeof getDefaultStore>;

export async function getNotebookStats(now = Date.now()): Promise<NotebookStats> {
    return resolveBackend().stats(now);
}

export async function refreshNotebookStats(
    now = Date.now(),
    store: JotaiStore = getDefaultStore(),
): Promise<NotebookStats> {
    const stats = await getNotebookStats(now);
    store.set(notebookStatsAtom, stats);
    return stats;
}

function markChanged(now: number): void {
    const store = getDefaultStore();
    store.set(notebookChangedAtom, (n) => n + 1);
    refreshNotebookStats(now, store).catch(() => undefined);
}

// Writes are chained so two merges of the same card never overtake each other.
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = writeChain.catch(() => undefined).then(task);
    writeChain = next;
    return next;
}

// ---------------------------------------------------------------------------
// Public API

export type AddCardInput = {
    id: string;
    epd: string;
    kind: CardKind;
    answers: string[];
    source?: CardSource | null;
    meta?: CardMeta;
    /** Existing schedule to keep (deck migration); a new card otherwise. */
    fsrs?: Card;
};

export type AddCardResult = { card: NotebookCard; created: boolean };

/**
 * Inserts a card, or merges into the existing one with the same id: the
 * existing schedule (`fsrs`, `due`, `createdAt`) and source are kept, answers
 * are unioned and `meta` is merged shallowly.
 */
export function addCard(input: AddCardInput, now = Date.now()): Promise<AddCardResult> {
    return serialized(async () => {
        const be = resolveBackend();
        const epd = epdOf(input.epd);
        const answers = uniqueAnswers(epd, input.answers);
        const existing = await be.get(input.id);
        let card: NotebookCard;
        let created: boolean;
        if (existing) {
            const prev = recordToCard(existing);
            card = {
                ...prev,
                epd: prev.epd || epd,
                kind: prev.kind || input.kind,
                answers: uniqueAnswers(epd, [...prev.answers, ...answers]),
                source: prev.source ?? input.source ?? null,
                meta: { ...prev.meta, ...(input.meta ?? {}) },
                updatedAt: now,
            };
            created = false;
        } else {
            const fsrsCard: Card = input.fsrs ?? createEmptyCard<Card>(new Date(now));
            card = {
                id: input.id,
                epd,
                kind: input.kind,
                answers,
                source: input.source ?? null,
                due: fsrsCard.due.getTime(),
                fsrs: fsrsCard,
                meta: input.meta ?? {},
                createdAt: now,
                updatedAt: now,
            };
            created = true;
        }
        await be.upsert([cardToRecord(card)]);
        markChanged(now);
        return { card, created };
    });
}

export type AddFindMoveCardInput = {
    /** FEN or EPD of the position before the mistake. */
    epd: string;
    /** Accepted moves, UCI. */
    answers: string[];
    source: CardSource;
    kind?: "find_move";
    meta: CardMeta;
};

/** `fm:<epd>` card from a review's key moment (existing cards keep their schedule). */
export function addFindMoveCard(
    input: AddFindMoveCardInput,
    now = Date.now(),
): Promise<AddCardResult> {
    const epd = epdOf(input.epd);
    return addCard(
        {
            id: findMoveCardId(epd),
            epd,
            kind: input.kind ?? "find_move",
            answers: input.answers,
            source: input.source,
            meta: input.meta,
        },
        now,
    );
}

/** Cards due at `now`, soonest first. */
export async function dueCards(now = Date.now(), limit = 50): Promise<NotebookCard[]> {
    const records = await resolveBackend().list(now, limit);
    return records.map(recordToCard);
}

export async function listCards(
    opts: { dueBefore?: number | null; limit?: number } = {},
): Promise<NotebookCard[]> {
    const records = await resolveBackend().list(opts.dueBefore ?? null, opts.limit ?? 1000);
    return records.map(recordToCard);
}

export async function getCard(id: string): Promise<NotebookCard | null> {
    const record = await resolveBackend().get(id);
    return record ? recordToCard(record) : null;
}

export function deleteCard(id: string, now = Date.now()): Promise<void> {
    return serialized(async () => {
        await resolveBackend().delete(id);
        markChanged(now);
    });
}

/** Reschedules the card with FSRS and writes a `card_logs` row. */
export function gradeCard(
    id: string,
    rating: NotebookRating,
    now = Date.now(),
): Promise<NotebookCard> {
    return serialized(async () => {
        const be = resolveBackend();
        const record = await be.get(id);
        if (!record) throw new Error(`Unknown notebook card ${id}`);
        const card = recordToCard(record);
        const { card: next, log } = scheduleCard(card.fsrs, rating, now);
        const updated: NotebookCard = {
            ...card,
            fsrs: next,
            due: next.due.getTime(),
            updatedAt: now,
        };
        await be.upsert([cardToRecord(updated)]);
        await be.log(id, now, rating, JSON.stringify(log));
        markChanged(now);
        return updated;
    });
}

/** Resolves once every queued write has settled. */
export async function awaitCardWrites(): Promise<void> {
    await writeChain.catch(() => undefined);
}
