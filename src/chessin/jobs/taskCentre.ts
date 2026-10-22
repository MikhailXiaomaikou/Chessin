import i18n from "i18next";
import { atom, getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { pauseJobsAtom } from "./queue";

/** Popover state of the status-bar task centre (`TaskCentreChip`). */
export const taskCentreOpenAtom = atom(false);

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** Palette commands `jobs.open` / `jobs.pause`. Returns an unregister function. */
export function registerJobCommands(store: JotaiStore = getDefaultStore()): () => void {
    return registerCommands([
        {
            id: "jobs.open",
            section: "status",
            title: () => i18n.t("Jobs.Open"),
            aliases: ["jobs", "tasks", "queue", "background", "任务", "后台", "队列", "任务中心"],
            run: () => store.set(taskCentreOpenAtom, (open) => !open),
        },
        {
            id: "jobs.pause",
            section: "status",
            title: () => (store.get(pauseJobsAtom) ? i18n.t("Jobs.Resume") : i18n.t("Jobs.Pause")),
            aliases: ["pause", "resume", "jobs", "暂停", "继续", "后台任务"],
            run: () => store.set(pauseJobsAtom, !store.get(pauseJobsAtom)),
        },
    ]);
}
