/**
 * Tiny bus between the app-wide accessibility commands and the board that is
 * currently mounted: `announce(text)` reaches the board's live region and
 * `focusBoard()` moves keyboard focus into its ARIA grid. Both are no-ops
 * when no board is mounted (commands report `enabled: false` then).
 */

type AnnounceListener = (text: string) => void;

const listeners = new Set<AnnounceListener>();
let focusHandler: (() => void) | null = null;

/** Sends `text` to every mounted live region (normally exactly one). */
export function announce(text: string): void {
    for (const listener of listeners) listener(text);
}

export function subscribeAnnouncements(listener: AnnounceListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The mounted board registers how to focus its grid; `null` on unmount. */
export function setBoardFocusHandler(handler: (() => void) | null): void {
    focusHandler = handler;
}

export function canFocusBoard(): boolean {
    return focusHandler !== null;
}

/** Focuses the mounted board's grid. Returns false when there is none. */
export function focusBoard(): boolean {
    if (!focusHandler) return false;
    focusHandler();
    return true;
}
