import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { openNotebook } from "@/chessin/notebook/commands";
import { isQueueSettingsModalMounted, queueSettingsOpenAtom } from "./settings";

/**
 * Palette commands of the review queue: `queue.start` ("开始今日复习", key
 * `START_REVIEW` = T) and `queue.settings` ("复习队列设置").
 *
 * A mounted notebook page registers a starter through `setQueueStarter` so
 * the command starts the session in place; otherwise the command opens
 * `/notebook?review=true`, which runs the unified queue.
 */

export type QueueStarter = () => void;

let starter: QueueStarter | null = null;

export function setQueueStarter(next: QueueStarter | null): void {
    starter = next;
}

/** Clears the starter only when it is still `current` (unmount). */
export function clearQueueStarter(current: QueueStarter): void {
    if (starter === current) starter = null;
}

/** Starts today's queue: in place when the notebook is mounted, else by opening it. */
export function startQueueSession(): void {
    if (starter) {
        starter();
        return;
    }
    openNotebook({ review: true });
}

/** Opens the settings modal, showing the notebook first when no page hosts the modal. */
export function openQueueSettings(store = getDefaultStore()): void {
    store.set(queueSettingsOpenAtom, true);
    if (!isQueueSettingsModalMounted()) openNotebook();
}

let unregister: (() => void) | null = null;

/** Registers the palette commands once; returns the unregister function. */
export function registerQueueCommands(): () => void {
    if (!unregister) {
        const off = registerCommands([
            {
                id: "queue.start",
                section: "navigate",
                title: () => i18n.t("Queue.Command.Start"),
                shortcutKey: "START_REVIEW",
                aliases: [
                    "start review",
                    "today",
                    "queue",
                    "review queue",
                    "今日复习",
                    "复习队列",
                    "开始复习",
                    "今天",
                ],
                run: () => startQueueSession(),
            },
            {
                id: "queue.settings",
                section: "app",
                title: () => i18n.t("Queue.Command.Settings"),
                aliases: [
                    "queue settings",
                    "review settings",
                    "minutes cap",
                    "new cards per day",
                    "复习设置",
                    "队列设置",
                    "复习时长",
                    "新卡上限",
                ],
                run: () => openQueueSettings(),
            },
        ]);
        unregister = () => {
            off();
            unregister = null;
        };
    }
    return unregister;
}
