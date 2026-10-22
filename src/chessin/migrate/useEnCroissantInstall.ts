import { warn } from "@tauri-apps/plugin-log";
import { useEffect, useState } from "react";
import { getKv } from "@/chessin/store/libraryStore";
import {
    detectEnCroissant,
    type EcInstall,
    hasMigratableData,
    MIGRATE_DONE_KEY,
} from "./ecMigrator";

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return typeof e === "string" ? e : String(e);
}

/**
 * First-run helper: the En Croissant installation to offer for migration, or
 * null when there is none, when it holds nothing to copy, or when a migration
 * was already recorded (`migrate.ec.done`). Detection runs once `enabled`
 * turns true.
 */
export function useEnCroissantInstall(enabled: boolean): EcInstall | null {
    const [install, setInstall] = useState<EcInstall | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        void (async () => {
            try {
                const [found, done] = await Promise.all([
                    detectEnCroissant(),
                    getKv(MIGRATE_DONE_KEY),
                ]);
                if (cancelled) return;
                setInstall(found && !done && hasMigratableData(found) ? found : null);
            } catch (e) {
                warn(`migrate: detection failed: ${errorMessage(e)}`);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [enabled]);

    return install;
}
