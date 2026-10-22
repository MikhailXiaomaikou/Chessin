import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import type { Tab } from "@/utils/tabs";
import {
    focusWorkspace,
    getWorkspaceNavigator,
    openInWorkspace,
    setWorkspaceNavigator,
    WORKSPACE_PATH,
    type WorkspaceNavigate,
} from "./openInWorkspace";

function tab(value: string, type: Tab["type"] = "analysis"): Tab {
    return { name: value, value, type, gameOrigin: { kind: "none" } };
}

function goTo(path: string) {
    window.history.replaceState(null, "", path);
}

beforeEach(() => {
    sessionStorage.clear();
    setWorkspaceNavigator(null);
    goTo("/files");
});

afterEach(() => {
    setWorkspaceNavigator(null);
    goTo(WORKSPACE_PATH);
});

// `pgn` is deliberately never passed: parsing goes through the Tauri `lex_pgn`
// command, which does not exist in vitest. Tab creation itself is `createTab`.

describe("openInWorkspace", () => {
    it("creates the tab on the given store, activates it and navigates home", async () => {
        const store = createStore();
        store.set(tabsAtom, [tab("existing")]);
        store.set(activeTabAtom, "existing");
        const navigate = vi.fn<WorkspaceNavigate>();

        const id = await openInWorkspace({
            tab: { name: "A - B", type: "analysis" },
            gameOrigin: { kind: "database", database: "/db/x.db3", gameId: 7 },
            navigate,
            store,
        });

        const tabs = store.get(tabsAtom);
        expect(tabs.map((t) => t.value)).toEqual(["existing", id]);
        expect(tabs[1]).toMatchObject({
            name: "A - B",
            type: "analysis",
            gameOrigin: { kind: "database", database: "/db/x.db3", gameId: 7 },
        });
        expect(store.get(activeTabAtom)).toBe(id);
        expect(navigate).toHaveBeenCalledWith({ to: "/" });
    });

    it("replaces a lone untouched 'new' tab (createTab semantics)", async () => {
        const store = createStore();
        store.set(tabsAtom, [tab("fresh", "new")]);
        store.set(activeTabAtom, "fresh");

        const id = await openInWorkspace({
            tab: { name: "Game", type: "analysis" },
            navigate: () => undefined,
            store,
        });

        expect(store.get(tabsAtom).map((t) => t.value)).toEqual([id]);
    });

    it("does not navigate when focus is false", async () => {
        const store = createStore();
        const navigate = vi.fn<WorkspaceNavigate>();
        await openInWorkspace({
            tab: { name: "Game", type: "analysis" },
            navigate,
            store,
            focus: false,
        });
        expect(navigate).not.toHaveBeenCalled();
    });

    it("falls back to the registered navigator for non-React callers", async () => {
        const store = createStore();
        const registered = vi.fn<WorkspaceNavigate>();
        setWorkspaceNavigator(registered);
        expect(getWorkspaceNavigator()).toBe(registered);

        await openInWorkspace({ tab: { name: "Game", type: "analysis" }, store });
        expect(registered).toHaveBeenCalledWith({ to: "/" });
    });

    it("prefers an explicit navigator over the registered one", async () => {
        const store = createStore();
        const registered = vi.fn<WorkspaceNavigate>();
        const explicit = vi.fn<WorkspaceNavigate>();
        setWorkspaceNavigator(registered);

        await openInWorkspace({
            tab: { name: "Game", type: "analysis" },
            store,
            navigate: explicit,
        });
        expect(explicit).toHaveBeenCalledTimes(1);
        expect(registered).not.toHaveBeenCalled();
    });
});

describe("focusWorkspace", () => {
    it("is a no-op when the board is already shown", () => {
        goTo(WORKSPACE_PATH);
        const navigate = vi.fn<WorkspaceNavigate>();
        focusWorkspace(navigate);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("pushes the board path through the browser history when no navigator is known", () => {
        const onPop = vi.fn<(e: PopStateEvent) => void>();
        window.addEventListener("popstate", onPop);
        try {
            focusWorkspace();
            expect(window.location.pathname).toBe(WORKSPACE_PATH);
            expect(onPop).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener("popstate", onPop);
        }
    });
});
