import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { currentTabAtom } from "@/state/atoms";
import { defaultSourceAtom, tabSourceAtomFamily } from "./sources";

let unregister: (() => void) | null = null;

/**
 * Command-palette entries for sources. Searching "参考数据库" / "reference
 * database" lands here, since that hidden flag became the default source.
 */
export function registerSourceCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();

    unregister = registerCommands([
        {
            id: "sources.setDefault",
            title: () => i18n.t("Sources.SetDefault"),
            section: "sources",
            aliases: [
                "默认来源",
                "参考数据库",
                "来源",
                "default source",
                "reference database",
                "source",
            ],
            enabled: () => store.get(currentTabAtom) !== undefined,
            run: () => {
                const tab = store.get(currentTabAtom);
                if (!tab) return;
                const tabSource = tabSourceAtomFamily(tab.value);
                store.set(defaultSourceAtom, store.get(tabSource));
                store.set(tabSource, null);
            },
        },
    ]);
    return unregister;
}
