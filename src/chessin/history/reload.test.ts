import { Chess, parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTreeStore } from "@/chessin/keymap/treeStores";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    GAME_DOC_KIND,
    getDoc,
    listDocVersions,
    putDoc,
    VERSION_MERGE_MS,
} from "@/chessin/store/libraryStore";
import { resetSaveState } from "@/chessin/store/saveState";
import { resetTreePersistence } from "@/chessin/store/treePersist";
import { readSessionMirror, writeSessionMirror } from "@/state/store/debouncedStorage";
import { createTreeStore, type TreeStore, type TreeStoreState } from "@/state/store/tree";
import { createNode, defaultTree, type TreeState } from "@/utils/treeReducer";
import {
    __resetReloadForTests,
    applyTreeToStore,
    canUndoReload,
    isValidPath,
    pickPosition,
    reloadTabFromDoc,
    restoreVersionAndReload,
    undoReload,
} from "./reload";
import { __clearVersionDataCache, getCachedVersionData } from "./versions";

/** A tree whose main line is 1. e4 (and 1. e4 e5 when `long`). */
function tree(white: string, long = false): TreeState {
    const t = defaultTree();
    t.headers.white = white;
    t.headers.black = "Bob";
    const pos = Chess.default();
    const e4 = parseUci("e2e4")!;
    pos.play(e4);
    const e4Node = createNode({ fen: makeFen(pos.toSetup()), move: e4, san: "e4", halfMoves: 1 });
    t.root.children.push(e4Node);
    if (long) {
        const e5 = parseUci("e7e5")!;
        pos.play(e5);
        e4Node.children.push(
            createNode({ fen: makeFen(pos.toSetup()), move: e5, san: "e5", halfMoves: 2 }),
        );
    }
    t.position = long ? [0, 0] : [0];
    return t;
}

function data(state: TreeState): string {
    return JSON.stringify({ version: 0, state });
}

/** A minimal stand-in for a tree store: `getState()` with a recording `setState` action. */
function mockStore(initial: TreeState) {
    const setState = vi.fn<(next: TreeState) => void>((next) => {
        state = { ...state, ...next, canUndo: false, canRedo: false };
    });
    let state = {
        ...initial,
        canUndo: false,
        canRedo: false,
        setState,
    } as unknown as TreeStoreState;
    const store = {
        getState: () => state,
        setState: () => undefined,
        subscribe: () => () => undefined,
        getInitialState: () => state,
    } as unknown as TreeStore;
    return { store, setState, current: () => state };
}

const DOC = "tab-1";
let unregister: (() => void) | null = null;

beforeEach(() => {
    sessionStorage.clear();
    resetSaveState();
    resetTreePersistence();
    __resetReloadForTests();
    __clearVersionDataCache();
    __setLibraryBackendForTests(createMemoryBackend());
});

afterEach(() => {
    unregister?.();
    unregister = null;
    vi.useRealTimers();
    __setLibraryBackendForTests(null);
});

describe("path helpers", () => {
    it("validates paths against the tree and picks the best position", () => {
        const t = tree("Alice", true);
        expect(isValidPath(t.root, [])).toBe(true);
        expect(isValidPath(t.root, [0, 0])).toBe(true);
        expect(isValidPath(t.root, [0, 1])).toBe(false);
        expect(isValidPath(t.root, [1])).toBe(false);
        expect(pickPosition(t.root, [0, 0], [0])).toEqual([0, 0]);
        expect(pickPosition(t.root, [0, 1], [0])).toEqual([0]);
        expect(pickPosition(t.root, null, [0, 0])).toEqual([0, 0]);
        expect(pickPosition(t.root, [5], [7])).toEqual([]);
    });
});

