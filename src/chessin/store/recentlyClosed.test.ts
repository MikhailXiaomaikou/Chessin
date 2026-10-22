import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";
import {
    clearRecentlyClosed,
    pushRecentlyClosed,
    RECENTLY_CLOSED_CAP,
    recentlyClosedAtom,
    reopenLastClosedTab,
} from "./recentlyClosed";

function tab(value: string, type: Tab["type"] = "analysis"): Tab {
    return { name: value, value, type, gameOrigin: { kind: "none" } };
}

const TREE = JSON.stringify({ version: 0, state: { position: [0] } });

beforeEach(() => {
    sessionStorage.clear();
});

describe("recentlyClosedAtom", () => {
    it("keeps the newest snapshots first and caps the list", () => {
        const store = createStore();
        for (let i = 0; i < RECENTLY_CLOSED_CAP + 2; i++) {
            pushRecentlyClosed(tab(`t${i}`), null, store);
        }
        const list = store.get(recentlyClosedAtom);
        expect(list).toHaveLength(RECENTLY_CLOSED_CAP);
        expect(list[0].tab.value).toBe(`t${RECENTLY_CLOSED_CAP + 1}`);
        expect(list[list.length - 1].tab.value).toBe("t2");

        store.set(recentlyClosedAtom, (prev) => [...prev, ...prev]);
        expect(store.get(recentlyClosedAtom)).toHaveLength(RECENTLY_CLOSED_CAP);

        clearRecentlyClosed(store);
        expect(store.get(recentlyClosedAtom)).toEqual([]);
    });

    it("captures the tree mirror and dedupes by tab id", () => {
        const store = createStore();
        sessionStorage.setItem("a", TREE);
        pushRecentlyClosed(tab("a"), undefined, store);
        pushRecentlyClosed(tab("b"), null, store);
        pushRecentlyClosed(tab("a"), undefined, store);

        const list = store.get(recentlyClosedAtom);
        expect(list.map((s) => s.tab.value)).toEqual(["a", "b"]);
        expect(list[0].treeState).toBe(TREE);
        expect(list[1].treeState).toBeNull();
    });
});

describe("reopenLastClosedTab", () => {
    it("re-adds the last closed tab, restores its tree and activates it", () => {
        const store = createStore();
        store.set(tabsAtom, [tab("keep")]);
        store.set(activeTabAtom, "keep");
        pushRecentlyClosed(tab("gone"), TREE, store);

        const reopened = reopenLastClosedTab(store);
        expect(reopened?.value).toBe("gone");
        expect(store.get(tabsAtom).map((t) => t.value)).toEqual(["keep", "gone"]);
        expect(store.get(activeTabAtom)).toBe("gone");
        expect(sessionStorage.getItem("gone")).toBe(TREE);
        expect(store.get(recentlyClosedAtom)).toEqual([]);
        expect(reopenLastClosedTab(store)).toBeNull();
    });

    it("uses a fresh id when the closed id is open again", () => {
        const store = createStore();
        store.set(tabsAtom, [tab("dup")]);
        pushRecentlyClosed(tab("dup"), TREE, store);

        const reopened = reopenLastClosedTab(store)!;
        expect(reopened.value).not.toBe("dup");
        expect(store.get(tabsAtom)).toHaveLength(2);
        expect(sessionStorage.getItem(reopened.value)).toBe(TREE);
    });

    it("replaces a lone untouched new tab like createTab does", () => {
        const store = createStore();
        store.set(tabsAtom, [tab("blank", "new")]);
        pushRecentlyClosed(tab("game"), null, store);

        reopenLastClosedTab(store);
        expect(store.get(tabsAtom).map((t) => t.value)).toEqual(["game"]);
    });
});
