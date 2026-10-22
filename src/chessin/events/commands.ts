import i18n from "i18next";
import { registerCommands } from "@/chessin/commands/registry";

/**
 * Palette command `events.open` ("赛事复盘"). Navigation follows the
 * notebook's pattern: a mounted `EventsPage` registers the router's
 * `navigate`; before any mounted, the path is pushed onto the browser
 * history the router listens to.
 */

export const EVENTS_PATH = "/events";

export type EventsTarget = { event?: string };
export type EventsNavigator = (target: EventsTarget) => void;

let navigator: EventsNavigator | null = null;

export function setEventsNavigator(next: EventsNavigator | null): void {
    navigator = next;
}

/** Clears the navigator only when it is still `current` (unmount of the component that set it). */
export function clearEventsNavigator(current: EventsNavigator): void {
    if (navigator === current) navigator = null;
}

export function eventsHref(target: EventsTarget = {}): string {
    return target.event ? `${EVENTS_PATH}?event=${encodeURIComponent(target.event)}` : EVENTS_PATH;
}

function navigateViaHistory(target: EventsTarget): void {
    if (typeof window === "undefined") return;
    try {
        window.history.pushState(window.history.state, "", eventsHref(target));
        window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
        // Not in a browser (tests).
    }
}

/** Shows the events page; with `{ event }` that event is selected. */
export function openEvents(target: EventsTarget = {}): void {
    if (navigator) {
        navigator(target);
        return;
    }
    navigateViaHistory(target);
}

let unregister: (() => void) | null = null;

// t("Events.Command.Open") — reached only through `tr`, spelled out for the extractor.

function tr(key: string): string {
    const value = i18n.t(key);
    return typeof value === "string" ? value : key;
}

/** Registers the palette command once; returns the unregister function. */
export function registerEventsCommands(): () => void {
    if (!unregister) {
        const off = registerCommands([
            {
                id: "events.open",
                section: "navigate",
                title: () => tr("Events.Command.Open"),
                aliases: [
                    "events",
                    "event review",
                    "tournament",
                    "赛事",
                    "赛事复盘",
                    "比赛复盘",
                    "按赛事",
                    "锦标赛",
                ],
                run: () => openEvents(),
            },
        ]);
        unregister = () => {
            off();
            unregister = null;
        };
    }
    return unregister;
}