describe("reloadTabFromDoc", () => {
    it("pushes the document into a mounted store through its setState action", async () => {
        const live = mockStore(tree("Alice"));
        unregister = registerTreeStore(DOC, live.store);
        const stored = tree("Carol", true);
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: data(stored) });

        const result = await reloadTabFromDoc(DOC);
        expect(result).toEqual({ applied: "store", tabId: DOC });
        expect(live.setState).toHaveBeenCalledTimes(1);
        const applied = live.setState.mock.calls[0][0];
        expect(applied.headers.white).toBe("Carol");
        expect(applied.root.children[0].children[0].san).toBe("e5");
        expect(applied.report).toEqual({ inProgress: false });
        expect(applied.dirty).toBe(false);
        // The live position [0] still exists in the reloaded tree: the board stays put.
        expect(applied.position).toEqual([0]);
        expect(canUndoReload(DOC)).toBe(true);
    });

    it("falls back to the stored position when the live one no longer exists", async () => {
        const live = mockStore(tree("Alice", true)); // at [0, 0]
        unregister = registerTreeStore(DOC, live.store);
        const stored = tree("Carol"); // only 1. e4, stored at [0]
        const result = await reloadTabFromDoc(DOC, {
            doc: {
                id: DOC,
                kind: GAME_DOC_KIND,
                title: "",
                origin: null,
                data: data(stored),
                updatedAt: 1,
            },
        });
        expect(result.applied).toBe("store");
        expect(live.setState.mock.calls[0][0].position).toEqual([0]);
        const again = await reloadTabFromDoc(DOC, {
            doc: {
                id: DOC,
                kind: GAME_DOC_KIND,
                title: "",
                origin: null,
                data: data(stored),
                updatedAt: 1,
            },
            keepPosition: false,
        });
        expect(again.applied).toBe("store");
        expect(live.setState.mock.calls[1][0].position).toEqual([0]);
    });

    it("seeds the session mirror when the tab is not mounted", async () => {
        const stored = tree("Carol");
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: data(stored) });
        writeSessionMirror(DOC, data(tree("Old")));
        const result = await reloadTabFromDoc(DOC);
        expect(result).toEqual({ applied: "mirror", tabId: DOC });
        expect(readSessionMirror(DOC)).toBe(data(stored));
        expect(canUndoReload(DOC)).toBe(true);
    });

    it("reports a missing document and unreadable data without touching the store", async () => {
        const live = mockStore(tree("Alice"));
        unregister = registerTreeStore(DOC, live.store);
        expect(await reloadTabFromDoc(DOC)).toEqual({
            applied: "none",
            tabId: DOC,
            reason: "no-document",
        });
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: "{broken" });
        expect(await reloadTabFromDoc(DOC)).toEqual({
            applied: "none",
            tabId: DOC,
            reason: "bad-data",
        });
        expect(live.setState).not.toHaveBeenCalled();
        expect(canUndoReload(DOC)).toBe(false);
    });
});

describe("undoReload", () => {
    it("swaps the previous state back, and swaps again on a second call", async () => {
        const live = mockStore(tree("Alice"));
        unregister = registerTreeStore(DOC, live.store);
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: data(tree("Carol", true)) });
        await reloadTabFromDoc(DOC);
        expect(live.current().headers.white).toBe("Carol");

        expect(undoReload(DOC)).toBe(true);
        expect(live.current().headers.white).toBe("Alice");
        expect(live.current().root.children[0].children).toHaveLength(0);
        expect(canUndoReload(DOC)).toBe(true);

        expect(undoReload(DOC)).toBe(true);
        expect(live.current().headers.white).toBe("Carol");
    });

    it("undoes a mirror-only reload and returns false when there is nothing to undo", async () => {
        expect(undoReload(DOC)).toBe(false);
        const old = data(tree("Old"));
        writeSessionMirror(DOC, old);
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: data(tree("New")) });
        await reloadTabFromDoc(DOC);
        expect(undoReload(DOC)).toBe(true);
        expect(readSessionMirror(DOC)).toBe(old);
    });
});

