import { atom, getDefaultStore } from "jotai";
import { atomFamily } from "jotai/utils";
import type { GuessSession } from "./session";

/**
 * The running guess-the-move session per board tab (null = not started).
 * Lives outside React so the palette commands (`guess.reveal`, `guess.stop`)
 * and the panel share one state, and so the session survives the dock tab
 * being unmounted (`keepMounted={false}` in `BoardAnalysis`).
 */
export const guessSessionFamily = atomFamily((_tabId: string) => atom<GuessSession | null>(null));

export function getGuessSession(tabId: string | null | undefined): GuessSession | null {
    if (!tabId) return null;
    return getDefaultStore().get(guessSessionFamily(tabId));
}

export function setGuessSession(tabId: string, session: GuessSession | null): void {
    getDefaultStore().set(guessSessionFamily(tabId), session);
}
