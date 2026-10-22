import type { TFunction } from "i18next";

/**
 * Translated labels and grouping for the entries of `KeyMap` (src/state/keybinds.ts).
 *
 * Keys are spelled out literally so `i18next-cli extract` keeps them; an
 * unknown key falls back to the English `name` stored in the keymap.
 */
export function keybindLabel(key: string, t: TFunction, fallback = key): string {
    switch (key) {
        case "NEW_TAB":
            return t("Keymap.NEW_TAB");
        case "CLOSE_TAB":
            return t("Keymap.CLOSE_TAB");
        case "OPEN_FILE":
            return t("Keymap.OPEN_FILE");
        case "SAVE_FILE":
            return t("Keymap.SAVE_FILE");
        case "COPY_PGN":
            return t("Keymap.COPY_PGN");
        case "COMMAND_PALETTE":
            return t("Keymap.COMMAND_PALETTE");
        case "UNDO":
            return t("Keymap.UNDO");
        case "REDO":
            return t("Keymap.REDO");
        case "KEYBOARD_SHORTCUTS":
            return t("Keymap.KEYBOARD_SHORTCUTS");
        case "SWAP_ORIENTATION":
            return t("Keymap.SWAP_ORIENTATION");
        case "CLEAR_SHAPES":
            return t("Keymap.CLEAR_SHAPES");
        case "NEXT_MOVE":
            return t("Keymap.NEXT_MOVE");
        case "PREVIOUS_MOVE":
            return t("Keymap.PREVIOUS_MOVE");
        case "GO_TO_BRANCH_START":
            return t("Keymap.GO_TO_BRANCH_START");
        case "GO_TO_BRANCH_END":
            return t("Keymap.GO_TO_BRANCH_END");
        case "GO_TO_START":
            return t("Keymap.GO_TO_START");
        case "GO_TO_END":
            return t("Keymap.GO_TO_END");
        case "NEXT_BRANCH":
            return t("Keymap.NEXT_BRANCH");
        case "PREVIOUS_BRANCH":
            return t("Keymap.PREVIOUS_BRANCH");
        case "NEXT_BRANCHING":
            return t("Keymap.NEXT_BRANCHING");
        case "PREVIOUS_BRANCHING":
            return t("Keymap.PREVIOUS_BRANCHING");
        case "DELETE_MOVE":
            return t("Keymap.DELETE_MOVE");
        case "CYCLE_TABS":
            return t("Keymap.CYCLE_TABS");
        case "REVERSE_CYCLE_TABS":
            return t("Keymap.REVERSE_CYCLE_TABS");
        case "TOGGLE_EVAL_BAR":
            return t("Keymap.TOGGLE_EVAL_BAR");
        case "PRACTICE_TAB":
            return t("Keymap.PRACTICE_TAB");
        case "ANALYSIS_TAB":
            return t("Keymap.ANALYSIS_TAB");
        case "DATABASE_TAB":
            return t("Keymap.DATABASE_TAB");
        case "ANNOTATE_TAB":
            return t("Keymap.ANNOTATE_TAB");
        case "INFO_TAB":
            return t("Keymap.INFO_TAB");
        case "ANNOTATION_BRILLIANT":
            return t("Keymap.ANNOTATION_BRILLIANT");
        case "ANNOTATION_GOOD":
            return t("Keymap.ANNOTATION_GOOD");
        case "ANNOTATION_INTERESTING":
            return t("Keymap.ANNOTATION_INTERESTING");
        case "ANNOTATION_DUBIOUS":
            return t("Keymap.ANNOTATION_DUBIOUS");
        case "ANNOTATION_MISTAKE":
            return t("Keymap.ANNOTATION_MISTAKE");
        case "ANNOTATION_BLUNDER":
            return t("Keymap.ANNOTATION_BLUNDER");
        case "TOGGLE_ALL_ENGINES":
            return t("Keymap.TOGGLE_ALL_ENGINES");
        case "TOGGLE_BLUR":
            return t("Keymap.TOGGLE_BLUR");
        case "GENERATE_REPORT":
            return t("Keymap.GENERATE_REPORT");
        case "PREVIOUS_GAME":
            return t("Keymap.PREVIOUS_GAME");
        case "NEXT_GAME":
            return t("Keymap.NEXT_GAME");
        case "TOGGLE_SIDEBAR":
            return t("Keymap.TOGGLE_SIDEBAR");
        case "TOGGLE_TAB_BAR":
            return t("Keymap.TOGGLE_TAB_BAR");
        case "REOPEN_TAB":
            return t("Keymap.REOPEN_TAB");
        case "FIND_SIMILAR":
            return t("Keymap.FIND_SIMILAR");
        case "NAV_BACK":
            return t("Keymap.NAV_BACK");
        case "NAV_FORWARD":
            return t("Keymap.NAV_FORWARD");
        case "START_REVIEW":
            return t("Keymap.START_REVIEW");
        case "REVEAL":
            return t("Keymap.REVEAL");
        case "BOARD_FOCUS":
            return t("Keymap.BOARD_FOCUS");
        default:
            return fallback;
    }
}

