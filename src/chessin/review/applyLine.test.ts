import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, treeIteratorMainLine } from "@/utils/treeReducer";
import {
    applyLineAsVariation,
    goToMoment,
    locateMomentNode,
    locateMomentParent,
} from "./applyLine";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();
const SANS = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];

function mainLine() {
    return Array.from(treeIteratorMainLine(store.getState().root)).map((x) => x.node);
}

beforeEach(() => {
    store.getState().setState(defaultTree());
    store.getState().makeMoves({ payload: SANS });
});

describe("locating moments", () => {
    it("finds the parent and the node by node id", () => {
        const nodes = mainLine();
        const locator = { nodeId: nodes[6].id, ply: 6, fenBefore: nodes[5].fen };
        expect(locateMomentParent(store.getState().root, locator)).toEqual([0, 0, 0, 0, 0]);
        expect(locateMomentNode(store.getState().root, locator)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("falls back to the main-line ply and then to any node with the FEN", () => {
        const nodes = mainLine();
        const byPly = { ply: 6, fenBefore: nodes[5].fen };
        expect(locateMomentParent(store.getState().root, byPly)).toEqual([0, 0, 0, 0, 0]);
        const staleId = { nodeId: "not-in-this-tree", ply: 6, fenBefore: nodes[5].fen };
        expect(locateMomentParent(store.getState().root, staleId)).toEqual([0, 0, 0, 0, 0]);
        const wrongPly = { ply: 2, fenBefore: nodes[5].fen };
        expect(locateMomentParent(store.getState().root, wrongPly)).toEqual([0, 0, 0, 0, 0]);
        expect(
            locateMomentParent(store.getState().root, {
                ply: 3,
                fenBefore: "8/8/8/8/8/8/8/8 w - - 0 1",
            }),
        ).toBeNull();
    });

    it("navigates the board to the moment", () => {
        const nodes = mainLine();
        expect(goToMoment(store, { ply: 4, fenBefore: nodes[3].fen })).toBe(true);
        expect(store.getState().position).toEqual([0, 0, 0, 0]);
        expect(goToMoment(store, { ply: 4, fenBefore: "8/8/8/8/8/8/8/8 w - - 0 1" })).toBe(false);
    });
});

describe("applyLineAsVariation", () => {
    it("adds the line under the parent as an undoable variation", () => {
        const nodes = mainLine();
        const locator = { nodeId: nodes[6].id, ply: 6, fenBefore: nodes[5].fen };
        const resultBefore = store.getState().headers.result;
        const result = applyLineAsVariation(store, locator, ["g7g6", "h5f3", "f8g7"]);
        expect(result).toEqual({ path: [0, 0, 0, 0, 0, 1, 0, 0], plies: 3 });

        const parent = store.getState().getNode([0, 0, 0, 0, 0])!;
        expect(parent.children.map((c) => c.san)).toEqual(["Nf6", "g6"]);
        expect(parent.children[1].children[0].san).toBe("Qf3");
        expect(parent.children[1].children[0].children[0].san).toBe("Bg7");
        expect(store.getState().position).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
        expect(store.getState().headers.result).toBe(resultBefore);

        expect(store.getState().canUndo).toBe(true);
        store.getState().undo();
        expect(
            store
                .getState()
                .getNode([0, 0, 0, 0, 0])!
                .children.map((c) => c.san),
        ).toEqual(["Nf6"]);
    });

    it("reuses an existing child and keeps the legal prefix only", () => {
        const nodes = mainLine();
        const locator = { ply: 6, fenBefore: nodes[5].fen };
        expect(applyLineAsVariation(store, locator, ["g8f6", "a1a8"])).toEqual({
            path: [0, 0, 0, 0, 0, 0],
            plies: 1,
        });
        expect(store.getState().getNode([0, 0, 0, 0, 0])!.children).toHaveLength(1);
        expect(applyLineAsVariation(store, locator, ["a1a8"])).toBeNull();
        expect(applyLineAsVariation(store, locator, ["g7g6", "h5f3"], 1)).toEqual({
            path: [0, 0, 0, 0, 0, 1],
            plies: 1,
        });
    });

    it("returns null when the position is not in the tree", () => {
        expect(
            applyLineAsVariation(store, { ply: 3, fenBefore: "8/8/8/8/8/8/8/8 w - - 0 1" }, [
                "e2e4",
            ]),
        ).toBeNull();
    });
});
