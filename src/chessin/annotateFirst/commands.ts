import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { getActiveTreeStore } from "@/chessin/keymap/treeStores";
import { currentTabAtom, currentTabSelectedAtom } from "@/state/atoms";
import { toggleAnnotateFirst } from "./mode";

/**
 * Palette command `annotateFirst.toggle`. Registered once at import time
 * (`registerAnnotateFirstCommands` is idempotent). Revealing is the `R` key
 * (keymap `REVEAL`) inside the panel.
 */

let unregister: (() => void) | null = null;

// Keys reached through `tr()` below, spelled out for the i18n extractor:
// t("AnnotateFirst.Command.Toggle") t("Palette.NoBoard")
function tr(key: string): string {
    const value = i18n.t(key);
    return typeof value === "string" ? value : key;
}

/** Toggles the mode for the active tab and shows the 讲解 dock tab when turning it on. */
export function toggleAnnotateFirstForActiveTab(): boolean | null {
    const store = getDefaultStore();
    const tab = store.get(currentTabAtom);
    if (!tab || !getActiveTreeStore()) return null;
    const on = toggleAnnotateFirst(tab.value);
    if (on) {
        try {
            store.set(currentTabSelectedAtom, "review");
        } catch {
            // No current tab: nothing to switch.
        }
    }
    return on;
}

export function registerAnnotateFirstCommands(): () => void {
    if (unregister) return unregister;
    unregister = registerCommands([
        {
            id: "annotateFirst.toggle",
            section: "board",
            title: () => tr("AnnotateFirst.Command.Toggle"),
            aliases: [
                "annotate first",
                "先自己注释",
                "自己注释",
                "先想一想",
                "我的思考",
                "think first",
            ],
            enabled: () => getActiveTreeStore() !== undefined,
            disabledReason: () => tr("Palette.NoBoard"),
            run: () => {
                toggleAnnotateFirstForActiveTab();
            },
        },
    ]);
    return unregister;
}

registerAnnotateFirstCommands();
