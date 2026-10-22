import { registerPrepCommands } from "./commands";
import { registerPrepReviewListener } from "./pack";

/**
 * Prep briefing v0 (备战), contract S4-2.
 *
 * - `candidates.ts`  who the opponent is: local databases + FIDE directory,
 *                    adults-only guard, explicit online-account links
 * - `briefing.ts`    pure briefing: overview, opening tree, leave-theory,
 *                    style, clash with my repertoire
 * - `movetext.ts`    SAN movetext replay (no Tauri)
 * - `pack.ts`        prep pack: pinned lines as `prep` notebook cards with a
 *                    比赛日, post-game self-assessment on `onReviewSaved`
 * - `commands.ts`    palette command `prep.open`
 * - `PrepPage`       the `/prep` route
 */

let booted = false;

/** Registers the command and the review listener once (called from the route module). */
export function bootstrapPrep(): void {
    if (booted) return;
    booted = true;
    registerPrepCommands();
    registerPrepReviewListener();
}

export * from "./briefing";
export * from "./candidates";
export { openPrep, PREP_PATH, prepHref, registerPrepCommands, setPrepNavigator } from "./commands";
export * from "./movetext";
export * from "./pack";
