import type { NotebookCard } from "@/chessin/notebook/cards";
import { epdOf, sideToMove } from "@/chessin/notebook/chess";
import { type LegacyDeck, legacyPositionToCard } from "@/chessin/notebook/migration";
import { type Estimate, estimateQueue, type LearnedSeconds } from "./estimate";
import {
    cardDeadline,
    cardOpponent,
    cardPriority,
    emptyBySource,
    type QueueItem,
    type QueueSettings,
    type QueueSource,
    sourceForKind,
} from "./model";

/**
 * Builds the unified review queue (contract S4-1). Pure: every input comes
 * through `deps`, the clock is `now`.
 *
 * Sources
 * - notebook cards of every kind (`find_move` → notebook, `repertoire`,
 *   `prep` (S4-2, `meta.deadline` = 比赛日), `deviation` (S4-3), `puzzle`);
 * - legacy practice decks (`deck-*` in localStorage, read the way the
 *   migration reads them) — positions whose EPD already has a notebook card
 *   are skipped (the migration created `rp:` cards for them, and grading an
 *   `rp:` card also updates its deck position, see `grade.ts`); cold-shelf
 *   positions (`isColdNode`) are skipped for every repertoire item.
 *
 * Ordering
 * 1. deadline tier: items whose deadline is within `DEADLINE_WINDOW_MS`
 *    (2 days, and not already past) come first, nearest deadline first;
 * 2. then `score = priority × weight[source] × overdueFactor`, highest first,
 *    where the overdue factor grows linearly from 1 (due now) to 2 (10+ days
 *    overdue) and is 1 for never-graded cards;
 * 3. ties: earlier due, then id.
 * The day before a deadline and the morning of the deadline (local time,
 * before noon) every card of that pack gets one extra pass: it is queued
 * even when not due, flagged `extraPass`, unless it was already graded
 * inside that window.
 *
 * Caps
 * - new (never graded) cards are admitted up to `newPerDay − newGradedToday`
 *   in queue order; the rest wait (`newCapped`);
 * - the estimate (`estimate.ts`) tells how many items fit in `minutesCap`;
 * - catch-up mode when the overdue count exceeds `catchUpFactor × fits`:
 *   the queue is cut to what fits and the lowest-scoring remainder is
 *   reported as `dropped` instead of being carried as a backlog.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEADLINE_WINDOW_MS = 2 * DAY_MS;
/** The morning of the deadline ends here (hours after local midnight). */
export const MORNING_END_HOURS = 12;
/** Overdue factor saturates at 2 after this many days. */
export const OVERDUE_SATURATION_DAYS = 10;

export type QueueDeps = {
    /** Every notebook card (due or not; `buildQueue` filters). */
    cards: readonly NotebookCard[];
    /** Legacy practice decks (`readLegacyDecks()`); default none. */
    decks?: readonly LegacyDeck[];
    /** Cold-shelf predicate by EPD (`isColdNode`); default none cold. */
    isCold?: (epd: string) => boolean;
    /** New cards already graded today (local day); default 0. */
    newGradedToday?: number;
    /** Learned seconds per source (`learnedSeconds`). */
    durations?: LearnedSeconds;
};

export type QueueBuild = {
    items: QueueItem[];
    /** Session minutes: the estimate of `items`, capped at `minutesCap`. */
    minutes: number;
    /** Minutes of the whole queue, uncapped. */
    totalMinutes: number;
    bySource: Record<QueueSource, number>;
    catchUp: boolean;
    /** Items set aside by catch-up mode (lowest scores). */
    dropped: number;
    /** New cards held back by the daily cap. */
    newCapped: number;
    /** Items that fit in the cap. */
    fits: number;
    /** Items that were due (before any cut). */
    overdue: number;
    /** Items included by the pre-deadline extra pass. */
    extraPass: number;
};

export function startOfLocalDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Days between the local days of `a` and `b` (`b` after `a` is positive). */
export function localDayDiff(a: number, b: number): number {
    return Math.round((startOfLocalDay(b) - startOfLocalDay(a)) / DAY_MS);
}

