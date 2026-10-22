import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { atom, getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { getTreeStore } from "@/chessin/keymap/treeStores";
import { currentTabAtom, sessionsAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { getTabFile, type Tab } from "@/utils/tabs";
import { checkStateFamily, runRepertoireCheck } from "./check";
import { fillGap } from "./fill";
import { defaultMeta, loadRepertoireMeta, repertoireMetaId } from "./model";

/**
 * Palette commands `repertoire.check` and `repertoire.fillGap`. Registered
 * once when this module is imported (the check panel imports it).
 */

let unregister: (() => void) | null = null;

function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

export type ActiveRepertoire = {
    tab: Tab;
    filePath: string;
    title: string;
    repertoireId: string;
    treeStore: TreeStore;
};

/** The active tab when it shows a repertoire file with a mounted board. */
export function activeRepertoire(store = getDefaultStore()): ActiveRepertoire | null {
    const tab = store.get(currentTabAtom);
    const file = getTabFile(tab);
    if (!tab || !file || file.metadata.type !== "repertoire") return null;
    const treeStore = getTreeStore(tab.value);
    if (!treeStore) return null;
    return {
        tab,
        filePath: file.path,
        title: file.name,
        repertoireId: repertoireMetaId(file.path),
        treeStore,
    };
}

/** Runs the check of the active repertoire with its stored (or inferred) settings. */
export async function checkActiveRepertoire(store = getDefaultStore()): Promise<boolean> {
    const active = activeRepertoire(store);
    if (!active) {
        notifications.show({ color: "yellow", message: tr("Repertoire.Command.NotRepertoire") });
        return false;
    }
    const headers = active.treeStore.getState().headers;
    const { meta } = await loadRepertoireMeta(
        active.filePath,
        defaultMeta({
            color: headers.orientation ?? "white",
            startFen: headers.fen,
            sessions: store.get(sessionsAtom),
        }),
    );
    try {
        await runRepertoireCheck({
            treeStore: active.treeStore,
            repertoireId: active.repertoireId,
            meta,
            store,
        });
        return true;
    } catch (error) {
        notifications.show({
            color: "red",
            title: tr("Common.Error"),
            message: tr("Repertoire.Check.Failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
        return false;
    }
}

/** Gap the panel should show the replies for (set by `repertoire.fillGap`). */
export const pendingFillGapAtom = atom<string | null>(null);

/** Navigates to the top-ranked gap of the active repertoire and asks the panel for replies. */
export function fillTopGapOfActiveRepertoire(store = getDefaultStore()): boolean {
    const active = activeRepertoire(store);
    if (!active) {
        notifications.show({ color: "yellow", message: tr("Repertoire.Command.NotRepertoire") });
        return false;
    }
    const result = store.get(checkStateFamily(active.repertoireId)).result;
    const gap = result?.gaps[0];
    if (!gap) {
        notifications.show({ color: "yellow", message: tr("Repertoire.Command.NoGap") });
        return false;
    }
    if (!fillGap(active.treeStore, gap)) return false;
    store.set(pendingFillGapAtom, gap.id);
    return true;
}

export function registerRepertoireCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();
    const hasRepertoire = () => activeRepertoire(store) !== null;
    const hasGap = () => {
        const active = activeRepertoire(store);
        if (!active) return false;
        const result = store.get(checkStateFamily(active.repertoireId)).result;
        return !!result && result.gaps.length > 0;
    };
    unregister = registerCommands([
        {
            id: "repertoire.check",
            section: "board",
            title: () => tr("Repertoire.Command.Check"),
            aliases: ["检查开局体系", "开局体系", "覆盖率", "repertoire", "coverage", "check"],
            enabled: hasRepertoire,
            disabledReason: () => tr("Repertoire.Command.NotRepertoire"),
            run: () => {
                void checkActiveRepertoire(store);
            },
        },
        {
            id: "repertoire.fillGap",
            section: "board",
            title: () => tr("Repertoire.Command.FillGap"),
            aliases: ["填补缺口", "缺口", "fill gap", "gap"],
            enabled: hasGap,
            disabledReason: () =>
                hasRepertoire()
                    ? tr("Repertoire.Command.NoGap")
                    : tr("Repertoire.Command.NotRepertoire"),
            run: () => {
                fillTopGapOfActiveRepertoire(store);
            },
        },
    ]);
    return unregister;
}

registerRepertoireCommands();
