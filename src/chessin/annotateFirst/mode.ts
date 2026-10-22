import { atom, getDefaultStore } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import { ALL_LAYERS_VISIBLE, type LayerVisibility } from "./layers";

/**
 * 先自己注释 mode state (S4-6, W3-4).
 *
 * - `annotateFirstFamily(tabId)`: the mode is on for that board tab. While it
 *   is on, the 讲解 tab shows `AnnotateFirstPanel` instead of the review:
 *   key moments without evaluation, a 我的思考 box per moment, `R` reveals.
 * - `revealedFamily(tabId)`: ids of the moments revealed so far (`"*"` = all).
 * - `layerVisibilityAtom`: which comment layers the panel's own notation
 *   view shows (persisted; never touches the upstream notation).
 */

export const annotateFirstFamily = atomFamily((_tabId: string) => atom(false));

/** Alias matching the contract's name. */
export function annotateFirstAtom(tabId: string) {
    return annotateFirstFamily(tabId);
}

export const REVEAL_ALL = "*";

export const revealedFamily = atomFamily((_tabId: string) => atom<Record<string, true>>({}));

export const layerVisibilityAtom = atomWithStorage<LayerVisibility>(
    "chessin.annotateFirst.layers",
    { ...ALL_LAYERS_VISIBLE },
    undefined,
    { getOnInit: true },
);

export function isAnnotateFirst(tabId: string | null | undefined): boolean {
    if (!tabId) return false;
    return getDefaultStore().get(annotateFirstFamily(tabId));
}

export function setAnnotateFirst(tabId: string, on: boolean): void {
    getDefaultStore().set(annotateFirstFamily(tabId), on);
}

/** Flips the mode for the tab and returns the new value. Turning it on hides every moment again. */
export function toggleAnnotateFirst(tabId: string): boolean {
    const store = getDefaultStore();
    const next = !store.get(annotateFirstFamily(tabId));
    store.set(annotateFirstFamily(tabId), next);
    if (next) store.set(revealedFamily(tabId), {});
    return next;
}

export function isRevealed(revealed: Record<string, true>, momentId: string): boolean {
    return revealed[REVEAL_ALL] === true || revealed[momentId] === true;
}

export function revealMoment(tabId: string, momentId: string): void {
    const store = getDefaultStore();
    const current = store.get(revealedFamily(tabId));
    if (isRevealed(current, momentId)) return;
    store.set(revealedFamily(tabId), { ...current, [momentId]: true });
}

export function revealAllMoments(tabId: string): void {
    getDefaultStore().set(revealedFamily(tabId), { [REVEAL_ALL]: true });
}

export function hideAllMoments(tabId: string): void {
    getDefaultStore().set(revealedFamily(tabId), {});
}
