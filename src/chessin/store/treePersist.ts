import type { PersistStorage, StorageValue } from "zustand/middleware";
import { createDebouncedSessionStorage } from "@/state/store/debouncedStorage";
import {
    awaitDocWrites,
    GAME_DOC_KIND,
    getTreeDocMeta,
    putDoc,
    titleForTreeState,
} from "./libraryStore";
import { markDocFailed, markDocPending, markDocSaved, markDocSaving } from "./saveState";

/**
 * zustand `persist` storage for the per-tab tree stores (`createTreeStore(id)`).
 *
 * Every change still lands in the sessionStorage mirror (300 ms debounce, read
 * synchronously on hydration and by `BoardsPage`), and additionally reaches
 * library.sqlite through `doc_put(id = tab id, kind = "game")` at most
 * `DOC_DEBOUNCE_MS` after the last change. Unchanged payloads are skipped.
 */

export const DOC_DEBOUNCE_MS = 500;

type PendingDoc = { value: StorageValue<unknown>; timer: ReturnType<typeof setTimeout> };

const pendingDocs = new Map<string, PendingDoc>();
const lastWritten = new Map<string, string>();

function cancelDocWrite(name: string) {
    const pending = pendingDocs.get(name);
    if (pending) {
        clearTimeout(pending.timer);
        pendingDocs.delete(name);
    }
}

async function writeDoc(name: string, value: StorageValue<unknown>): Promise<void> {
    const raw = JSON.stringify(value);
    if (lastWritten.get(name) === raw) {
        markDocSaved(name);
        return;
    }
    const meta = getTreeDocMeta(name);
    markDocSaving(name);
    try {
        await putDoc({
            id: name,
            kind: GAME_DOC_KIND,
            title: meta.title ?? titleForTreeState(value.state, name),
            origin: meta.origin ?? null,
            data: raw,
            checkpoint: null,
        });
        lastWritten.set(name, raw);
        markDocSaved(name);
    } catch (e) {
        console.warn(`[chessin] doc_put(${name}) failed: ${String(e)}`);
        markDocFailed(name);
    }
}

function scheduleDocWrite(name: string, value: StorageValue<unknown>, delay: number) {
    cancelDocWrite(name);
    markDocPending(name);
    const timer = setTimeout(() => {
        pendingDocs.delete(name);
        void writeDoc(name, value);
    }, delay);
    pendingDocs.set(name, { value, timer });
}

/**
 * Storage for `persist({ name: tabId, storage: createDocumentStorage() })`.
 * `name` is the tab id, which is also the document id in the library.
 */
export function createDocumentStorage<S>(delay = DOC_DEBOUNCE_MS): PersistStorage<S> {
    const mirror = createDebouncedSessionStorage<S>();
    return {
        getItem: (name) => mirror.getItem(name),
        setItem: (name, value) => {
            mirror.setItem(name, value);
            scheduleDocWrite(name, value as StorageValue<unknown>, delay);
        },
        removeItem: (name) => {
            mirror.removeItem(name);
            cancelDocWrite(name);
            lastWritten.delete(name);
        },
    };
}

/** Writes every pending document now and waits for the writes to settle. */
export async function flushDocWrites(): Promise<void> {
    const entries = Array.from(pendingDocs.entries());
    for (const [name, pending] of entries) {
        clearTimeout(pending.timer);
        pendingDocs.delete(name);
        void writeDoc(name, pending.value);
    }
    await awaitDocWrites();
}

export function hasPendingDocWrites(): boolean {
    return pendingDocs.size > 0;
}

/** Test helper: drops pending timers and the "last written" cache. */
export function resetTreePersistence(): void {
    for (const pending of pendingDocs.values()) clearTimeout(pending.timer);
    pendingDocs.clear();
    lastWritten.clear();
}
