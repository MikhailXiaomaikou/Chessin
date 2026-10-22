import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { findConflicts, unifyConflict } from "./conflicts";
import { formatLine, formatLineWithMove, moveLabel } from "./lines";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();

function line(path: number[], sans: string[]) {
    store.getState().goToMove(path);
    store.getState().makeMoves({ payload: sans, changeHeaders: false });
}

beforeEach(() => {
    store.getState().setState(defaultTree());
});

describe("findConflicts", () => {
    it("finds a transposition answered with different moves", () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5", "Nf3"]);
        const conflicts = findConflicts(store.getState().root, "white");
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].moves).toEqual(["Nc3", "Nf3"]);
        expect(conflicts[0].occurrences.map((o) => [o.line, o.san])).toEqual([
            ["1.d4 d5 2.c4 e6", "Nc3"],
            ["1.d4 e6 2.c4 d5", "Nf3"],
        ]);
        expect(conflicts[0].halfMoves).toBe(4);
    });

    it("ignores identical replies and alternatives listed under one node", () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5", "Nc3"]);
        line([0, 0, 0, 0], ["Nf3"]); // alternative at the same node
        expect(findConflicts(store.getState().root, "white")).toEqual([]);
        // The opponent's choices are never conflicts.
        line([0], ["c5"]);
        expect(findConflicts(store.getState().root, "black")).toEqual([]);
    });

    it("only looks below the start node", () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5", "Nf3"]);
        expect(findConflicts(store.getState().root, "white", [0, 0])).toEqual([]);
    });
});

describe("unifyConflict", () => {
    it("adds the chosen move where missing and promotes it where it is a variation", () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5", "Nf3"]);
        line([0, 1, 0, 0], ["Nc3"]); // Nc3 exists as the second child here
        line([], ["c4", "e6", "d4", "d5", "Nf3"]); // third transposition, no Nc3 at all
        const [conflict] = findConflicts(store.getState().root, "white");
        expect(conflict.moves).toEqual(["Nf3", "Nc3"]);
        expect(conflict.occurrences.map((o) => o.line)).toEqual([
            "1.d4 d5 2.c4 e6",
            "1.d4 e6 2.c4 d5",
            "1.c4 e6 2.d4 d5",
        ]);
        store.getState().goToMove([0, 0]);
        const changed = unifyConflict(store, conflict, "Nc3");
        expect(changed).toBe(2);
        const root = store.getState().root;
        expect(getNodeAtPath(root, [0, 1, 0, 0]).children.map((c) => c.san)).toEqual([
            "Nc3",
            "Nf3",
        ]);
        expect(getNodeAtPath(root, [1, 0, 0, 0]).children.map((c) => c.san)).toEqual([
            "Nc3",
            "Nf3",
        ]);
        expect(store.getState().position).toEqual([0, 0]);
        expect(findConflicts(root, "white")).toEqual([]);
        expect(unifyConflict(store, conflict, "Nc3")).toBe(0);
    });
});

describe("line formatting", () => {
    it("formats move numbers for both colours", () => {
        line([], ["e4", "e5", "Nf3"]);
        const root = store.getState().root;
        expect(formatLine(root, [])).toBe("");
        expect(formatLine(root, [0, 0, 0])).toBe("1.e4 e5 2.Nf3");
        expect(formatLineWithMove(root, [0, 0, 0], "Nc6")).toBe("1.e4 e5 2.Nf3 Nc6");
        expect(formatLineWithMove(root, [0, 0], "Nc3")).toBe("1.e4 e5 2.Nc3");
        expect(formatLineWithMove(root, [], "d4")).toBe("1.d4");
        expect(moveLabel(1, "e4")).toBe("1.e4");
        expect(moveLabel(2, "e5")).toBe("1...e5");
    });
});
