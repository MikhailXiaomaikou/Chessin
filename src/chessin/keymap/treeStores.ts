import { getDefaultStore } from "jotai";
import { useEffect } from "react";
import { activeTabAtom } from "@/state/atoms";
import type { TreeStore, TreeStoreState } from "@/state/store/tree";

/**
 * Registry of live tree stores keyed by tab id.
 *
 * Tree stores are created per board tab inside `TreeStateProvider` and only
 * reachable through React context. App-wide commands (undo / redo / copy PGN
 * from the command palette or global hotkeys) need the store of the *active*
 * tab, so providers register themselves here with `useRegisterTreeStore`.
 */

const stores = new Map<string, TreeStore>();

export function registerTreeStore(id: string, store: TreeStore): () => void {
    stores.set(id, store);
    return () => {
        if (stores.get(id) === store) stores.delete(id);
    };
}

export function getTreeStore(id: string | null | undefined): TreeStore | undefined {
    if (!id) return undefined;
    return stores.get(id);
}

/** The tree store of the currently active tab, if a board for it is mounted. */
export function getActiveTreeStore(): TreeStore | undefined {
    return getTreeStore(getDefaultStore().get(activeTabAtom));
}

/**
 * Undo / redo history is being added to the tree store (agent C). Until the
 * typings land, access them through this widened view so callers stay safe.
 */
export type TreeHistoryState = TreeStoreState & {
    undo?: () => void;
    redo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
};

export function getActiveTreeState(): TreeHistoryState | undefined {
    return getActiveTreeStore()?.getState() as TreeHistoryState | undefined;
}

/** Registers `store` under `id` for the lifetime of the calling component. */
export function useRegisterTreeStore(id: string | undefined, store: TreeStore): void {
    useEffect(() => {
        if (!id) return;
        return registerTreeStore(id, store);
    }, [id, store]);
}