/** 0 for an upcoming deadline within two days (today included), 1 otherwise. */
export function deadlineTier(now: number, deadline: number | undefined): 0 | 1 {
    if (deadline === undefined) return 1;
    if (deadline < startOfLocalDay(now)) return 1;
    return deadline - now <= DEADLINE_WINDOW_MS ? 0 : 1;
}

export type ExtraPassWindow = { kind: "eve" | "morning"; start: number; end: number };

/** The extra-pass window that contains `now`, if any: the day before, or the morning of, the deadline. */
export function extraPassWindow(now: number, deadline: number): ExtraPassWindow | null {
    const dayStart = startOfLocalDay(deadline);
    const eve: ExtraPassWindow = { kind: "eve", start: dayStart - DAY_MS, end: dayStart };
    const morning: ExtraPassWindow = {
        kind: "morning",
        start: dayStart,
        end: dayStart + MORNING_END_HOURS * 60 * 60 * 1000,
    };
    if (now >= eve.start && now < eve.end) return eve;
    if (now >= morning.start && now < morning.end) return morning;
    return null;
}

export function overdueFactor(now: number, due: number, isNew: boolean): number {
    if (isNew) return 1;
    const days = Math.max(0, (now - due) / DAY_MS);
    return 1 + Math.min(days, OVERDUE_SATURATION_DAYS) / OVERDUE_SATURATION_DAYS;
}

function lastReviewMs(card: NotebookCard): number | null {
    const raw = card.fsrs?.last_review;
    if (!raw) return null;
    const t = raw instanceof Date ? raw.getTime() : new Date(raw as unknown as string).getTime();
    return Number.isFinite(t) ? t : null;
}

/** True when the card is not due but falls into an extra-pass window it was not graded in. */
export function needsExtraPass(card: NotebookCard, now: number): boolean {
    if (card.due <= now) return false;
    const deadline = cardDeadline(card);
    if (deadline === undefined) return false;
    const window = extraPassWindow(now, deadline);
    if (!window) return false;
    const last = lastReviewMs(card);
    return !(last !== null && last >= window.start && last <= now);
}

/** Queue item of a notebook card (`null` when it has nothing to ask). */
export function itemFromCard(card: NotebookCard, now: number): QueueItem | null {
    if (!card.epd || card.answers.length === 0) return null;
    const source = sourceForKind(card.kind);
    const due = card.due <= now;
    const extraPass = !due && needsExtraPass(card, now);
    if (!due && !extraPass) return null;
    const deadline = cardDeadline(card);
    const orientation = card.meta.playerColor ?? sideToMove(card.epd);
    return {
        id: `nb:${card.id}`,
        source,
        kind: card.kind,
        due: card.due,
        priority: cardPriority(card, source),
        deadline,
        isNew: (card.fsrs?.reps ?? 0) === 0,
        extraPass,
        score: 0,
        payload: {
            cardId: card.id,
            epd: card.epd,
            answers: card.answers,
            orientation,
            title: card.meta.title ?? card.source?.gameKey ?? card.kind,
            origin: card.source?.gameKey,
            san: card.meta.san,
            playedSan: card.meta.playedSan,
            opponent: cardOpponent(card),
            card,
        },
    };
}

/**
 * Due legacy deck positions as queue items. `knownEpds` (every notebook
 * card's EPD) and `isCold` skip positions; a position seen in an earlier
 * deck is not asked twice.
 */
export function itemsFromDecks(
    decks: readonly LegacyDeck[],
    now: number,
    knownEpds: ReadonlySet<string>,
    isCold: (epd: string) => boolean = () => false,
): QueueItem[] {
    const out: QueueItem[] = [];
    const seen = new Set<string>();
    for (const deck of decks) {
        for (const position of deck.positions) {
            const epd = epdOf(position.fen);
            if (!epd || seen.has(epd) || knownEpds.has(epd) || isCold(epd)) continue;
            const input = legacyPositionToCard(position, deck, now);
            if (!input || !input.fsrs) continue;
            const due = input.fsrs.due.getTime();
            if (!Number.isFinite(due) || due > now) continue;
            seen.add(epd);
            const meta = input.meta ?? {};
            const card: NotebookCard = {
                id: `legacy:${epd}`,
                epd,
                kind: "repertoire",
                answers: input.answers,
                source: input.source ?? null,
                due,
                fsrs: input.fsrs,
                meta,
                createdAt: due,
                updatedAt: due,
            };
            out.push({
                id: card.id,
                source: "repertoire",
                kind: "repertoire",
                due,
                priority: cardPriority(card, "repertoire"),
                isNew: input.fsrs.reps === 0,
                extraPass: false,
                score: 0,
                payload: {
                    deckKey: deck.key,
                    file: deck.file,
                    game: deck.game,
                    fen: position.fen,
                    epd,
                    answers: input.answers,
                    orientation: meta.playerColor ?? sideToMove(epd),
                    title: typeof meta.title === "string" ? meta.title : deck.file,
                    origin: input.source?.gameKey,
                    san: meta.san,
                    card,
                },
            });
        }
    }
    return out;
}

