import type { TFunction } from "i18next";
import { atomWithStorage } from "jotai/utils";
import { defaultKeyMap, type KeyMap, meta } from "@/state/keybinds";

/**
 * Keymap presets (Settings → Keybinds → "键位方案 / Keymap preset").
 *
 * A preset is a complete `KeyMap`; `chessin` is the built-in default map and
 * the other presets are expressed as overrides of it. Only actions that exist
 * in `KeyMap` can be mapped: ChessBase / Lichess keys for actions Chessin does
 * not have yet (insert best move, go to move N, engine line count…) are listed
 * in the tables below as a reminder and are added once those actions exist.
 *
 * Conflicts, resolved in favour of the muscle memory the preset is named after:
 * - `chessbase`: `Ctrl+F` flips the board (ChessBase board window). Chessin
 *   reserves `Ctrl/⌘+F` for search / "find similar", so inside this preset
 *   search is reached through the palette only (`Ctrl/⌘+K`, which stays put).
 *   ChessBase's next/previous game is `F10` / `Ctrl+F10` (another source says
 *   `F11`, and `F10` opens the menu bar on Windows/GTK), so the preset uses the
 *   teardown's suggested `Alt+↓` / `Alt+↑` instead of `PageDown` / `PageUp`.
 * - `lichess`: `↑` / `↓` jump to the start / end of the game (Lichess), so the
 *   Chessin branch-start / branch-end bindings move to `Shift+↑` / `Shift+↓`.
 *
 * ChessBase keys NOT mapped (no matching `KeyMap` action yet): `Space` insert
 * best move, `Ctrl+Space` best lines of all engines, `+` / `-` engine lines,
 * `Ctrl+G` go to move (the palette's `:N` covers it), `Ctrl+Shift+Y` clear
 * variations. Lichess keys NOT mapped: `Space` play best move, `x` threat,
 * `shift+c` comments, `j` / `k` vim moves.
 */

export type KeymapPresetName = "chessin" | "chessbase" | "lichess";

export const KEYMAP_PRESET_NAMES: readonly KeymapPresetName[] = ["chessin", "chessbase", "lichess"];

type Overrides = Readonly<Record<string, string>>;

/**
 * ChessBase keys (docs/chessbase-teardown.md, appendix B).
 *
 * | Action               | ChessBase          | Chessin default   |
 * | -------------------- | ------------------ | ----------------- |
 * | TOGGLE_ALL_ENGINES   | alt+f2             | ctrl+a            |
 * | SWAP_ORIENTATION     | ctrl+f (board)     | f                 |
 * | NEXT_GAME            | alt+arrowdown*     | pagedown          |
 * | PREVIOUS_GAME        | alt+arrowup*       | pageup            |
 * | COMMAND_PALETTE      | mod+k (unchanged)  | mod+k             |
 *
 * (*) see the module comment: ChessBase's own F10 / Ctrl+F10 is ambiguous.
 * `ctrl+f` is literal on every platform: on macOS it is ⌃F, which leaves ⌘F free.
 */
const CHESSBASE_OVERRIDES: Overrides = {
    TOGGLE_ALL_ENGINES: "alt+f2",
    SWAP_ORIENTATION: "ctrl+f",
    NEXT_GAME: "alt+arrowdown",
    PREVIOUS_GAME: "alt+arrowup",
    // `ctrl+f` flips the board here (see the module comment): "find similar"
    // is unbound and reached through the palette.
    FIND_SIMILAR: "",
};

/**
 * Lichess analysis-board keys.
 *
 * | Action               | Lichess            | Chessin default   |
 * | -------------------- | ------------------ | ----------------- |
 * | SWAP_ORIENTATION     | f (unchanged)      | f                 |
 * | TOGGLE_ALL_ENGINES   | l                  | ctrl+a            |
 * | TOGGLE_EVAL_BAR      | z (unchanged)      | z                 |
 * | NEXT_MOVE            | arrowright (same)  | arrowright        |
 * | PREVIOUS_MOVE        | arrowleft (same)   | arrowleft         |
 * | GO_TO_START          | arrowup            | shift+arrowup     |
 * | GO_TO_END            | arrowdown          | shift+down        |
 * | GO_TO_BRANCH_START   | shift+arrowup**    | arrowup           |
 * | GO_TO_BRANCH_END     | shift+arrowdown**  | arrowdown         |
 * | NEXT_BRANCHING       | shift+arrowright   | shift+arrowright  |
 * | PREVIOUS_BRANCHING   | shift+arrowleft    | shift+arrowleft   |
 *
 * (**) not a Lichess key; moved out of the way of ↑ / ↓.
 */
