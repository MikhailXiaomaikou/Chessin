import { atom, getDefaultStore, type SetStateAction } from "jotai";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { readSessionMirror, writeSessionMirror } from "@/state/store/debouncedStorage";
import { genID, type Tab } from "@/utils/tabs";

/**
 * Recently closed tabs (S1b-2).
 *
 * `BoardsPage.closeTab` pushes a snapshot here (via `pushRecentlyClosed` or by
 * writing `recentlyClosedAtom` directly); `view.reopenClosedTab` (mod+shift+t)
 * calls `reopenLastClosedTab`. Newest snapshot first, at most
 * `RECENTLY_CLOSED_CAP` entries. The list is in-memory only: the tree document
 * of a closed tab stays in the library (and in the sessionStorage mirror), so a
 * snapshot only needs the tab descriptor plus the serialised tree state.
 */

export const RECENTLY_CLOSED_CAP = 10;

export type ClosedTabSnapshot = {
    tab: Tab;
    /** Serialised zustand `StorageValue` of the tab's tree store, when it had one. */
    treeState: string | null;
    closedAt: number;
};

type JotaiStore = ReturnType<typeof getDefaultStore>;

const baseAtom = atom<ClosedTabSnapshot[]>([]);

/** Newest first; writes are capped to `RECENTLY_CLOSED_CAP` entries. */
export const recentlyClosedAtom = atom(
    (get) => get(baseAtom),
    (get, set, update: SetStateAction<ClosedTabSnapshot[]>) => {
        const next = typeof update === "function" ? update(get(baseAtom)) : update;
        set(baseAtom, next.slice(0, RECENTLY_CLOSED_CAP));
    },
);

/** Builds a snapshot of `tab`, capturing its tree state from the sessionStorage mirror. */
export function snapshotTab(tab: Tab, treeState?: string | null): ClosedTabSnapshot {
    return {
        tab,
        treeState: treeState === undefined ? readSessionMirror(tab.value) : treeState,
        closedAt: Date.now(),
    };
}

/** Records `tab` as recently closed. Returns the stored snapshot. */
export function pushRecentlyClosed(
    tab: Tab,
    treeState?: string | null,
    store: JotaiStore = getDefaultStore(),
): ClosedTabSnapshot {
    const snapshot = snapshotTab(tab, treeState);
    store.set(recentlyClosedAtom, (prev) => [
        snapshot,
        ...prev.filter((s) => s.tab.value !== tab.value),
    ]);
    return snapshot;
}

/**
 * Re-opens the most recently closed tab and activates it. Returns the tab that
 * was added (its id may differ from the closed one when that id is in use
 * again), or null when nothing was closed recently.
 */
export function reopenLastClosedTab(store: JotaiStore = getDefaultStore()): Tab | null {
    const [snapshot, ...rest] = store.get(recentlyClosedAtom);
    if (!snapshot) return null;
    store.set(recentlyClosedAtom, rest);

    const tabs = store.get(tabsAtom);
    const idTaken = tabs.some((t) => t.value === snapshot.tab.value);
    const tab: Tab = idTaken ? { ...snapshot.tab, value: genID() } : snapshot.tab;

    if (snapshot.treeState !== null && (idTaken || readSessionMirror(tab.value) === null)) {
        writeSessionMirror(tab.value, snapshot.treeState);
    }

    store.set(tabsAtom, (prev) => {
        // Same rule as `createTab`: a lone untouched "new" tab is replaced.
        if (prev.length === 1 && prev[0].type === "new" && tab.type !== "new") {
            return [tab];
        }
        return [...prev, tab];
    });
    store.set(activeTabAtom, tab.value);
    return tab;
}

export function clearRecentlyClosed(store: JotaiStore = getDefaultStore()): void {
    store.set(recentlyClosedAtom, []);
}
