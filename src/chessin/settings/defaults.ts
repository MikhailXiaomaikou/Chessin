/**
 * Registry of the settings rows that map to one persisted atom (plan X-10):
 * which atom a row edits, its default value and what an imported value may
 * look like. It drives the "已修改" dot and the per-row 重置 button in
 * SettingsPage, 重置全部, and 导出 / 导入设置 (`exportImport.ts`).
 *
 * `id` is the row id in `SettingsPage.tsx`'s `settings` array. Rows without
 * an entry (theme = Mantine colour scheme, language = i18next, the keybind
 * table, migrate / backup buttons) are simply unmarked. The defaults are
 * repeated here on purpose — `atomWithStorage` does not expose its initial
 * value — and `defaults.test.ts` checks them against a fresh store.
 */
import { backupDailyAtom } from "@/chessin/history/backup";
import { keymapPresetAtom } from "@/chessin/keymap/presets";
import { autoSyncAtom } from "@/chessin/sync/autoSync";
import equal from "fast-deep-equal";
import type { getDefaultStore, WritableAtom } from "jotai";
import { RESET } from "jotai/utils";
import {
    annotationPaletteAtom,
    autoPromoteAtom,
    autoSaveAtom,
    boardImageAtom,
    coverageMinGamesAtom,
    DEFAULT_PIECE_SET,
    enableBoardScrollAtom,
    eraseDrawablesOnClickAtom,
    flipBoardAfterMoveAtom,
    fontSizeAtom,
    forcedEnPassantAtom,
    is3dAtom,
    materialDisplayAtom,
    moveHighlightAtom,
    moveInputAtom,
    moveMethodAtom,
    moveNotationTypeAtom,
    nativeBarAtom,
    pieceSetAtom,
    practiceAutoDifficultyAtom,
    previewBoardOnHoverAtom,
    primaryColorAtom,
    showArrowsAtom,
    showConsecutiveArrowsAtom,
    showCoordinatesAtom,
    showDestsAtom,
    showVariationArrowsAtom,
    snapArrowsAtom,
    soundCollectionAtom,
    soundVolumeAtom,
    spellCheckAtom,
    storedDatabasesDirAtom,
    storedDocumentDirAtom,
    storedEnginesDirAtom,
    storedPuzzlesDirAtom,
} from "@/state/atoms";
import { defaultKeyMap, keyMapAtom } from "@/state/keybinds";

export type JotaiStore = ReturnType<typeof getDefaultStore>;

/** Any writable atom; the value type is erased so entries of different types share one list. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry
type AnyWritableAtom = WritableAtom<any, [any], void>;

export type SettingEntry = {
    /** Row id in SettingsPage (`settings[].id`), or a name for export-only entries. */
    id: string;
    atom: AnyWritableAtom;
    default: unknown;
    /** Whether an imported value is acceptable for this setting. */
    accept: (value: unknown) => boolean;
    /**
     * How to reset: `RESET` clears the stored value (atomWithStorage), `"value"`
     * writes the default (derived atoms that do not understand `RESET`).
     */
    reset?: "value";
    /** Reset together with this entry (the keymap goes with its preset). */
    also?: SettingEntry[];
};

const isBoolean = (v: unknown) => typeof v === "boolean";
const isString = (v: unknown) => typeof v === "string";
const isFiniteNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const oneOf =
    (...values: readonly string[]) =>
    (v: unknown) =>
        typeof v === "string" && values.includes(v);
const between = (min: number, max: number) => (v: unknown) =>
    isFiniteNumber(v) && (v as number) >= min && (v as number) <= max;
