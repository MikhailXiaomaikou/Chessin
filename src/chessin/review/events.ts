import type { Review } from "./model";

/**
 * "A review was saved" listeners. `reviewGame` emits after `putDoc` succeeded,
 * so subscribers (the review panel, S2-5's `addCardsFromReview`, the Today
 * card) always read a stored review. Listener errors are logged, never thrown.
 */

export type ReviewSavedListener = (review: Review) => void;

const listeners = new Set<ReviewSavedListener>();

/** Subscribes `cb`; returns the unsubscribe function. */
export function onReviewSaved(cb: ReviewSavedListener): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function emitReviewSaved(review: Review): void {
    for (const cb of Array.from(listeners)) {
        try {
            cb(review);
        } catch (e) {
            console.error("review listener failed", e);
        }
    }
}

/** Test helper. */
export function clearReviewListeners(): void {
    listeners.clear();
}
