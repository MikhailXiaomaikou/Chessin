import { registerNotebookCommands } from "./commands";
import { registerReviewListener } from "./hooks";

/**
 * Mistake notebook (错题本), contract S2-5.
 *
 * - `cards.ts`     storage (S2-1 `card_*` commands, memory fallback) + FSRS
 * - `hooks.ts`     review → cards (`addCardsFromReview`, `registerReviewListener`)
 * - `migration.ts` legacy localStorage decks → `rp:<epd>` cards
 * - `commands.ts`  palette commands `notebook.open` / `notebook.review`
 * - `NotebookPage` the `/notebook` route; `TodayCard` the card on the "+" tab
 */

let booted = false;

/** Registers commands and the review listener once (called from the route module). */
export function bootstrapNotebook(): void {
    if (booted) return;
    booted = true;
    registerNotebookCommands();
    registerReviewListener();
}

export * from "./cards";
export * from "./chess";
export { openNotebook, registerNotebookCommands, setNotebookNavigator } from "./commands";
export * from "./hooks";
export * from "./migration";
export { gameKeyLabel, loadGameForKey, openGameForKey, parseGameKey } from "./source";
