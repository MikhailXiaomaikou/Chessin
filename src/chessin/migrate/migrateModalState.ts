import i18n from "i18next";
import { useSyncExternalStore } from "react";
import { registerCommand, runCommand } from "@/chessin/commands/registry";

/**
 * Open state of the "迁移 En Croissant 数据" modal (`MigrateModal`), kept as a
 * tiny external store so the command palette can open it without the jotai
 * store. The modal is hosted by the settings page (`MigrateSettingsButton`),
 * so the command navigates there first via the `app.settings` command.
 */

let open = false;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getOpen() {
    return open;
}

export function openMigrateModal(): void {
    if (open) return;
    open = true;
    emit();
}

export function closeMigrateModal(): void {
    if (!open) return;
    open = false;
    emit();
}

export function isMigrateModalOpen(): boolean {
    return open;
}

export function useMigrateModalOpen(): boolean {
    return useSyncExternalStore(subscribe, getOpen, getOpen);
}

export const MIGRATE_COMMAND_ID = "migrate.enCroissant";

registerCommand({
    id: MIGRATE_COMMAND_ID,
    title: () => i18n.t("Migrate.Action"),
    section: "app",
    aliases: [
        "en croissant",
        "encroissant",
        "migrate",
        "migration",
        "import engines",
        "迁移",
        "搬家",
        "导入 En Croissant",
    ],
    run: async () => {
        openMigrateModal();
        // Hosted by the settings page; a no-op when that command is not registered.
        await runCommand("app.settings");
    },
});
