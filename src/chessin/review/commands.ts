import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { registerCommands } from "@/chessin/commands/registry";
import { getActiveTreeStore } from "@/chessin/keymap/treeStores";
import { currentTabAtom } from "@/state/atoms";
import { goToMoment } from "./applyLine";
import { gameKeyForOrigin, type PlayerColor, type ReviewPreset } from "./model";
import { enqueueReview, ReviewError } from "./reviewGame";
import { getCachedReview, selectedMomentFamily } from "./selection";
import { getReview } from "./store";

/**
 * Palette commands: `review.start`, `review.blunderCheck`, `review.next`,
 * `review.prev`. Registered once when this module is imported (the review
 * panel imports it; `registerReviewCommands` is idempotent).
 */

let unregister: (() => void) | null = null;

function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

export function reviewErrorMessage(error: unknown): string {
    if (error instanceof ReviewError) return tr(error.key);
    return String(error instanceof Error ? error.message : error);
}

/** Starts a background review of the active tab's game; notifies on success / failure. */
export async function startReviewForActiveTab(
    preset: ReviewPreset,
    playerColor: PlayerColor | null = null,
): Promise<boolean> {
    const store = getDefaultStore();
    const tab = store.get(currentTabAtom);
    if (!tab || !gameKeyForOrigin(tab.gameOrigin)) {
        notifications.show({ color: "yellow", message: tr("Review.NoOrigin") });
        return false;
    }
    try {
        await enqueueReview(tab.gameOrigin, { playerColor, preset, title: tab.name });
        notifications.show({ id: "chessin-review-queued", message: tr("Review.Queued.Notice") });
        return true;
    } catch (error) {
        notifications.show({
            color: "red",
            title: tr("Common.Error"),
            message: tr("Review.Failed", { error: reviewErrorMessage(error) }),
        });
        return false;
    }
}

/** Moves the selected key moment of the active tab by `delta` and shows it on the board. */
export async function stepMoment(delta: 1 | -1): Promise<boolean> {
    const store = getDefaultStore();
    const tab = store.get(currentTabAtom);
    if (!tab) return false;
    const gameKey = gameKeyForOrigin(tab.gameOrigin);
    if (!gameKey) return false;
    const review = getCachedReview(gameKey) ?? (await getReview(gameKey));
    if (!review || review.moments.length === 0) {
        notifications.show({ color: "yellow", message: tr("Review.Command.NoReview") });
        return false;
    }
    const atom = selectedMomentFamily(tab.value);
    const n = review.moments.length;
    const next = (((store.get(atom) + delta) % n) + n) % n;
    store.set(atom, next);
    const treeStore = getActiveTreeStore();
    if (treeStore) goToMoment(treeStore, review.moments[next]);
    return true;
}

export function registerReviewCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();
    const hasKey = () => {
        const tab = store.get(currentTabAtom);
        return !!tab && gameKeyForOrigin(tab.gameOrigin) !== null;
    };
    const hasReview = () => {
        const tab = store.get(currentTabAtom);
        const review = getCachedReview(gameKeyForOrigin(tab?.gameOrigin));
        return !!review && review.moments.length > 0;
    };

    unregister = registerCommands([
        {
            id: "review.start",
            section: "board",
            title: () => tr("Review.Command.Start"),
            aliases: ["review", "复盘", "开始复盘", "分析对局", "analyse game", "analyze game"],
            enabled: hasKey,
            disabledReason: () => tr("Review.NoOrigin"),
            run: () => {
                void startReviewForActiveTab("full");
            },
        },
        {
            id: "review.blunderCheck",
            section: "board",
            title: () => tr("Review.Command.BlunderCheck"),
            aliases: ["blunder check", "失误检查", "查失误", "快速复盘", "blunders"],
            enabled: hasKey,
            disabledReason: () => tr("Review.NoOrigin"),
            run: () => {
                void startReviewForActiveTab("blunder_check");
            },
        },
        {
            id: "review.next",
            section: "board",
            title: () => tr("Review.Command.Next"),
            aliases: ["next moment", "下一个关键时刻", "下一个失误"],
            enabled: hasReview,
            disabledReason: () => tr("Review.Command.NoReview"),
            run: () => {
                void stepMoment(1);
            },
        },
        {
            id: "review.prev",
            section: "board",
            title: () => tr("Review.Command.Prev"),
            aliases: ["previous moment", "上一个关键时刻", "上一个失误"],
            enabled: hasReview,
            disabledReason: () => tr("Review.Command.NoReview"),
            run: () => {
                void stepMoment(-1);
            },
        },
    ]);
    return unregister;
}

registerReviewCommands();
