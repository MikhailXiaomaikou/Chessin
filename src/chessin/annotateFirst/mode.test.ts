import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_LAYERS_VISIBLE } from "./layers";
import {
    annotateFirstAtom,
    annotateFirstFamily,
    hideAllMoments,
    isAnnotateFirst,
    isRevealed,
    layerVisibilityAtom,
    REVEAL_ALL,
    revealAllMoments,
    revealedFamily,
    revealMoment,
    setAnnotateFirst,
    toggleAnnotateFirst,
} from "./mode";

const store = getDefaultStore();

beforeEach(() => {
    for (const tab of ["t1", "t2"]) {
        store.set(annotateFirstFamily(tab), false);
        store.set(revealedFamily(tab), {});
    }
});

describe("annotate-first mode", () => {
    it("is per tab and toggles, hiding every moment again when turned on", () => {
        expect(isAnnotateFirst("t1")).toBe(false);
        expect(isAnnotateFirst(null)).toBe(false);
        revealMoment("t1", "m1");
        expect(toggleAnnotateFirst("t1")).toBe(true);
        expect(isAnnotateFirst("t1")).toBe(true);
        expect(isAnnotateFirst("t2")).toBe(false);
        expect(store.get(revealedFamily("t1"))).toEqual({});
        expect(toggleAnnotateFirst("t1")).toBe(false);
        setAnnotateFirst("t2", true);
        expect(store.get(annotateFirstAtom("t2"))).toBe(true);
        expect(annotateFirstAtom("t2")).toBe(annotateFirstFamily("t2"));
    });

    it("tracks revealed moments per tab, with reveal-all and hide-all", () => {
        revealMoment("t1", "m1");
        expect(isRevealed(store.get(revealedFamily("t1")), "m1")).toBe(true);
        expect(isRevealed(store.get(revealedFamily("t1")), "m2")).toBe(false);
        expect(isRevealed(store.get(revealedFamily("t2")), "m1")).toBe(false);
        const before = store.get(revealedFamily("t1"));
        revealMoment("t1", "m1");
        expect(store.get(revealedFamily("t1"))).toBe(before); // no-op keeps the reference
        revealAllMoments("t1");
        expect(store.get(revealedFamily("t1"))).toEqual({ [REVEAL_ALL]: true });
        expect(isRevealed(store.get(revealedFamily("t1")), "anything")).toBe(true);
        hideAllMoments("t1");
        expect(isRevealed(store.get(revealedFamily("t1")), "m1")).toBe(false);
    });

    it("shows every comment layer by default", () => {
        expect(store.get(layerVisibilityAtom)).toEqual(ALL_LAYERS_VISIBLE);
    });
});
