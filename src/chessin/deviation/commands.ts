import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { gameKeyForOrigin } from "@/chessin/review/model";
import { getCachedReview } from "@/chessin/review/selection";
import { getReview } from "@/chessin/review/store";
import { currentTabAtom } from "@/state/atoms";
import { checkDeviations } from "./actions";
import { type DeviationDoc, deviationMoveLabel } from "./detect";

/**
 * Palette command `deviation.check` ("检查开局偏离"): runs the detection for
 * the active tab's stored review and reports the outcome. Registered once
 * when this module is imported (`registerDeviationCommands` is idempotent).
 */

let unregister: (() => void) | null = null;

// Keys reached only through `tr` (spelled out for the extractor's removeUnusedKeys):
// t("Deviation.Command.Check") t("Deviation.Checked") t("Deviation.Failed")
// t("Deviation.NoReview") t("Deviation.NoColor") t("Deviation.NoRepertoire")
// t("Deviation.NoMatch") t("Deviation.None") t("Deviation.Mine.Desc") t("Deviation.Theirs.Desc")

function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

/** One sentence about a detection result (also used by the panel). */
export function describeDeviationDoc(doc: DeviationDoc): string {
    if (doc.status === "no_repertoire") {
        return tr("Deviation.NoRepertoire", {
            color: tr(doc.playerColor === "white" ? "Common.WHITE" : "Common.BLACK"),
        });
    }
    if (doc.status === "no_match" || !doc.repertoire) return tr("Deviation.NoMatch");
    const d = doc.deviation;
    if (!d) return tr("Deviation.None", { repertoire: doc.repertoire.name });
    const move = Math.max(1, Math.ceil(d.ply / 2));
    if (d.kind === "mine") {
        return tr("Deviation.Mine.Desc", {
            move,
            played: deviationMoveLabel(d.ply, d.playedSan),
            prepared: d.preparedSan ?? "?",
            repertoire: d.repertoire.name,
        });
    }
    return tr("Deviation.Theirs.Desc", {
        move,
        played: deviationMoveLabel(d.ply, d.playedSan),
        repertoire: d.repertoire.name,
    });
}

/** Runs the check for the active tab; notifies the result. */
export async function checkActiveTabDeviations(store = getDefaultStore()): Promise<boolean> {
    const tab = store.get(currentTabAtom);
    const gameKey = gameKeyForOrigin(tab?.gameOrigin);
    if (!tab || !gameKey) {
        notifications.show({ color: "yellow", message: tr("Review.NoOrigin") });
        return false;
    }
    const review = getCachedReview(gameKey) ?? (await getReview(gameKey));
    if (!review) {
        notifications.show({ color: "yellow", message: tr("Deviation.NoReview") });
        return false;
    }
    if (!review.playerColor) {
        notifications.show({ color: "yellow", message: tr("Deviation.NoColor") });
        return false;
    }
    try {
        const doc = await checkDeviations(review);
        if (!doc) return false;
        notifications.show({
            id: "chessin-deviation-check",
            title: tr("Deviation.Checked"),
            message: describeDeviationDoc(doc),
        });
        return true;
    } catch (error) {
        notifications.show({
            color: "red",
            title: tr("Common.Error"),
            message: tr("Deviation.Failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
        return false;
    }
}

export function registerDeviationCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();
    const hasKey = () => {
        const tab = store.get(currentTabAtom);
        return !!tab && gameKeyForOrigin(tab.gameOrigin) !== null;
    };
    unregister = registerCommands([
        {
            id: "deviation.check",
            section: "board",
            title: () => tr("Deviation.Command.Check"),
            aliases: [
                "deviation",
                "opening deviation",
                "检查开局偏离",
                "开局偏离",
                "偏离",
                "离开开局体系",
            ],
            enabled: hasKey,
            disabledReason: () => tr("Review.NoOrigin"),
            run: () => {
                void checkActiveTabDeviations(store);
            },
        },
    ]);
    return unregister;
}

registerDeviationCommands();
