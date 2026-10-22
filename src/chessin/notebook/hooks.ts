import { onReviewSaved } from "@/chessin/review/events";
import { expectedScore, type KeyMoment, type Review } from "@/chessin/review/model";
import {
    type AddFindMoveCardInput,
    addFindMoveCard,
    type CardMeta,
    type NotebookCard,
} from "./cards";
import { epdOf, sanFromUci, sideToMove, uniqueAnswers } from "./chess";

/**
 * Review → notebook bridge (contract S2-5).
 *
 * Every key moment of a saved review whose `priority >= CARD_PRIORITY_THRESHOLD`
 * becomes a "find the move" card. `registerReviewListener()` subscribes
 * `addCardsFromReview` to S2-3's `onReviewSaved` so this happens
 * automatically; the review panel's "加入错题本" button calls
 * `addCardsFromReview` directly.
 */

/** Minimum `drop × findability` for a moment to become a card. */
export const CARD_PRIORITY_THRESHOLD = 0.25;

/**
 * A move within this expected-score distance of the best move is also an
 * accepted answer ("与最佳着相差 ≤0.05 期望分都算对", teardown §W5-1).
 */
export const ALTERNATIVE_TOLERANCE = 0.05;

/** Subset of `Review` this module reads (lets tests build minimal fixtures). */
export type ReviewLike = Pick<Review, "gameKey" | "moments"> &
    Partial<Pick<Review, "playerColor" | "plies" | "headers" | "createdAt">>;

export type MomentLike = Pick<
    KeyMoment,
    "ply" | "fenBefore" | "playedUci" | "bestUci" | "drop" | "priority"
> &
    Partial<
        Pick<
            KeyMoment,
            | "id"
            | "nodeId"
            | "playedSan"
            | "bestSan"
            | "alternatives"
            | "findability"
            | "kind"
            | "color"
            | "explanations"
        >
    >;

/**
 * Accepted answers of a moment: the best move plus every alternative whose
 * expected score for the mover is within `tolerance` of the best move's.
 * Alternative scores are white-view centipawns (review model).
 */
export function answersForMoment(moment: MomentLike, tolerance = ALTERNATIVE_TOLERANCE): string[] {
    const color = moment.color ?? sideToMove(moment.fenBefore);
    const alternatives = moment.alternatives ?? [];
    const best = alternatives.find((a) => a.uci === moment.bestUci);
    const out = [moment.bestUci];
    if (best) {
        const bestExpected = expectedScore(best.score, color);
        for (const alt of alternatives) {
            if (alt.uci === moment.bestUci) continue;
            if (bestExpected - expectedScore(alt.score, color) <= tolerance) out.push(alt.uci);
        }
    }
    return uniqueAnswers(moment.fenBefore, out);
}

export function reviewTitle(review: ReviewLike): string | undefined {
    const h = review.headers;
    if (!h) return undefined;
    const white = h.white?.trim();
    const black = h.black?.trim();
    if (!white && !black) return undefined;
    return `${white || "?"} – ${black || "?"}`;
}

export type CardsFromReviewOptions = {
    threshold?: number;
    tolerance?: number;
    /** Overrides the "White – Black" title derived from `review.headers`. */
    title?: string;
};

/** Pure: the card inputs a review yields (one per qualifying moment, de-duplicated by position). */
export function cardsFromReview(
    review: ReviewLike,
    opts: CardsFromReviewOptions = {},
): AddFindMoveCardInput[] {
    const threshold = opts.threshold ?? CARD_PRIORITY_THRESHOLD;
    const title = opts.title ?? reviewTitle(review);
    const seen = new Set<string>();
    const out: AddFindMoveCardInput[] = [];
    for (const moment of review.moments as MomentLike[]) {
        if (!moment || !Number.isFinite(moment.priority) || moment.priority < threshold) continue;
        if (!moment.fenBefore || !moment.bestUci) continue;
        const epd = epdOf(moment.fenBefore);
        if (seen.has(epd)) continue;
        seen.add(epd);
        const answers = answersForMoment(moment, opts.tolerance);
        if (answers.length === 0) continue;
        const explanations = moment.explanations ?? [];
        const meta: CardMeta = {
            san: moment.bestSan ?? sanFromUci(moment.fenBefore, moment.bestUci) ?? moment.bestUci,
            playedSan:
                moment.playedSan ?? sanFromUci(moment.fenBefore, moment.playedUci) ?? undefined,
            playerColor: moment.color ?? sideToMove(moment.fenBefore),
            drop: moment.drop,
            explanationIds: explanations.map((e) => e.id),
            explanations,
            momentKind: moment.kind,
            momentId: moment.id,
        };
        if (title) meta.title = title;
        out.push({
            epd,
            answers,
            kind: "find_move",
            source: { gameKey: review.gameKey, ply: moment.ply, nodeId: moment.nodeId },
            meta,
        });
    }
    return out;
}

export type AddCardsResult = { added: number; updated: number; cards: NotebookCard[] };

/** Creates / merges the cards of a review. Safe to call twice for the same review. */
export async function addCardsFromReview(
    review: ReviewLike,
    opts: CardsFromReviewOptions = {},
    now = Date.now(),
): Promise<AddCardsResult> {
    const result: AddCardsResult = { added: 0, updated: 0, cards: [] };
    for (const input of cardsFromReview(review, opts)) {
        const { card, created } = await addFindMoveCard(input, now);
        if (created) result.added++;
        else result.updated++;
        result.cards.push(card);
    }
    return result;
}

/** The listener `registerReviewListener` subscribes (exported for tests). */
export function handleReviewSaved(review: Review): void {
    addCardsFromReview(review).catch((e) => {
        console.error("notebook: adding cards from review failed", e);
    });
}

let unsubscribe: (() => void) | null = null;

/**
 * Subscribes the notebook to saved reviews (idempotent). Returns the
 * unsubscribe function.
 */
export function registerReviewListener(): () => void {
    if (!unsubscribe) {
        const off = onReviewSaved(handleReviewSaved);
        unsubscribe = () => {
            off();
            unsubscribe = null;
        };
    }
    return unsubscribe;
}

export function isReviewListenerRegistered(): boolean {
    return unsubscribe !== null;
}
