import { registerDeviationListener } from "./actions";
import { registerDeviationCommands } from "./commands";

/**
 * Deviation cards (S4-3, teardown W2-2).
 *
 * - `detect.ts`   pure detection: a reviewed game against the repertoire trees
 * - `store.ts`    documents `kind: "deviation"`, id `dev:<gameKey>`, listeners
 * - `actions.ts`  repertoire loading, the `onReviewSaved` hook, card actions
 * - `commands.ts` palette command `deviation.check`
 * - `DeviationCards.tsx` the review panel mount (event badge + the card)
 */

let booted = false;

/** Registers the command and the review listener once (called from the route module). */
export function bootstrapDeviation(): void {
    if (booted) return;
    booted = true;
    registerDeviationCommands();
    registerDeviationListener();
}

export {
    checkDeviations,
    DEVIATION_CARD_PREFIX,
    deviationCardId,
    dismissDeviation,
    findOpenRepertoireStore,
    findRepertoireTab,
    handleReviewSaved,
    isDeviationListenerRegistered,
    loadRepertoireSources,
    locateDeviationNode,
    openRepertoireAtDeviation,
    registerDeviationListener,
    type RepertoireLoaderDeps,
    setAsMyMove,
    snoozeDeviation,
    trainLine,
} from "./actions";
export {
    checkActiveTabDeviations,
    describeDeviationDoc,
    registerDeviationCommands,
} from "./commands";
export * from "./detect";
export * from "./store";
