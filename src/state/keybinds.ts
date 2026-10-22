import { platform } from "@tauri-apps/plugin-os";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";

/** `cmd` on macOS, `ctrl` elsewhere — the primary modifier of every `mod+…` default. */
export const meta = platform() === "macos" ? "cmd" : "ctrl";

export type Keybind = {
    name: string;
    keys: string;
};

export type KeyMap = { [key: string]: Keybind };

/**
 * Chessin defaults (the `chessin` preset in `@/chessin/keymap/presets`).
 * The other presets are expressed as overrides of this map.
 */
const keys: KeyMap = {
    NEW_TAB: { name: "New tab", keys: `${meta}+t` },
    CLOSE_TAB: { name: "Close tab", keys: `${meta}+w` },
    OPEN_FILE: { name: "Open File", keys: `${meta}+o` },
    SAVE_FILE: { name: "Save File", keys: `${meta}+s` },
    COPY_PGN: { name: "Copy PGN", keys: `${meta}+shift+c` },
    COMMAND_PALETTE: { name: "Command palette", keys: `${meta}+k` },
    UNDO: { name: "Undo", keys: `${meta}+z` },
    REDO: { name: "Redo", keys: `${meta}+shift+z` },
    KEYBOARD_SHORTCUTS: { name: "Keyboard shortcuts", keys: "shift+?" },
    SWAP_ORIENTATION: { name: "Swap orientation", keys: "f" },
    CLEAR_SHAPES: { name: "Clear shapes", keys: "ctrl+l" },
    NEXT_MOVE: { name: "Next move", keys: "arrowright" },
    PREVIOUS_MOVE: { name: "Previous move", keys: "arrowleft" },
    GO_TO_BRANCH_START: { name: "Go to start of branch", keys: "arrowup" },
    GO_TO_BRANCH_END: { name: "Go to end of branch", keys: "arrowdown" },
    GO_TO_START: { name: "Go to start of game", keys: "shift+arrowup" },
    GO_TO_END: { name: "Go to end of game", keys: "shift+down" },
    NEXT_BRANCH: { name: "Next branch", keys: "c" },
    PREVIOUS_BRANCH: { name: "Previous branch", keys: "x" },
    NEXT_BRANCHING: { name: "Next branching point", keys: "shift+arrowright" },
    PREVIOUS_BRANCHING: {
        name: "Previous branching point",
        keys: "shift+arrowleft",
    },
    DELETE_MOVE: { name: "Delete move", keys: "delete" },
    CYCLE_TABS: { name: "Cycle tabs", keys: "ctrl+tab" },
    REVERSE_CYCLE_TABS: { name: "Reverse cycle tabs", keys: "ctrl+shift+tab" },
    TOGGLE_EVAL_BAR: { name: "Toggle Eval Bar and Arrows", keys: "z" },
    PRACTICE_TAB: { name: "Go to practice tab", keys: "p" },
    ANALYSIS_TAB: { name: "Go to analysis tab", keys: "a" },
    DATABASE_TAB: { name: "Go to database tab", keys: "b" },
    ANNOTATE_TAB: { name: "Go to annotate tab", keys: "d" },
    INFO_TAB: { name: "Go to info tab", keys: "i" },
    ANNOTATION_BRILLIANT: { name: "Toggle brilliant move annotation", keys: "1" },
    ANNOTATION_GOOD: { name: "Toggle good move annotation", keys: "2" },
    ANNOTATION_INTERESTING: {
        name: "Toggle interesting move annotation",
        keys: "3",
    },
    ANNOTATION_DUBIOUS: { name: "Toggle dubious move annotation", keys: "4" },
    ANNOTATION_MISTAKE: { name: "Toggle mistake move annotation", keys: "5" },
    ANNOTATION_BLUNDER: { name: "Toggle blunder move annotation", keys: "6" },
    TOGGLE_ALL_ENGINES: { name: "Toggle all engines", keys: "ctrl+a" },
    TOGGLE_BLUR: { name: "Toggle blur", keys: "ctrl+b" },
    GENERATE_REPORT: { name: "Generate game report", keys: "f12" },
    PREVIOUS_GAME: { name: "Previous game", keys: "pageup" },
    NEXT_GAME: { name: "Next game", keys: "pagedown" },
    TOGGLE_SIDEBAR: { name: "Toggle Sidebar", keys: `${meta}+shift+b` },
    // Chessin: moved off `mod+shift+t` (reserved for "reopen tab"); `mod+shift+b` is the sidebar.
    TOGGLE_TAB_BAR: { name: "Toggle Tab Bar", keys: `${meta}+shift+h` },
    // Chessin: browser-style "reopen the last closed tab" (command `view.reopenClosedTab`).
    REOPEN_TAB: { name: "Reopen closed tab", keys: `${meta}+shift+t` },
    // Chessin (S3-2): the "查找相似" drawer (command `search.findSimilar`); guarded in inputs.
    FIND_SIMILAR: { name: "Find similar games", keys: `${meta}+f` },
    // Chessin (S3-6): shell back / forward over pages and board tabs (commands `nav.back` / `nav.forward`).
    NAV_BACK: { name: "Back", keys: `${meta}+[` },
    NAV_FORWARD: { name: "Forward", keys: `${meta}+]` },
};

/** The built-in defaults, frozen so presets and tests cannot mutate them. */
export const defaultKeyMap: Readonly<KeyMap> = keys;

// Chessin: defaults that changed since the keymap was first persisted. A stored
// binding that still equals an old default is migrated to the new default so
// existing users do not keep `mod+k` on "Copy PGN" after it became the palette.
const legacyDefaults: { [key: string]: string[] } = {
    COPY_PGN: [`${meta}+k`],
    TOGGLE_TAB_BAR: [`${meta}+shift+t`, `${meta}+shift+b`],
};

export const keyMapAtom = atomWithStorage("keybinds", keys, defaultStorage(keys, localStorage));

function defaultStorage(defaults: KeyMap, storage: SyncStringStorage): SyncStorage<KeyMap> {
    return {
        getItem(key, initialValue) {
            const storedValue = storage.getItem(key);
            if (storedValue === null) {
                return initialValue;
            }
            const parsed = JSON.parse(storedValue);
            for (const key in defaults) {
                if (!(key in parsed)) {
                    parsed[key] = defaults[key];
                } else if (legacyDefaults[key]?.includes(parsed[key].keys)) {
                    parsed[key] = { ...parsed[key], keys: defaults[key].keys };
                }
            }
            return parsed;
        },
        setItem(key, value) {
            for (const subkey in value) {
                value[subkey].keys = value[subkey].keys.replace("meta", meta);
            }

            storage.setItem(key, JSON.stringify(value));
        },
        removeItem(key) {
            storage.removeItem(key);
        },
    };
}
