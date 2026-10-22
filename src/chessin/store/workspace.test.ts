import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
    type LibraryBackend,
} from "./libraryStore";
import {
    __resetWorkspaceForTests,
    mergeRestoredTabs,
    parseStoredTabs,
    restoreWorkspace,
    startWorkspacePersistence,
    suspendWorkspacePersistence,
    TABS_DEBOUNCE_MS,
    WORKSPACE_ACTIVE_TAB_KEY,
    WORKSPACE_CLEAN_EXIT_KEY,
    WORKSPACE_TABS_KEY,
    workspaceReadyAtom,
} from "./workspace";

function tab(value: string, type: Tab["type"] = "analysis"): Tab {
    return { name: value, value, type, gameOrigin: { kind: "none" } };
}

function recordingBackend() {
    const inner = createMemoryBackend();
    const sets: [string, string][] = [];
    const backend: LibraryBackend = {
        ...inner,
        async storeSet(key, value) {
            sets.push([key, value]);
            await inner.storeSet(key, value);
        },
    };
    return { backend, sets };
}

beforeEach(() => {
    sessionStorage.clear();
    __resetWorkspaceForTests();
    __setLibraryBackendForTests(null);
});

afterEach(() => {
    vi.useRealTimers();
    __resetWorkspaceForTests();
    __setLibraryBackendForTests(null);
});

describe("mergeRestoredTabs", () => {
    it("keeps the current tabs when nothing was saved", () => {
        const current = [tab("a")];
        expect(mergeRestoredTabs(current, "a", [], null)).toEqual({
            tabs: current,
            activeTab: "a",
        });
    });

    it("drops placeholder new tabs and appends tabs opened during startup", () => {
        const merged = mergeRestoredTabs(
            [tab("blank", "new"), tab("cli")],
            "cli",
            [tab("s1"), tab("s2")],
            "s2",
        );
        expect(merged.tabs.map((t) => t.value)).toEqual(["s1", "s2", "cli"]);
        expect(merged.activeTab).toBe("cli");
    });

    it("prefers the saved active tab, falling back to the first saved tab", () => {
        expect(
            mergeRestoredTabs([tab("blank", "new")], "blank", [tab("s1"), tab("s2")], "s2")
                .activeTab,
        ).toBe("s2");
        expect(mergeRestoredTabs([], null, [tab("s1"), tab("s2")], "gone").activeTab).toBe("s1");
    });

    it("parseStoredTabs drops malformed entries", () => {
        expect(parseStoredTabs(null)).toEqual([]);
        expect(parseStoredTabs("not json")).toEqual([]);
        expect(parseStoredTabs(JSON.stringify([tab("ok"), { value: "bad" }]))).toEqual([tab("ok")]);
    });
});

describe("startWorkspacePersistence", () => {
    it("writes workspace.tabs / workspace.activeTab once, 300 ms after the last change", async () => {
        vi.useFakeTimers();
        const { backend, sets } = recordingBackend();
        __setLibraryBackendForTests(backend);
        const store = createStore();
        const stop = startWorkspacePersistence(store, TABS_DEBOUNCE_MS);

        store.set(tabsAtom, [tab("a")]);
        store.set(tabsAtom, [tab("a"), tab("b")]);
        store.set(activeTabAtom, "b");
        await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS - 1);
        expect(sets).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(sets).toEqual([
            [WORKSPACE_TABS_KEY, JSON.stringify([tab("a"), tab("b")])],
            [WORKSPACE_ACTIVE_TAB_KEY, "b"],
        ]);

        // Only what changed is written again.
        store.set(activeTabAtom, "a");
        await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
        expect(sets).toHaveLength(3);
        expect(sets[2]).toEqual([WORKSPACE_ACTIVE_TAB_KEY, "a"]);

        suspendWorkspacePersistence();
        store.set(activeTabAtom, "b");
        await vi.advanceTimersByTimeAsync(TABS_DEBOUNCE_MS);
        expect(sets).toHaveLength(3);
        stop();
    });
});

describe("restoreWorkspace", () => {
    it("is a no-op without saved tabs and marks the workspace ready", async () => {
        const store = createStore();
        store.set(tabsAtom, [tab("fresh", "new")]);
        const result = await restoreWorkspace(store);
        expect(result).toMatchObject({ restored: false, crashRecovered: false });
        expect(store.get(workspaceReadyAtom)).toBe(true);
        expect(store.get(tabsAtom).map((t) => t.value)).toEqual(["fresh"]);
        await vi.waitFor(async () => expect(await getKv(WORKSPACE_CLEAN_EXIT_KEY)).toBe("0"));
    });

    it("restores tabs and tree mirrors, and flags an unclean previous run once", async () => {
        const backend = createMemoryBackend();
        __setLibraryBackendForTests(backend);
        const tree = JSON.stringify({ version: 0, state: { position: [0] } });
        await backend.storeSet(WORKSPACE_TABS_KEY, JSON.stringify([tab("s1"), tab("s2")]));
        await backend.storeSet(WORKSPACE_ACTIVE_TAB_KEY, "s2");
        await backend.storeSet(WORKSPACE_CLEAN_EXIT_KEY, "0");
        await backend.docPut({
            id: "s1",
            kind: "game",
            title: "s1",
            origin: null,
            data: tree,
            checkpoint: null,
        });

        const store = createStore();
        store.set(tabsAtom, [tab("blank", "new")]);
        store.set(activeTabAtom, "blank");

        const result = await restoreWorkspace(store);
        expect(result.restored).toBe(true);
        expect(result.crashRecovered).toBe(true);
        expect(store.get(tabsAtom).map((t) => t.value)).toEqual(["s1", "s2"]);
        expect(store.get(activeTabAtom)).toBe("s2");
        expect(sessionStorage.getItem("s1")).toBe(tree);
        expect(sessionStorage.getItem("s2")).toBeNull();
        expect(store.get(workspaceReadyAtom)).toBe(true);

        // A reload of the same webview session is not a crash.
        await backend.storeSet(WORKSPACE_CLEAN_EXIT_KEY, "0");
        expect((await restoreWorkspace(createStore())).crashRecovered).toBe(false);
    });

    it("does not flag a clean previous run", async () => {
        const backend = createMemoryBackend();
        __setLibraryBackendForTests(backend);
        await backend.storeSet(WORKSPACE_TABS_KEY, JSON.stringify([tab("s1")]));
        await backend.storeSet(WORKSPACE_CLEAN_EXIT_KEY, "1");
        const result = await restoreWorkspace(createStore());
        expect(result).toMatchObject({ restored: true, crashRecovered: false });
    });

    it("survives a failing store", async () => {
        __setLibraryBackendForTests({
            ...createMemoryBackend(),
            async storeGet() {
                throw new Error("no sqlite");
            },
            async storeSet() {
                throw new Error("no sqlite");
            },
        });
        const store = createStore();
        const result = await restoreWorkspace(store);
        expect(result.restored).toBe(false);
        expect(store.get(workspaceReadyAtom)).toBe(true);
    });
});
