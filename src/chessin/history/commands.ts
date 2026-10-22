import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommand } from "@/chessin/commands/registry";
import { activeLibraryDocId, openHistoryDrawer } from "./drawerAtom";

/**
 * `history.open` — the palette entry for the version drawer. Enabled only
 * while the active tab is a library document (external files and databases
 * have no version history; "复制到棋谱库" gives them one).
 */

type JotaiStore = ReturnType<typeof getDefaultStore>;

let installed: (() => void) | null = null;

export function installHistoryCommands(store: JotaiStore = getDefaultStore()): () => void {
    if (installed) return installed;
    const off = registerCommand({
        id: "history.open",
        section: "file",
        title: () => i18n.t("History.Open"),
        aliases: [
            "history",
            "versions",
            "version history",
            "checkpoint",
            "restore",
            "历史",
            "历史版本",
            "版本",
            "版本历史",
            "存档点",
            "恢复",
        ],
        enabled: () => activeLibraryDocId(store) !== null,
        disabledReason: () => i18n.t("History.NotLibrary"),
        run: () => {
            openHistoryDrawer(store);
        },
    });
    installed = () => {
        off();
        installed = null;
    };
    return installed;
}

/** Test helper. */
export function __resetHistoryCommandsForTests(): void {
    installed?.();
}

if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
    installHistoryCommands();
}
