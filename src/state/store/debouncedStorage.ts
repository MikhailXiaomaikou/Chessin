import { type PersistStorage, type StorageValue } from "zustand/middleware";

const DEBOUNCE_MS = 300;
const pendingWrites = new Map<string, StorageValue<unknown>>();

let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let flushHandlersBound = false;

function flush() {
    if (pendingWrites.size === 0) {
        return;
    }

    for (const [name, value] of pendingWrites) {
        sessionStorage.setItem(name, JSON.stringify(value));
    }

    pendingWrites.clear();
}

function scheduleFlush(delay: number) {
    if (flushTimeout) {
        clearTimeout(flushTimeout);
    }

    flushTimeout = setTimeout(() => {
        flushTimeout = null;
        flush();
    }, delay);
}

function bindFlushHandlers() {
    if (flushHandlersBound || typeof window === "undefined") {
        return;
    }

    const flushAndClearTimeout = () => {
        if (flushTimeout) {
            clearTimeout(flushTimeout);
            flushTimeout = null;
        }

        flush();
    };

    window.addEventListener("beforeunload", flushAndClearTimeout);
    window.addEventListener("pagehide", flushAndClearTimeout);

    flushHandlersBound = true;
}

export function createDebouncedSessionStorage<S>(delay = DEBOUNCE_MS): PersistStorage<S> {
    bindFlushHandlers();

    return {
        getItem: (name) => {
            const pending = pendingWrites.get(name);
            if (pending) {
                return pending as StorageValue<S>;
            }

            const stored = sessionStorage.getItem(name);
            return stored ? (JSON.parse(stored) as StorageValue<S>) : null;
        },
        setItem: (name, value) => {
            pendingWrites.set(name, value as StorageValue<unknown>);
            scheduleFlush(delay);
        },
        removeItem: (name) => {
            pendingWrites.delete(name);
            sessionStorage.removeItem(name);
        },
    };
}

// Chessin: the sessionStorage entry written above is the *transient mirror* of a
// tab's tree store (the durable copy lives in library.sqlite, see
// `@/chessin/store/treePersist`). The helpers below give that mirror a name so
// crash recovery, "reopen closed tab" and checkpoints can read and seed it
// without knowing about the pending-write queue.

/** Serialised `StorageValue` of the tree store persisted under `name`, or null. */
export function readSessionMirror(name: string): string | null {
    const pending = pendingWrites.get(name);
    if (pending) {
        return JSON.stringify(pending);
    }
    try {
        return sessionStorage.getItem(name);
    } catch {
        return null;
    }
}

/** Replaces the mirror for `name` (and drops any pending debounced write for it). */
export function writeSessionMirror(name: string, raw: string): void {
    pendingWrites.delete(name);
    try {
        sessionStorage.setItem(name, raw);
    } catch {
        // Quota or disabled storage: the durable copy still exists in the library.
    }
}

export function removeSessionMirror(name: string): void {
    pendingWrites.delete(name);
    try {
        sessionStorage.removeItem(name);
    } catch {
        // ignore
    }
}

/** Writes every pending mirror update now (used before the window closes). */
export function flushSessionMirror(): void {
    if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
    }
    flush();
}
