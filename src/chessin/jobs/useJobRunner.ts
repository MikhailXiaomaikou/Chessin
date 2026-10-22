import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { workspaceReadyAtom } from "@/chessin/store/workspace";
import { startJobRunner } from "./queue";
import { registerJobCommands } from "./taskCentre";

/**
 * If the workspace never reports ready (the index route was not mounted, so
 * `startWorkspace` never ran) the runner still starts after this long, so
 * queued jobs are not stranded.
 */
export const RUNNER_FALLBACK_MS = 15_000;

/**
 * Mount hook for `ChessinMounts`: registers the `jobs.*` commands and starts
 * the job runner once `workspaceReadyAtom` flips (tabs restored, library open).
 */
export function useJobRunner(): void {
    const ready = useAtomValue(workspaceReadyAtom);

    useEffect(() => registerJobCommands(), []);

    useEffect(() => {
        if (ready) {
            void startJobRunner();
            return;
        }
        const timer = setTimeout(() => {
            console.warn("[chessin] workspace not ready; starting the job runner anyway");
            void startJobRunner();
        }, RUNNER_FALLBACK_MS);
        return () => clearTimeout(timer);
    }, [ready]);
}
