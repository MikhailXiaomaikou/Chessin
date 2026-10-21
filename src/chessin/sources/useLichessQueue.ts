import { useSyncExternalStore } from "react";
import { lichessQueue, type RequestQueue } from "./lichessQueue";

/** Epoch ms until which Lichess requests are held back after a 429, or null. */
export function useRateLimitedUntil(queue: RequestQueue = lichessQueue): number | null {
    return useSyncExternalStore(
        queue.subscribe,
        queue.getRateLimitedUntil,
        queue.getRateLimitedUntil,
    );
}
