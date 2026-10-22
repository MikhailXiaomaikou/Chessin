import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";
import {
    createShellHistory,
    goBack,
    goForward,
    HISTORY_CAP,
    type HistoryEntry,
    sameEntry,
    TRAVEL_GRACE_MS,
} from "./history";

function entry(route: string, tabId: string | null = null): HistoryEntry {
    return { route, tabId };
}

function tab(value: string, type: Tab["type"] = "analysis"): Tab {
    return { name: value, value, type, gameOrigin: { kind: "none" } };
}

/** A history with a fake clock the tests can advance. */
function makeHistory(cap = HISTORY_CAP) {
    let now = 1_000;
    const history = createShellHistory(cap, () => now);
    return { history, advance: (ms: number) => (now += ms) };
}

describe("shell history: recording", () => {
    it("appends places and ignores a repeat of the current one", () => {
        const { history } = makeHistory();
        history.record(entry("/"));
        history.record(entry("/", "t1"));
        history.record(entry("/", "t1"));
        history.record(entry("/files"));
        expect(history.entries()).toEqual([entry("/"), entry("/", "t1"), entry("/files")]);
        expect(history.index()).toBe(2);
        expect(history.current()).toEqual(entry("/files"));
    });

    it("tells tab switches on the board page apart", () => {
        const { history } = makeHistory();
        history.record(entry("/", "a"));
        history.record(entry("/", "b"));
        history.record(entry("/", "a"));
        expect(history.entries().map((e) => e.tabId)).toEqual(["a", "b", "a"]);
    });

    it("keeps the search string as part of the route", () => {
        const { history } = makeHistory();
        history.record(entry("/notebook"));
        history.record(entry("/notebook?review=true"));
        expect(history.entries()).toHaveLength(2);
    });

    it("drops the oldest places beyond the cap", () => {
        const { history } = makeHistory(5);
        for (let i = 0; i < 8; i++) history.record(entry(`/p${i}`));
        expect(history.entries().map((e) => e.route)).toEqual(["/p3", "/p4", "/p5", "/p6", "/p7"]);
        expect(history.index()).toBe(4);
        expect(HISTORY_CAP).toBe(50);
    });

    it("copies the entry so later mutation of the argument is not observed", () => {
        const { history } = makeHistory();
        const e = entry("/files");
        history.record(e);
        e.route = "/changed";
        expect(history.current()).toEqual(entry("/files"));
    });

    it("bumps the version and notifies subscribers on every change", () => {
        const { history } = makeHistory();
        const listener = vi.fn<() => void>();
        const unsubscribe = history.subscribe(listener);
        const v0 = history.version();
        history.record(entry("/"));
        history.record(entry("/")); // no-op
        expect(listener).toHaveBeenCalledTimes(1);
        expect(history.version()).toBe(v0 + 1);
        unsubscribe();
        history.record(entry("/files"));
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe("shell history: back and forward", () => {
    it("moves the cursor and reports what is reachable", () => {
        const { history } = makeHistory();
        expect(history.canBack()).toBe(false);
        expect(history.canForward()).toBe(false);
        expect(history.back()).toBeNull();

        history.record(entry("/"));
        history.record(entry("/files"));
        history.record(entry("/databases"));
        expect(history.canBack()).toBe(true);
        expect(history.canForward()).toBe(false);

        expect(history.back()).toEqual(entry("/files"));
        expect(history.back()).toEqual(entry("/"));
        expect(history.back()).toBeNull();
        expect(history.canBack()).toBe(false);
        expect(history.canForward()).toBe(true);

        expect(history.forward()).toEqual(entry("/files"));
        expect(history.forward()).toEqual(entry("/databases"));
        expect(history.forward()).toBeNull();
    });

    it("swallows the records the app emits while catching up with a travel", () => {
        const { history } = makeHistory();
        history.record(entry("/", "a"));
        history.record(entry("/files"));
        expect(history.back()).toEqual(entry("/", "a"));
        // Restoring the tab lands before the route change: an intermediate place.
        history.record(entry("/files"));
        history.record(entry("/", "a"));
        expect(history.entries()).toEqual([entry("/", "a"), entry("/files")]);
        expect(history.index()).toBe(0);
        expect(history.canForward()).toBe(true);
        // Once the target was seen, recording is live again.
        history.record(entry("/engines"));
        expect(history.entries()).toEqual([entry("/", "a"), entry("/engines")]);
        expect(history.canForward()).toBe(false);
    });

    it("resumes recording after the travel grace period even when the target never arrives", () => {
        const { history, advance } = makeHistory();
        history.record(entry("/"));
        history.record(entry("/files"));
        history.back();
        advance(TRAVEL_GRACE_MS + 1);
        history.record(entry("/settings"));
        expect(history.entries()).toEqual([entry("/"), entry("/settings")]);
    });

    it("recording after going back discards the forward places", () => {
        const { history } = makeHistory();
        history.record(entry("/a"));
        history.record(entry("/b"));
        history.record(entry("/c"));
        history.back();
        history.record(entry("/b")); // the app arrived
        history.record(entry("/d"));
        expect(history.entries().map((e) => e.route)).toEqual(["/a", "/b", "/d"]);
        expect(history.canForward()).toBe(false);
    });

    it("reset empties everything", () => {
        const { history } = makeHistory();
        history.record(entry("/a"));
        history.reset();
        expect(history.entries()).toEqual([]);
        expect(history.index()).toBe(-1);
        expect(history.current()).toBeNull();
    });
});

describe("shell history: pruning closed tabs", () => {
    it("removes invalid places and keeps the cursor on the current one", () => {
        const { history } = makeHistory();
        history.record(entry("/", "a"));
        history.record(entry("/", "closed"));
        history.record(entry("/files"));
        history.record(entry("/", "closed"));
        history.back(); // cursor on /files
        history.prune((e) => e.tabId !== "closed");
        expect(history.entries()).toEqual([entry("/", "a"), entry("/files")]);
        expect(history.current()).toEqual(entry("/files"));
        expect(history.canForward()).toBe(false);
    });

    it("falls back to the nearest earlier place when the current one is gone", () => {
        const { history } = makeHistory();
        history.record(entry("/files"));
        history.record(entry("/", "closed"));
        history.record(entry("/engines"));
        history.back(); // cursor on the closed tab
        history.prune((e) => e.tabId !== "closed");
        expect(history.current()).toEqual(entry("/files"));
        expect(history.canForward()).toBe(true);
        expect(history.forward()).toEqual(entry("/engines"));
    });

    it("is a no-op when everything is valid", () => {
        const { history } = makeHistory();
        history.record(entry("/a"));
        const v = history.version();
        history.prune(() => true);
        expect(history.version()).toBe(v);
    });
});

describe("goBack / goForward", () => {
    function setup() {
        const store = createStore();
        store.set(tabsAtom, [tab("a"), tab("b")]);
        store.set(activeTabAtom, "b");
        const { history } = makeHistory();
        const navigate = vi.fn<(href: string) => void>();
        return { store, history, navigate };
    }

    it("restores the tab and navigates to the route of the previous place", () => {
        const { store, history, navigate } = setup();
        history.record(entry("/", "a"));
        history.record(entry("/", "b"));
        history.record(entry("/files"));

        expect(goBack(navigate, store, history)).toBe(true);
        expect(store.get(activeTabAtom)).toBe("b");
        expect(navigate).toHaveBeenLastCalledWith("/");

        expect(goBack(navigate, store, history)).toBe(true);
        expect(store.get(activeTabAtom)).toBe("a");

        expect(goBack(navigate, store, history)).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(2);

        expect(goForward(navigate, store, history)).toBe(true);
        expect(store.get(activeTabAtom)).toBe("b");
        expect(goForward(navigate, store, history)).toBe(true);
        expect(navigate).toHaveBeenLastCalledWith("/files");
        expect(goForward(navigate, store, history)).toBe(false);
    });

    it("skips places whose tab has been closed", () => {
        const { store, history, navigate } = setup();
        history.record(entry("/", "a"));
        history.record(entry("/", "gone"));
        history.record(entry("/files"));

        expect(goBack(navigate, store, history)).toBe(true);
        expect(store.get(activeTabAtom)).toBe("a");
        expect(navigate).toHaveBeenLastCalledWith("/");
        expect(history.entries()).toEqual([entry("/", "a"), entry("/files")]);
    });

    it("leaves the active tab alone for places without a tab", () => {
        const { store, history, navigate } = setup();
        history.record(entry("/engines"));
        history.record(entry("/settings"));
        expect(goBack(navigate, store, history)).toBe(true);
        expect(store.get(activeTabAtom)).toBe("b");
        expect(navigate).toHaveBeenLastCalledWith("/engines");
    });
});

describe("sameEntry", () => {
    it("compares route and tab, and treats null as equal only to null", () => {
        expect(sameEntry(entry("/", "a"), entry("/", "a"))).toBe(true);
        expect(sameEntry(entry("/", "a"), entry("/", "b"))).toBe(false);
        expect(sameEntry(entry("/x"), entry("/y"))).toBe(false);
        expect(sameEntry(null, null)).toBe(true);
        expect(sameEntry(null, entry("/"))).toBe(false);
    });
});
