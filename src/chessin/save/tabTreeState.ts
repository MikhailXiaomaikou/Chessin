import { getTreeStore } from "@/chessin/keymap/treeStores";
import { readSessionMirror } from "@/state/store/debouncedStorage";
import type { TreeStoreState } from "@/state/store/tree";

/**
 * Reads the tree state of any tab, mounted or not.
 *
 * The active tab's store is registered in `treeStores`; a background tab's
 * provider is unmounted (`keepMounted={false}`), so its state is read from
 * the session mirror (`{ version, state }` kept by the tree store's persist
 * middleware, pending debounced writes included). Returns `null` when
 * nothing is known.
 */
export function readTabTreeState(tabId: string | null | undefined): TreeStoreState | null {
    if (!tabId) return null;
    const live = getTreeStore(tabId);
    if (live) return live.getState();
    try {
        const raw = readSessionMirror(tabId);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { state?: TreeStoreState } | null;
        return parsed?.state ?? null;
    } catch {
        return null;
    }
}

/** True when the tab has edits that were not saved (or checkpointed). */
export function isTabDirty(tabId: string | null | undefined): boolean {
    return readTabTreeState(tabId)?.dirty === true;
}
