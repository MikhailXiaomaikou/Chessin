import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { coldNodesAtom, findColdNodes, isColdNode } from "./cold";
import { toEpd } from "./model";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();

function line(path: number[], sans: string[]) {
    store.getState().goToMove(path);
    store.getState().makeMoves({ payload: sans, changeHeaders: false });
}

beforeEach(() => {
    store.getState().setState(defaultTree());
});

describe("findColdNodes", () => {
    it("flags lines below the threshold, inheriting reach down the line", () => {
        line([], ["e4", "e5", "Nf3", "Nc6"]);
        line([0], ["a6", "d4", "b5"]);
        const root = store.getState().root;
        const reach = new Map<string, number>([
            [getNodeAtPath(root, [0, 0]).id, 0.6],
            [getNodeAtPath(root, [0, 1]).id, 0.002],
        ]);
        const shelf = findColdNodes(root, reach, { color: "white", coldThreshold: 0.01 });
        expect(shelf.heads.map((h) => h.san)).toEqual(["a6"]);
        expect(shelf.nodes.map((n) => n.san)).toEqual(["a6", "d4", "b5"]);
        expect(shelf.nodes.every((n) => n.reach === 0.002)).toBe(true);
        expect(shelf.epds.has(toEpd(getNodeAtPath(root, [0, 1, 0]).fen))).toBe(true);
        expect(shelf.epds.has(toEpd(getNodeAtPath(root, [0, 0]).fen))).toBe(false);
        expect(shelf.epds.has(toEpd(root.fen))).toBe(false);
    });

    it("keeps an EPD warm when any occurrence is reached often enough", () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5", "Nc3"]);
        const root = store.getState().root;
        const warm = getNodeAtPath(root, [0, 0, 0, 0]);
        const cold = getNodeAtPath(root, [0, 1, 0, 0]);
        const reach = new Map<string, number>([
            [warm.id, 0.4],
            [cold.id, 0.001],
        ]);
        const shelf = findColdNodes(root, reach, { color: "white", coldThreshold: 0.01 });
        expect(shelf.nodes.map((n) => n.nodeId)).toContain(cold.id);
        expect(shelf.epds.has(toEpd(cold.fen))).toBe(false);
        expect(shelf.heads).toHaveLength(1);
    });

    it("never shelves the start node or the moves leading to it", () => {
        line([], ["e4", "e5", "Nf3", "Nc6"]);
        const root = store.getState().root;
        const reach = new Map<string, number>([[getNodeAtPath(root, [0, 0, 0]).id, 0]]);
        const shelf = findColdNodes(root, reach, {
            color: "white",
            coldThreshold: 0.01,
            startPath: [0, 0],
        });
        expect(shelf.nodes.map((n) => n.san)).toEqual(["Nf3", "Nc6"]);
        expect(shelf.heads.map((h) => h.path)).toEqual([[0, 0, 0]]);
        // The start node and the moves leading to it are never listed.
        expect(shelf.epds.has(toEpd(getNodeAtPath(root, [0, 0]).fen))).toBe(false);
        expect(shelf.epds.has(toEpd(getNodeAtPath(root, [0]).fen))).toBe(false);
    });
});

describe("isColdNode", () => {
    it("reads the shelf of the last check and accepts a full FEN", () => {
        const jotai = createStore();
        const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        expect(isColdNode(fen, jotai)).toBe(false);
        jotai.set(coldNodesAtom, {
            repertoireId: "rep:/x.pgn",
            threshold: 0.01,
            epds: new Set([toEpd(fen)]),
            count: 1,
        });
        expect(isColdNode(fen, jotai)).toBe(true);
        expect(isColdNode(toEpd(fen), jotai)).toBe(true);
        expect(isColdNode("8/8/8/8/8/8/8/8 w - - 0 1", jotai)).toBe(false);
    });
});