describe("restoreVersionAndReload", () => {
    it("restores the version in the library, reloads the tab and caches the payloads", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
        // The backend's clock must be the fake one, so the versions do not merge.
        __setLibraryBackendForTests(createMemoryBackend());
        const v1 = data(tree("One"));
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: v1, checkpoint: "one" });
        vi.setSystemTime(new Date("2026-10-22T10:01:00Z"));
        await putDoc({
            id: DOC,
            kind: GAME_DOC_KIND,
            title: "t",
            data: data(tree("Two")),
            checkpoint: "two",
        });
        // An unlabelled autosave well after the checkpoint: the newest version is automatic.
        vi.setSystemTime(Date.now() + VERSION_MERGE_MS + 1);
        const v3 = data(tree("Three", true));
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: v3 });
        writeSessionMirror(DOC, v3);
        const live = mockStore(tree("Three", true));
        unregister = registerTreeStore(DOC, live.store);
        const versions = await listDocVersions(DOC);
        const one = versions.find((v) => v.label === "one")!;
        expect(versions[0].label).toBeNull();

        const outcome = await restoreVersionAndReload(DOC, one.id, { beforeLabel: "恢复前" });
        expect(outcome).toEqual({
            ok: true,
            checkpointed: true,
            reload: { applied: "store", tabId: DOC },
        });
        expect((await getDoc(DOC))?.data).toBe(v1);
        expect(live.current().headers.white).toBe("One");
        expect(getCachedVersionData(DOC, one.id)).toBe(v1);
        const after = await listDocVersions(DOC);
        const safety = after.find((v) => v.label === "恢复前");
        expect(safety).toBeDefined();
        expect(getCachedVersionData(DOC, safety!.id)).toBe(v3);
        // Undo is available right after a restore.
        expect(undoReload(DOC)).toBe(true);
        expect(live.current().headers.white).toBe("Three");
    });

    it("skips the safety checkpoint when the newest version is already named", async () => {
        const v1 = data(tree("One"));
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: v1, checkpoint: "one" });
        await putDoc({
            id: DOC,
            kind: GAME_DOC_KIND,
            title: "t",
            data: data(tree("Two")),
            checkpoint: "two",
        });
        writeSessionMirror(DOC, data(tree("Two")));
        const one = (await listDocVersions(DOC)).find((v) => v.label === "one")!;
        const outcome = await restoreVersionAndReload(DOC, one.id, { beforeLabel: "恢复前" });
        expect(outcome).toMatchObject({ ok: true, checkpointed: false });
        expect((await listDocVersions(DOC)).some((v) => v.label === "恢复前")).toBe(false);
        expect(readSessionMirror(DOC)).toBe(v1);
    });

    it("reports a missing document or version", async () => {
        expect(await restoreVersionAndReload(DOC, 1)).toEqual({ ok: false, reason: "no-document" });
        await putDoc({ id: DOC, kind: GAME_DOC_KIND, title: "t", data: data(tree("One")) });
        expect(await restoreVersionAndReload(DOC, 999)).toEqual({
            ok: false,
            reason: "no-version",
        });
    });
});

describe("with a real tree store", () => {
    it("applies through the store's setState (ids ensured, history cleared) and undoes", async () => {
        const store = createTreeStore("tab-real");
        unregister = registerTreeStore("tab-real", store);
        store.getState().setHeaders({ ...store.getState().headers, white: "Live" });
        store.getState().makeMove({ payload: "e4" });
        expect(store.getState().canUndo).toBe(true);
        const stored = tree("Doc", true);

        applyTreeToStore(store, stored);
        expect(store.getState().headers.white).toBe("Doc");
        expect(store.getState().root.children[0].children[0].san).toBe("e5");
        expect(typeof store.getState().root.children[0].id).toBe("string");
        expect(store.getState().canUndo).toBe(false);
        expect(store.getState().root.fen).toBe(INITIAL_FEN);

        const result = await reloadTabFromDoc("tab-real", {
            doc: {
                id: "tab-real",
                kind: GAME_DOC_KIND,
                title: "",
                origin: null,
                data: data(tree("Doc2")),
                updatedAt: 1,
            },
        });
        expect(result.applied).toBe("store");
        expect(store.getState().headers.white).toBe("Doc2");
        expect(undoReload("tab-real")).toBe(true);
        expect(store.getState().headers.white).toBe("Doc");
    });
});
