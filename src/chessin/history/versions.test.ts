import { Chess, parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryVersionMeta } from "@/chessin/store/libraryStore";
import { createNode, defaultTree, type TreeState } from "@/utils/treeReducer";
import {
    __clearVersionDataCache,
    formatVersionTime,
    getCachedVersionData,
    hasVersionDataCommand,
    loadVersionData,
    mapVersions,
    parseTreeDocData,
    previewFromData,
    rememberVersionData,
    sortVersions,
} from "./versions";

function meta(id: number, createdAt: number, label: string | null = null): LibraryVersionMeta {
    return { id, docId: "tab-1", createdAt, label };
}

/** A tree with the main line 1. e4 e5 and the variation 1. d4. */
function sampleTree(): TreeState {
    const tree = defaultTree();
    tree.headers.white = "Alice";
    tree.headers.black = "Bob";
    tree.headers.result = "1-0";
    const pos = Chess.default();
    const e4 = parseUci("e2e4")!;
    pos.play(e4);
    const afterE4 = makeFen(pos.toSetup());
    const e5 = parseUci("e7e5")!;
    pos.play(e5);
    const afterE5 = makeFen(pos.toSetup());
    const d4pos = Chess.default();
    const d4 = parseUci("d2d4")!;
    d4pos.play(d4);
    const afterD4 = makeFen(d4pos.toSetup());

    const e5Node = createNode({ fen: afterE5, move: e5, san: "e5", halfMoves: 2 });
    const e4Node = createNode({ fen: afterE4, move: e4, san: "e4", halfMoves: 1 });
    e4Node.children.push(e5Node);
    const d4Node = createNode({ fen: afterD4, move: d4, san: "d4", halfMoves: 1 });
    tree.root.children.push(e4Node, d4Node);
    tree.position = [0, 0];
    return { ...tree, afterE5 } as TreeState & { afterE5: string };
}

function docData(state: TreeState): string {
    return JSON.stringify({ version: 0, state });
}

afterEach(() => {
    __clearVersionDataCache();
});

describe("sortVersions / mapVersions", () => {
    it("orders newest first, ties by id", () => {
        const sorted = sortVersions([meta(1, 100), meta(3, 300), meta(2, 300), meta(4, 50)]);
        expect(sorted.map((v) => v.id)).toEqual([3, 2, 1, 4]);
    });

    it("marks the newest version as current and attaches the document payload to it", () => {
        const rows = mapVersions([meta(1, 100, "one"), meta(2, 200)], "current-data", (id) =>
            id === 1 ? "old-data" : null,
        );
        expect(rows.map((r) => [r.id, r.current, r.label, r.data])).toEqual([
            [2, true, null, "current-data"],
            [1, false, "one", "old-data"],
        ]);
    });

    it("falls back to the cache for the newest version when the document is missing", () => {
        const rows = mapVersions([meta(5, 10)], null, () => "cached");
        expect(rows[0]).toMatchObject({ id: 5, current: true, data: "cached" });
        expect(mapVersions([], null)).toEqual([]);
    });
});

describe("parseTreeDocData", () => {
    it("reads the zustand StorageValue envelope and a bare state", () => {
        const state = sampleTree();
        const fromEnvelope = parseTreeDocData(docData(state));
        expect(fromEnvelope?.root.fen).toBe(INITIAL_FEN);
        expect(fromEnvelope?.position).toEqual([0, 0]);
        expect(fromEnvelope?.report).toEqual({ inProgress: false });
        const bare = parseTreeDocData(JSON.stringify(state));
        expect(bare?.headers.white).toBe("Alice");
    });

    it("rejects payloads that are not a tree", () => {
        expect(parseTreeDocData(null)).toBeNull();
        expect(parseTreeDocData("")).toBeNull();
        expect(parseTreeDocData("{not json")).toBeNull();
        expect(parseTreeDocData(JSON.stringify({ state: { headers: {} } }))).toBeNull();
        expect(parseTreeDocData(JSON.stringify({ state: { root: { fen: 3 } } }))).toBeNull();
        expect(parseTreeDocData("42")).toBeNull();
    });

    it("normalises a missing position and a stale report flag", () => {
        const state = sampleTree();
        const raw = JSON.stringify({
            version: 0,
            state: { ...state, position: "nope", report: { inProgress: true } },
        });
        const parsed = parseTreeDocData(raw);
        expect(parsed?.position).toEqual([]);
        expect(parsed?.report.inProgress).toBe(false);
    });
});

describe("previewFromData", () => {
    it("shows the final main-line position, its last move and the ply count", () => {
        const state = sampleTree() as TreeState & { afterE5: string };
        const preview = previewFromData(docData(state));
        expect(preview).not.toBeNull();
        expect(preview?.fen).toBe(state.afterE5);
        expect(preview?.lastMove).toBe("e7e5");
        expect(preview?.plies).toBe(2);
        expect(preview?.title).toBe("Alice - Bob");
        expect(preview?.result).toBe("1-0");
    });

    it("handles an empty tree and unreadable data", () => {
        const empty = previewFromData(docData(defaultTree()));
        expect(empty).toMatchObject({ fen: INITIAL_FEN, plies: 0, title: "", result: "*" });
        expect(empty?.lastMove).toBeUndefined();
        expect(previewFromData("garbage")).toBeNull();
        expect(previewFromData(undefined)).toBeNull();
    });
});

describe("formatVersionTime", () => {
    it("formats a timestamp for the locale and never throws", () => {
        const ms = Date.UTC(2026, 9, 22, 6, 5);
        expect(formatVersionTime(ms, "zh-CN")).toMatch(/2026/);
        expect(formatVersionTime(ms, "en-US")).toMatch(/2026/);
        expect(typeof formatVersionTime(ms, "xx-INVALID-locale")).toBe("string");
        expect(formatVersionTime(Number.NaN)).toBe("");
    });
});

describe("version payload cache", () => {
    it("remembers payloads per document and version", () => {
        rememberVersionData("tab-1", 7, "seven");
        expect(getCachedVersionData("tab-1", 7)).toBe("seven");
        expect(getCachedVersionData("tab-2", 7)).toBeNull();
        expect(getCachedVersionData("tab-1", 8)).toBeNull();
        __clearVersionDataCache();
        expect(getCachedVersionData("tab-1", 7)).toBeNull();
    });

    it("loadVersionData answers from the cache and stays null without the plugin command", async () => {
        expect(hasVersionDataCommand()).toBe(false);
        expect(await loadVersionData("tab-1", 1)).toBeNull();
        rememberVersionData("tab-1", 1, "data");
        expect(await loadVersionData("tab-1", 1)).toBe("data");
    });
});
