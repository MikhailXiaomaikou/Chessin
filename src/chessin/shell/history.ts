import { getDefaultStore } from "jotai";
import { activeTabAtom, tabsAtom } from "@/state/atoms";

/**
 * Chessin shell (S3-6): back / forward history over "places" in the app.
 *
 * A place is a route (`href`: pathname + search) plus, on the board page, the
 * active tab — so "返回上一盘棋" works across tab switches as well as across
 * pages (IA acceptance task 6). `useShellHistory` records a place on every
 * route change and active-tab change; `goBack` / `goForward` move the cursor
 * and replay the place (`mod+[` / `mod+]`, the command-bar buttons, the
 * `nav.back` / `nav.forward` commands).
 *
 * This module is framework-free (no router import) so it can be unit-tested;
 * the React binding lives in `useShellHistory.ts`.
 */

export type HistoryEntry = {
    /** `location.href` as the router reports it: pathname + search (+ hash). */
    route: string;
    /** Active tab on the board page, `null` elsewhere. */
    tabId: string | null;
};

/** Oldest entries are dropped beyond this many. */
export const HISTORY_CAP = 50;

/**
 * How long a `back()` / `forward()` keeps swallowing records while the app
 * catches up (tab switch and route change land in two renders). After it, or
 * once the target place is recorded, recording resumes.
 */
export const TRAVEL_GRACE_MS = 1500;

export type ShellHistory = {
    /** Appends `entry` after the cursor (dropping any forward entries); a repeat of the current place is a no-op. */
    record(entry: HistoryEntry): void;
    /** Moves the cursor back one place and returns it, or `null` at the start. */
    back(): HistoryEntry | null;
    /** Moves the cursor forward one place and returns it, or `null` at the end. */
    forward(): HistoryEntry | null;
    canBack(): boolean;
    canForward(): boolean;
    current(): HistoryEntry | null;
    /** Removes entries that are no longer valid (closed tabs), keeping the cursor on the same place. */
    prune(isValid: (entry: HistoryEntry) => boolean): void;
    entries(): readonly HistoryEntry[];
    index(): number;
    subscribe(listener: () => void): () => void;
    /** Monotonic counter bumped on every change (for `useSyncExternalStore`). */
    version(): number;
    reset(): void;
};

export function sameEntry(a: HistoryEntry | null, b: HistoryEntry | null): boolean {
    if (!a || !b) return a === b;
    return a.route === b.route && a.tabId === b.tabId;
}

export function createShellHistory(cap = HISTORY_CAP, now: () => number = Date.now): ShellHistory {
    let entries: HistoryEntry[] = [];
    let index = -1;
    let version = 0;
    let pending: { entry: HistoryEntry; until: number } | null = null;
    const listeners = new Set<() => void>();

    const emit = () => {
        version += 1;
        for (const l of listeners) l();
    };

    const travelTo = (next: number): HistoryEntry | null => {
        if (next < 0 || next >= entries.length) return null;
        index = next;
        const entry = entries[index];
        pending = { entry, until: now() + TRAVEL_GRACE_MS };
        emit();
        return entry;
    };

    return {
        record(entry) {
            if (pending) {
                if (now() < pending.until) {
                    // The app is still moving to the place `back()` / `forward()`
                    // chose: ignore the intermediate renders, and the target itself.
                    if (sameEntry(entry, pending.entry)) pending = null;
                    return;
                }
                pending = null;
            }
            if (sameEntry(entry, entries[index] ?? null)) return;
            entries = entries.slice(0, index + 1);
            entries.push({ route: entry.route, tabId: entry.tabId });
            if (entries.length > cap) entries.splice(0, entries.length - cap);
            index = entries.length - 1;
            emit();
        },
        back: () => travelTo(index - 1),
        forward: () => travelTo(index + 1),
        canBack: () => index > 0,
        canForward: () => index < entries.length - 1,
        current: () => entries[index] ?? null,
        prune(isValid) {
            const kept: HistoryEntry[] = [];
            // Index (in `kept`) of the last surviving place at or before the
            // cursor: the cursor stays on the current place, or falls back to
            // the nearest earlier one when the current place itself went away.
            let cursor = -1;
            entries.forEach((entry, i) => {
                if (!isValid(entry)) return;
                kept.push(entry);
                if (i <= index) cursor = kept.length - 1;
            });
            if (kept.length === entries.length) return;
            entries = kept;
            index = cursor;
            emit();
        },
        entries: () => entries,
        index: () => index,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        version: () => version,
        reset() {
            entries = [];
            index = -1;
            pending = null;
            emit();
        },
    };
}

/** The app-wide history (one per window). */
export const shellHistory: ShellHistory = createShellHistory();

/** Minimal navigator: an `href` as the router reports it (pathname + search). */
export type ShellNavigate = (href: string) => unknown;

type JotaiStore = ReturnType<typeof getDefaultStore>;

function travel(
    direction: -1 | 1,
    navigate: ShellNavigate,
    store: JotaiStore,
    history: ShellHistory,
): boolean {
    const open = new Set(store.get(tabsAtom).map((tab) => tab.value));
    history.prune((entry) => entry.tabId === null || open.has(entry.tabId));
    const entry = direction < 0 ? history.back() : history.forward();
    if (!entry) return false;
    if (entry.tabId !== null && store.get(activeTabAtom) !== entry.tabId) {
        store.set(activeTabAtom, entry.tabId);
    }
    void navigate(entry.route);
    return true;
}

/** Goes back one place (restoring the tab, then the route). Returns false when there is nowhere to go. */
export function goBack(
    navigate: ShellNavigate,
    store: JotaiStore = getDefaultStore(),
    history: ShellHistory = shellHistory,
): boolean {
    return travel(-1, navigate, store, history);
}

/** Goes forward one place. Returns false when there is nowhere to go. */
export function goForward(
    navigate: ShellNavigate,
    store: JotaiStore = getDefaultStore(),
    history: ShellHistory = shellHistory,
): boolean {
    return travel(1, navigate, store, history);
}
