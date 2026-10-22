import { atom, getDefaultStore } from "jotai";
import { isLibraryOrigin, libraryDocIdFor } from "@/chessin/save/saveModel";
import { currentTabAtom } from "@/state/atoms";

/**
 * State of the "历史版本" drawer: which library document it shows. The drawer
 * itself is mounted by `HistoryControl` (the board's save-button column), so
 * it exists exactly when a board tab is on screen.
 */

export type HistoryDrawerState = {
    open: boolean;
    /** Tab id = library document id (`treePersist` persists under the tab id). */
    tabId: string | null;
};

export const historyDrawerAtom = atom<HistoryDrawerState>({ open: false, tabId: null });

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** The active tab's document id when it is a library document, else null. */
export function activeLibraryDocId(store: JotaiStore = getDefaultStore()): string | null {
    const tab = store.get(currentTabAtom);
    if (!tab || !isLibraryOrigin(tab)) return null;
    return libraryDocIdFor(tab);
}

/** Opens the drawer on the active library document. Returns false when there is none. */
export function openHistoryDrawer(store: JotaiStore = getDefaultStore()): boolean {
    const tabId = activeLibraryDocId(store);
    if (!tabId) return false;
    store.set(historyDrawerAtom, { open: true, tabId });
    return true;
}

export function closeHistoryDrawer(store: JotaiStore = getDefaultStore()): void {
    store.set(historyDrawerAtom, (prev) => ({ ...prev, open: false }));
}

export function toggleHistoryDrawer(store: JotaiStore = getDefaultStore()): boolean {
    if (store.get(historyDrawerAtom).open) {
        closeHistoryDrawer(store);
        return true;
    }
    return openHistoryDrawer(store);
}
