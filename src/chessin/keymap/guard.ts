/**
 * Chessin keymap guard.
 *
 * Single-key (no modifier) hotkeys such as `f`, `c`, `1`, `delete` must not
 * fire while the user is typing in an input, textarea or contenteditable
 * element, nor while an IME (e.g. pinyin) composition is in progress.
 *
 * Usage with react-hotkeys-hook:
 *
 *   useHotkeys(keyMap.SWAP_ORIENTATION.keys, toggleOrientation, {
 *       ...typingGuardOptions,
 *   });
 *
 * or, for a raw keydown listener:
 *
 *   window.addEventListener("keydown", (e) => {
 *       if (isTypingTarget(e)) return;
 *       ...
 *   });
 */

type MaybeEvent = {
    target?: EventTarget | null;
    isComposing?: boolean;
    keyCode?: number;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Input types that do not accept free text; hotkeys may fire on them. */
const NON_TEXT_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
]);

/** True when `el` (or an ancestor) is an editable element. */
export function isEditableElement(el: EventTarget | null | undefined): boolean {
    if (!el || typeof el !== "object") return false;
    const node = el as HTMLElement;
    if (typeof node.tagName !== "string") return false;
    const tag = node.tagName.toUpperCase();
    if (tag === "INPUT") {
        const type = ((node as HTMLInputElement).type ?? "text").toLowerCase();
        return !NON_TEXT_INPUT_TYPES.has(type);
    }
    if (TYPING_TAGS.has(tag)) return true;
    if (node.isContentEditable) return true;
    // Fallback for environments without `isContentEditable` (jsdom).
    const attr =
        typeof node.getAttribute === "function" ? node.getAttribute("contenteditable") : null;
    if (attr !== null && attr !== "false") return true;
    if (typeof node.closest === "function") {
        return (
            node.closest('[contenteditable=""], [contenteditable="true"], .ProseMirror') !== null
        );
    }
    return false;
}

/**
 * Returns true when the keyboard event originates from a typing context:
 * an input / textarea / select / contenteditable target, or an active IME
 * composition (`isComposing` or legacy `keyCode === 229`).
 */
export function isTypingTarget(e: MaybeEvent | KeyboardEvent | null | undefined): boolean {
    if (!e) return false;
    if (e.isComposing === true) return true;
    if (e.keyCode === 229) return true;
    return isEditableElement(e.target);
}

/**
 * Options to spread into `useHotkeys(keys, cb, { ...typingGuardOptions })`.
 *
 * `enableOnFormTags` stays false (library default) so inputs are skipped, and
 * `enableOnContentEditable` stays false; `ignoreEventWhen` adds the IME check.
 */
export const typingGuardOptions = {
    enableOnFormTags: false,
    enableOnContentEditable: false,
    ignoreEventWhen: (e: KeyboardEvent) => isTypingTarget(e),
} as const;

/** Wraps a key handler so it is a no-op in typing contexts. */
export function guardTyping<E extends KeyboardEvent>(handler: (e: E) => void): (e: E) => void {
    return (e: E) => {
        if (isTypingTarget(e)) return;
        handler(e);
    };
}
