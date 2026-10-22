import { atom, getDefaultStore } from "jotai";

/**
 * Aggregated save state of the Chessin-owned documents, shown in the status
 * bar's `data-slot="save-state"` as 已保存 / 保存中… / 未保存.
 *
 * `treePersist` and `libraryStore.createCheckpoint` report per-document
 * phases; the atom derives one value: any pending or failed write → "unsaved",
 * else any write in flight → "saving", else "saved".
 */

export type SaveState = "saved" | "saving" | "unsaved";
export type DocSavePhase = "pending" | "saving" | "failed";

type JotaiStore = ReturnType<typeof getDefaultStore>;

const phases = new Map<string, DocSavePhase>();
const baseAtom = atom<SaveState>("saved");

export const saveStateAtom = atom((get) => get(baseAtom));

export function computeSaveState(values: Iterable<DocSavePhase>): SaveState {
    let state: SaveState = "saved";
    for (const phase of values) {
        if (phase === "pending" || phase === "failed") return "unsaved";
        if (phase === "saving") state = "saving";
    }
    return state;
}

function publish(store: JotaiStore) {
    const next = computeSaveState(phases.values());
    if (store.get(baseAtom) !== next) store.set(baseAtom, next);
}

export function markDocPending(id: string, store: JotaiStore = getDefaultStore()): void {
    phases.set(id, "pending");
    publish(store);
}

export function markDocSaving(id: string, store: JotaiStore = getDefaultStore()): void {
    phases.set(id, "saving");
    publish(store);
}

export function markDocSaved(id: string, store: JotaiStore = getDefaultStore()): void {
    phases.delete(id);
    publish(store);
}

export function markDocFailed(id: string, store: JotaiStore = getDefaultStore()): void {
    phases.set(id, "failed");
    publish(store);
}

export function getSaveState(store: JotaiStore = getDefaultStore()): SaveState {
    return store.get(saveStateAtom);
}

/** Test helper: forgets every document phase. */
export function resetSaveState(store: JotaiStore = getDefaultStore()): void {
    phases.clear();
    publish(store);
}