const LICHESS_OVERRIDES: Overrides = {
    TOGGLE_ALL_ENGINES: "l",
    GO_TO_START: "arrowup",
    GO_TO_END: "arrowdown",
    GO_TO_BRANCH_START: "shift+arrowup",
    GO_TO_BRANCH_END: "shift+arrowdown",
};

const PRESET_OVERRIDES: Readonly<Record<KeymapPresetName, Overrides>> = {
    chessin: {},
    chessbase: CHESSBASE_OVERRIDES,
    lichess: LICHESS_OVERRIDES,
};

export function isKeymapPresetName(value: unknown): value is KeymapPresetName {
    return typeof value === "string" && (KEYMAP_PRESET_NAMES as readonly string[]).includes(value);
}

/** Expands `mod` to the platform modifier, like `keybinds.ts` does for its defaults. */
function normaliseKeys(keys: string): string {
    return keys.replace(/\bmod\b/g, meta);
}

/** The complete keymap of a preset: the Chessin defaults with the preset's overrides applied. */
export function presetKeyMap(name: KeymapPresetName, defaults: KeyMap = defaultKeyMap): KeyMap {
    const overrides = PRESET_OVERRIDES[name] ?? {};
    const result: KeyMap = {};
    for (const [action, keybind] of Object.entries(defaults)) {
        const keys = action in overrides ? normaliseKeys(overrides[action]) : keybind.keys;
        result[action] = { ...keybind, keys };
    }
    return result;
}

/** Pairs of actions bound to the same keys. Empty for a well-formed map. */
export function findCollisions(map: KeyMap): [string, string][] {
    const byKeys = new Map<string, string>();
    const collisions: [string, string][] = [];
    for (const [action, keybind] of Object.entries(map)) {
        const keys = keybind.keys.trim().toLowerCase();
        if (keys === "") continue;
        const other = byKeys.get(keys);
        if (other !== undefined) collisions.push([other, action]);
        else byKeys.set(keys, action);
    }
    return collisions;
}

/**
 * Rewrites `current` to the preset `name`, keeping the user's own overrides.
 *
 * An override is a binding that differs from the preset the user was on
 * (`previous`). It is carried over unless it collides with a binding of the
 * new preset (or with another carried-over override), in which case the new
 * preset wins. Actions unknown to the preset (e.g. from a newer build) are kept
 * as they are.
 */
export function applyPreset(
    name: KeymapPresetName,
    current: KeyMap,
    previous: KeymapPresetName = "chessin",
    defaults: KeyMap = defaultKeyMap,
): KeyMap {
    const base = presetKeyMap(previous, defaults);
    const next = presetKeyMap(name, defaults);
    const result: KeyMap = { ...next };

    for (const [action, keybind] of Object.entries(current)) {
        if (!keybind || typeof keybind.keys !== "string") continue;
        if (!(action in next)) {
            result[action] = { ...keybind };
            continue;
        }
        const keys = keybind.keys;
        const isOverride = base[action] === undefined || base[action].keys !== keys;
        if (!isOverride || keys === next[action].keys) continue;
        const collides = Object.entries(result).some(
            ([other, bound]) => other !== action && bound.keys.toLowerCase() === keys.toLowerCase(),
        );
        if (collides) continue;
        result[action] = { ...next[action], keys };
    }
    return result;
}

/** Number of actions in `current` whose keys differ from the preset `name`. */
export function countCustomised(
    current: KeyMap,
    name: KeymapPresetName,
    defaults: KeyMap = defaultKeyMap,
): number {
    const preset = presetKeyMap(name, defaults);
    let n = 0;
    for (const [action, keybind] of Object.entries(current)) {
        const bound = preset[action];
        if (bound !== undefined && bound.keys !== keybind.keys) n += 1;
    }
    return n;
}

/** Translated preset name for selects and notifications. */
export function presetLabel(name: KeymapPresetName, t: TFunction): string {
    switch (name) {
        case "chessin":
            return t("Keymap.Preset.Chessin");
        case "chessbase":
            return t("Keymap.Preset.ChessBase");
        case "lichess":
            return t("Keymap.Preset.Lichess");
    }
}

/**
 * The preset the user last applied. Overrides are measured against it when the
 * user switches preset (see `applyPreset`).
 */
export const keymapPresetAtom = atomWithStorage<KeymapPresetName>(
    "keymapPreset",
    "chessin",
    undefined,
    {
        getOnInit: true,
    },
);
