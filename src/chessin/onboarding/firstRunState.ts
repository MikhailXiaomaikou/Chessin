import i18n from "i18next";
import { atomWithStorage } from "jotai/utils";
import { useSyncExternalStore } from "react";
import { registerCommand } from "@/chessin/commands/registry";

/**
 * Chessin first-run onboarding state.
 *
 * - `firstRunDoneAtom` persists whether the one-screen onboarding has been
 *   dismissed (Start / Skip / close). `getOnInit` avoids a flash of the modal
 *   for returning users on launch.
 * - `openFirstRun()` re-opens the screen later (NewTabHome card, command
 *   palette `firstRun.open`). It is a tiny external store so it can be called
 *   from outside React (command registry) without needing the jotai store.
 */

export const firstRunDoneAtom = atomWithStorage<boolean>("chessin.firstRunDone", false, undefined, {
    getOnInit: true,
});

let manuallyOpen = false;
let visible = false;
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

function getManuallyOpen() {
    return manuallyOpen;
}

/** Re-opens the onboarding screen even when it was already completed. */
export function openFirstRun(): void {
    if (manuallyOpen) return;
    manuallyOpen = true;
    emit();
}

/** Clears the manual-open request (the component also marks the run as done). */
export function closeFirstRun(): void {
    if (!manuallyOpen) return;
    manuallyOpen = false;
    emit();
}

/** Hook: true while a manual re-open is requested. */
export function useFirstRunManuallyOpen(): boolean {
    return useSyncExternalStore(subscribe, getManuallyOpen, getManuallyOpen);
}

/**
 * Reported by `<FirstRun />` so other modules can tell whether the modal is
 * currently showing (e.g. the root window drag-drop handler should not also
 * open dropped PGNs as tabs while the onboarding drop zone is active).
 */
export function setFirstRunVisible(next: boolean): void {
    visible = next;
}

export function isFirstRunOpen(): boolean {
    return visible;
}

registerCommand({
    id: "firstRun.open",
    title: () => i18n.t("FirstRun.Command.Open"),
    section: "help",
    run: () => openFirstRun(),
    aliases: ["onboarding", "first run", "bring your games", "新手引导", "带入棋谱", "导入棋谱"],
});