/** Assigns `score` and sorts: deadline tier, then score, then due, then id. */
export function orderItems(
    items: readonly QueueItem[],
    settings: QueueSettings,
    now: number,
): QueueItem[] {
    const scored = items.map((item) => ({
        ...item,
        score:
            item.priority *
            (settings.weights[item.source] ?? 1) *
            overdueFactor(now, item.due, item.isNew),
    }));
    return scored.sort((a, b) => {
        const ta = deadlineTier(now, a.deadline);
        const tb = deadlineTier(now, b.deadline);
        if (ta !== tb) return ta - tb;
        if (ta === 0 && a.deadline !== b.deadline) return a.deadline! - b.deadline!;
        if (a.score !== b.score) return b.score - a.score;
        if (a.due !== b.due) return a.due - b.due;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Floor for "new cards graded today" derived from the cards themselves: a
 * card whose only review happened today was new this morning. (The session
 * keeps the exact count in the kv; the two are combined with `max`.)
 */
export function countNewGradedToday(cards: readonly NotebookCard[], now: number): number {
    const dayStart = startOfLocalDay(now);
    let n = 0;
    for (const card of cards) {
        if ((card.fsrs?.reps ?? 0) !== 1) continue;
        const last = lastReviewMs(card);
        if (last !== null && last >= dayStart && last <= now) n++;
    }
    return n;
}

export function buildQueue(now: number, settings: QueueSettings, deps: QueueDeps): QueueBuild {
    const isCold = deps.isCold ?? (() => false);
    const knownEpds = new Set<string>();
    const candidates: QueueItem[] = [];
    for (const card of deps.cards) {
        if (card.epd) knownEpds.add(epdOf(card.epd));
        const item = itemFromCard(card, now);
        if (!item) continue;
        if (item.source === "repertoire" && isCold(item.payload.epd)) continue;
        candidates.push(item);
    }
    candidates.push(...itemsFromDecks(deps.decks ?? [], now, knownEpds, isCold));

    const ordered = orderItems(candidates, settings, now);

    // Daily cap on never-graded cards, in queue order.
    let allowance = Math.max(0, settings.newPerDay - Math.max(0, deps.newGradedToday ?? 0));
    let newCapped = 0;
    const admitted: QueueItem[] = [];
    for (const item of ordered) {
        if (item.isNew) {
            if (allowance <= 0) {
                newCapped++;
                continue;
            }
            allowance--;
        }
        admitted.push(item);
    }

    const overdue = admitted.filter((item) => !item.extraPass).length;
    const estimate: Estimate = estimateQueue(admitted, settings.minutesCap, deps.durations);
    const catchUp = overdue > settings.catchUpFactor * estimate.fits;
    const items = catchUp ? admitted.slice(0, estimate.fits) : admitted;
    const dropped = admitted.length - items.length;

    const bySource = emptyBySource();
    let extraPass = 0;
    for (const item of items) {
        bySource[item.source]++;
        if (item.extraPass) extraPass++;
    }
    const finalEstimate = catchUp
        ? estimateQueue(items, settings.minutesCap, deps.durations)
        : estimate;
    return {
        items,
        minutes: finalEstimate.minutes,
        totalMinutes: finalEstimate.totalMinutes,
        bySource,
        catchUp,
        dropped,
        newCapped,
        fits: estimate.fits,
        overdue,
        extraPass,
    };
}
