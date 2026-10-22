import i18n from "i18next";
import { registerCommands } from "@/chessin/commands/registry";

/**
 * Palette command of the prep page: `prep.open` ("备战"). Navigation works
 * like the notebook's: a mounted `PrepPage` registers the router's
 * `navigate`; before that, the path is pushed onto the browser history the
 * router listens to.
 */

export const PREP_PATH = "/prep";

export type PrepTarget = { q?: string };
export type PrepNavigator = (target: PrepTarget) => void;

let navigator: PrepNavigator | null = null;

export function setPrepNavigator(next: PrepNavigator | null): void {
    navigator = next;
}

/** Clears the navigator only when it is still `current` (unmount of the component that set it). */
export function clearPrepNavigator(current: PrepNavigator): void {
    if (navigator === current) navigator = null;
}

export function prepHref(target: PrepTarget = {}): string {
    return target.q ? `${PREP_PATH}?q=${encodeURIComponent(target.q)}` : PREP_PATH;
}

function navigateViaHistory(target: PrepTarget): void {
    if (typeof window === "undefined") return;
    try {
        window.history.pushState(window.history.state, "", prepHref(target));
        window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
        // Not in a browser (tests).
    }
}

/** Shows the prep page; with `{ q }` the search runs right away. */
export function openPrep(target: PrepTarget = {}): void {
    if (navigator) {
        navigator(target);
        return;
    }
    navigateViaHistory(target);
}

let unregister: (() => void) | null = null;

/** Registers the palette command once; returns the unregister function. */
export function registerPrepCommands(): () => void {
    if (!unregister) {
        const off = registerCommands([
            {
                id: "prep.open",
                section: "navigate",
                title: () => i18n.t("Prep.Title"),
                aliases: [
                    "prep",
                    "preparation",
                    "opponent",
                    "briefing",
                    "备战",
                    "对手",
                    "赛前准备",
                    "备战包",
                ],
                run: () => openPrep(),
            },
        ]);
        unregister = () => {
            off();
            unregister = null;
        };
    }
    return unregister;
}