export type KeymapGroup = {
    id: string;
    label: (t: TFunction) => string;
    keys: string[];
};

/** Cheat-sheet grouping. Keys missing here are listed under "Other". */
export const KEYMAP_GROUPS: KeymapGroup[] = [
    {
        id: "app",
        label: (t) => t("Keymap.Group.App"),
        keys: [
            "COMMAND_PALETTE",
            "KEYBOARD_SHORTCUTS",
            "NEW_TAB",
            "CLOSE_TAB",
            "REOPEN_TAB",
            "CYCLE_TABS",
            "REVERSE_CYCLE_TABS",
            "OPEN_FILE",
            "SAVE_FILE",
            "TOGGLE_SIDEBAR",
            "TOGGLE_TAB_BAR",
            "NAV_BACK",
            "NAV_FORWARD",
            "START_REVIEW",
        ],
    },
    {
        id: "edit",
        label: (t) => t("Keymap.Group.Edit"),
        keys: ["UNDO", "REDO", "COPY_PGN", "DELETE_MOVE", "CLEAR_SHAPES"],
    },
    {
        id: "navigation",
        label: (t) => t("Keymap.Group.Navigation"),
        keys: [
            "NEXT_MOVE",
            "PREVIOUS_MOVE",
            "GO_TO_START",
            "GO_TO_END",
            "GO_TO_BRANCH_START",
            "GO_TO_BRANCH_END",
            "NEXT_BRANCH",
            "PREVIOUS_BRANCH",
            "NEXT_BRANCHING",
            "PREVIOUS_BRANCHING",
            "NEXT_GAME",
            "PREVIOUS_GAME",
        ],
    },
    {
        id: "board",
        label: (t) => t("Keymap.Group.Board"),
        keys: [
            "SWAP_ORIENTATION",
            "TOGGLE_EVAL_BAR",
            "TOGGLE_BLUR",
            "TOGGLE_ALL_ENGINES",
            "GENERATE_REPORT",
            "FIND_SIMILAR",
            "BOARD_FOCUS",
        ],
    },
    {
        id: "annotations",
        label: (t) => t("Keymap.Group.Annotations"),
        keys: [
            "ANNOTATION_BRILLIANT",
            "ANNOTATION_GOOD",
            "ANNOTATION_INTERESTING",
            "ANNOTATION_DUBIOUS",
            "ANNOTATION_MISTAKE",
            "ANNOTATION_BLUNDER",
        ],
    },
    {
        id: "panels",
        label: (t) => t("Keymap.Group.Panels"),
        keys: ["ANALYSIS_TAB", "DATABASE_TAB", "ANNOTATE_TAB", "INFO_TAB", "PRACTICE_TAB"],
    },
];
