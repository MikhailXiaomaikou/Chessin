import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { onReviewSaved } from "./events";
import type { Review } from "./model";

/**
 * Per-tab UI state of the review panel and a small cache of loaded reviews,
 * shared with the palette commands (`review.next` / `review.prev`) that run
 * outside React.
 */

/** Index of the selected key moment per tab id. */
export const selectedMomentFamily = atomFamily((_tabId: string) => atom<number>(0));

const cache = new Map<string, Review>();

export function getCachedReview(gameKey: string | null | undefined): Review | undefined {
    return gameKey ? cache.get(gameKey) : undefined;
}

export function setCachedReview(review: Review): void {
    cache.set(review.gameKey, review);
}

export function dropCachedReview(gameKey: string): void {
    cache.delete(gameKey);
}

onReviewSaved(setCachedReview);
