import { atom, getDefaultStore } from "jotai";
import { getActiveTreeState } from "@/chessin/keymap/treeStores";
import { activeTabAtom } from "@/state/atoms";
import { DEFAULT_SIMILAR_FILTERS, type SimilarFilters } from "./mapping";
import type { SimilarMode } from "./replay";

/**
 * State of the "查找相似" drawer. The query position is captured when the
 * drawer opens (the board can keep moving underneath); "当前局面" re-captures.
 */

export type SimilarDrawerState = {
    open: boolean;
    /** The queried position; null until the drawer was opened from a board. */
    fen: string | null;
    /** Board tab the drawer was opened from (its source chip is used). */
    tabId: string | null;
};

export const similarDrawerAtom = atom<SimilarDrawerState>({ open: false, fen: null, tabId: null });

export const similarModeAtom = atom<SimilarMode>("position");

export const similarFiltersAtom = atom<SimilarFilters>(DEFAULT_SIMILAR_FILTERS);

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** The active board's current position, or null when no board tab is mounted. */
export function activeBoardFen(): string | null {
    const state = getActiveTreeState();
    if (!state) return null;
    try {
        return state.currentNode().fen;
    } catch {
        return null;
    }
}

/** Opens the drawer on the active board's position. Returns false when there is no board. */
export function openSimilarDrawer(store: JotaiStore = getDefaultStore()): boolean {
    const fen = activeBoardFen();
    if (!fen) return false;
    store.set(similarDrawerAtom, { open: true, fen, tabId: store.get(activeTabAtom) ?? null });
    return true;
}

export function closeSimilarDrawer(store: JotaiStore = getDefaultStore()): void {
    store.set(similarDrawerAtom, (prev) => ({ ...prev, open: false }));
}

/** Hotkey behaviour: closes an open drawer, otherwise opens it on the active board. */
export function toggleSimilarDrawer(store: JotaiStore = getDefaultStore()): boolean {
    if (store.get(similarDrawerAtom).open) {
        closeSimilarDrawer(store);
        return true;
    }
    return openSimilarDrawer(store);
}