const isKeyMap = (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every(
        (bind) =>
            typeof bind === "object" &&
            bind !== null &&
            typeof (bind as { keys?: unknown }).keys === "string" &&
            typeof (bind as { name?: unknown }).name === "string",
    );

function entry<T>(
    id: string,
    atom: WritableAtom<T, [T | typeof RESET], void> | WritableAtom<T, [T], void>,
    def: T,
    accept: (value: unknown) => boolean,
    extra: Pick<SettingEntry, "reset" | "also"> = {},
): SettingEntry {
    return { id, atom: atom as AnyWritableAtom, default: def, accept, ...extra };
}

/** Export-only: the keybind table has no single row; it resets with the preset. */
const KEYBINDS_ENTRY = entry("keybinds", keyMapAtom, defaultKeyMap, isKeyMap);

export const SETTING_ENTRIES: readonly SettingEntry[] = [
    // board
    entry("piece-dest", showDestsAtom, true, isBoolean),
    entry("move-highlight", moveHighlightAtom, true, isBoolean),
    entry("arrows", showArrowsAtom, true, isBoolean),
    entry("variation-arrows", showVariationArrowsAtom, false, isBoolean),
    entry("move-notation", moveNotationTypeAtom, "symbols", oneOf("letters", "symbols")),
    entry("move-method", moveMethodAtom, "both", oneOf("drag", "select", "both")),
    entry("snap-arrows", snapArrowsAtom, true, isBoolean),
    entry("consecutive-arrows", showConsecutiveArrowsAtom, false, isBoolean),
    entry("erase-drawables", eraseDrawablesOnClickAtom, false, isBoolean),
    entry("auto-promote", autoPromoteAtom, true, isBoolean),
    entry("coordinates", showCoordinatesAtom, "no", oneOf("no", "edge", "all")),
    entry("auto-save", autoSaveAtom, false, isBoolean),
    entry("auto-sync", autoSyncAtom, true, isBoolean),
    entry("preview-board", previewBoardOnHoverAtom, true, isBoolean),
    entry("flip-board-after-move", flipBoardAfterMoveAtom, true, isBoolean),
    entry("scroll-moves", enableBoardScrollAtom, true, isBoolean),
    entry("material-display", materialDisplayAtom, "diff", oneOf("diff", "all")),
    // inputs
    entry("text-input", moveInputAtom, false, isBoolean),
    entry("spell-check", spellCheckAtom, false, isBoolean),
    // anarchy
    entry("forced-en-passant", forcedEnPassantAtom, false, isBoolean),
    // appearance
    entry("title-bar", nativeBarAtom, false, isBoolean),
    entry("font-size", fontSizeAtom, 100, between(50, 300)),
    entry("piece-set", pieceSetAtom, DEFAULT_PIECE_SET, isString, { reset: "value" }),
    entry("board-image", boardImageAtom, "gray.svg", isString),
    entry("3d-mode", is3dAtom, false, isBoolean),
    entry("accent-color", primaryColorAtom, "blue", isString),
    entry("annotation-palette", annotationPaletteAtom, "default", oneOf("default", "okabe-ito")),
    // repertoire
    entry("repertoire-depth", coverageMinGamesAtom, 50, between(1, 100_000)),
    entry(
        "repertoire-auto-difficulty",
        practiceAutoDifficultyAtom,
        "none",
        oneOf("none", "1", "2", "3", "4"),
    ),
    // keybinds
    entry("keymap-preset", keymapPresetAtom, "chessin", oneOf("chessin", "chessbase", "lichess"), {
        also: [KEYBINDS_ENTRY],
    }),
    KEYBINDS_ENTRY,
    // sound
    entry("volume", soundVolumeAtom, 0.8, between(0, 1)),
    entry("sound-collection", soundCollectionAtom, "standard", isString),
    // directories
    entry("files-directory", storedDocumentDirAtom, "", isString),
    entry("databases-directory", storedDatabasesDirAtom, "", isString),
    entry("engines-directory", storedEnginesDirAtom, "", isString),
    entry("puzzles-directory", storedPuzzlesDirAtom, "", isString),
    entry("library-backup", backupDailyAtom, true, isBoolean),
];

const byId = new Map(SETTING_ENTRIES.map((e) => [e.id, e]));

export function settingEntry(id: string): SettingEntry | undefined {
    return byId.get(id);
}

/** True when the stored value differs from the default (deep equality). */
export function isSettingModified(store: JotaiStore, id: string): boolean {
    const e = byId.get(id);
    if (!e) return false;
    return !equal(store.get(e.atom), e.default);
}

export function resetSetting(store: JotaiStore, id: string): void {
    const e = byId.get(id);
    if (!e) return;
    resetEntry(store, e);
    for (const other of e.also ?? []) resetEntry(store, other);
}

function resetEntry(store: JotaiStore, e: SettingEntry): void {
    store.set(e.atom, e.reset === "value" ? e.default : RESET);
}

/** Resets every registered setting, keybinds included. */
export function resetAllSettings(store: JotaiStore): void {
    for (const e of SETTING_ENTRIES) resetEntry(store, e);
}

/** Ids of the registered settings that currently differ from their default. */
export function modifiedSettingIds(store: JotaiStore): string[] {
    return SETTING_ENTRIES.filter((e) => !equal(store.get(e.atom), e.default)).map((e) => e.id);
}
