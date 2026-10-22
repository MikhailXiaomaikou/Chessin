import { getDefaultStore } from "jotai";
import type { Dispatch, SetStateAction } from "react";
import type { Card } from "ts-fsrs";
import { gradeCard, type NotebookCard, type NotebookRating } from "@/chessin/notebook/cards";
import { epdOf } from "@/chessin/notebook/chess";
import { parseDeckKey, type StorageLike } from "@/chessin/notebook/migration";
import { updateCardPerformance } from "@/components/files/opening";
import type { PracticeData } from "@/state/atoms";
import type { QueueItem } from "./model";

/**
 * Grading a queue item.
 *
 * - Notebook-backed items (`payload.cardId`) go through `gradeCard` (FSRS +
 *   a `card_logs` row).
 * - Legacy practice-deck positions are rescheduled with the practice panel's
 *   own `updateCardPerformance` and written back to localStorage. The deck is
 *   read from storage here rather than through `deckAtomFamily`: those atoms
 *   are created without `getOnInit`, so an updater on an atom no component
 *   has mounted would see the empty initial deck and overwrite the stored
 *   one. After the write the mounted atom (if any) is set to the same value
 *   so the practice panel refreshes.
 * - An `rp:` card migrated from a deck keeps its deck position in step: both
 *   are graded.
 */

type WritableStorage = StorageLike & { setItem(key: string, value: string): void };

export type GradeResult = { notebook: boolean; legacy: boolean };

export type GradeOptions = {
    /** Legacy deck storage; defaults to `localStorage`. */
    storage?: WritableStorage | null;
    /** Push the updated deck into the mounted `deckAtomFamily` atom (default true). */
    syncAtom?: boolean;
};

function defaultStorage(): WritableStorage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

/** `meta.legacyDeck` of a card the migration created from a practice deck. */
export function legacyDeckOf(card: Pick<NotebookCard, "meta"> | undefined): string | undefined {
    const key = card?.meta?.legacyDeck;
    return typeof key === "string" && key.startsWith("deck-") ? key : undefined;
}

export async function gradeQueueItem(
    item: QueueItem,
    rating: NotebookRating,
    now = Date.now(),
    opts: GradeOptions = {},
): Promise<GradeResult> {
    const result: GradeResult = { notebook: false, legacy: false };
    const { cardId, deckKey, epd } = item.payload;
    if (cardId) {
        await gradeCard(cardId, rating, now);
        result.notebook = true;
    }
    const key = deckKey ?? legacyDeckOf(item.payload.card);
    if (key) {
        try {
            result.legacy = gradeLegacyDeckPosition(key, epd, rating, opts);
        } catch (e) {
            if (!cardId) throw e;
            console.warn("queue: legacy deck update failed", e);
        }
    }
    if (!result.notebook && !result.legacy) {
        throw new Error(`Queue item ${item.id} has nothing to grade`);
    }
    return result;
}

/**
 * Reschedules the deck position with `epd` through `updateCardPerformance`
 * and writes the deck back. Returns false when the deck or position is gone.
 */
export function gradeLegacyDeckPosition(
    deckKey: string,
    epd: string,
    rating: NotebookRating,
    opts: GradeOptions = {},
): boolean {
    const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    if (!storage) return false;
    const raw = storage.getItem(deckKey);
    if (!raw) return false;
    let data: PracticeData;
    try {
        data = JSON.parse(raw) as PracticeData;
    } catch {
        return false;
    }
    if (!data || !Array.isArray(data.positions)) return false;
    if (!Array.isArray(data.logs)) data.logs = [];
    const target = epdOf(epd);
    const index = data.positions.findIndex(
        (p) => p && typeof p.fen === "string" && epdOf(p.fen) === target,
    );
    if (index < 0) return false;

    let next: PracticeData = data;
    const setPositions: Dispatch<SetStateAction<PracticeData>> = (action) => {
        next = typeof action === "function" ? action(next) : action;
    };
    updateCardPerformance(setPositions, index, data.positions[index].card as Card, rating);
    storage.setItem(deckKey, JSON.stringify(next));
    if (opts.syncAtom !== false) syncDeckAtom(deckKey, next);
    return true;
}

function syncDeckAtom(deckKey: string, next: PracticeData): void {
    const parsed = parseDeckKey(deckKey);
    if (!parsed) return;
    // Lazy: `@/state/atoms` pulls the whole app state; only the UI needs it.
    void import("@/state/atoms")
        .then(({ deckAtomFamily }) => {
            getDefaultStore().set(deckAtomFamily(parsed), next);
        })
        .catch(() => undefined);
}
