import { registerEventsCommands } from "./commands";

/**
 * Event review page (S4-3, teardown W3-3).
 *
 * - `group.ts`      pure grouping of the user's games by `(event, site, year)`
 * - `themes.ts`     pure cross-game theme cards (≥ 3 supporting games)
 * - `load.ts`       rows from the account databases (event / site / round kept)
 * - `commands.ts`   palette command `events.open`
 * - `EventsPage.tsx` the `/events` route
 */

let booted = false;

/** Registers the palette command once (called from the route module). */
export function bootstrapEvents(): void {
    if (booted) return;
    booted = true;
    registerEventsCommands();
}

export {
    clearEventsNavigator,
    EVENTS_PATH,
    type EventsNavigator,
    type EventsTarget,
    eventsHref,
    openEvents,
    registerEventsCommands,
    setEventsNavigator,
} from "./commands";
export * from "./group";
export * from "./load";
export * from "./themes";
