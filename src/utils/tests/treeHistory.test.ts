import { notifications } from "@mantine/notifications";
import { parseUci } from "chessops";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTreeStore, TREE_HISTORY_CAP } from "@/state/store/tree";
import {
    createNode,
    defaultTree,
    ensureNodeIds,
    getNodeById,
    type TreeNode,
    treeIterator,
} from "@/utils/treeReducer";

const e4 = parseUci("e2e4")!;
const e5 = parseUci("e7e5")!;
const d5 = parseUci("d7d5")!;

const store = createTreeStore();

beforeEach(() => {
    store.getState().setState(defaultTree());
    notifications.clean();
});

const mainlineSans = () => {
    const sans: string[] = [];
    let node = store.getState().root;
    while (node.children.length > 0) {
        node = node.children[0];
        sans.push(node.san ?? "");
    }
    return sans;
};

const allIds = (root: TreeNode) => Array.from(treeIterator(root), ({ node }) => node.id);

describe("node ids", () => {
    test("defaultTree root has an id", () => {
        const tree = defaultTree();
        expect(typeof tree.root.id).toBe("string");
        expect(tree.root.id.length).toBeGreaterThan(0);
        expect(defaultTree().root.id).not.toBe(tree.root.id);
    });

    test("createNode assigns a unique id", () => {
        const a = createNode({ fen: "x", move: e4, san: "e4", halfMoves: 1 });
        const b = createNode({ fen: "x", move: e4, san: "e4", halfMoves: 1 });
        expect(a.id).toBeTruthy();
        expect(a.id).not.toBe(b.id);
    });

    test("makeMove and addAnalysis produce nodes with ids", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: parseUci("f7f6")! });
        store.getState().goToStart();
        // f6 is a blunder (+0.1 -> +9.0 for white), so with showVariations the
        // engine line d7d5 d2d4 is added under e4 as a new variation.
        store.getState().addAnalysis(
            [
                { best: [best(["e2e4"], 10)], novelty: false, is_sacrifice: false },
                { best: [best(["d7d5", "d2d4"], 10)], novelty: false, is_sacrifice: false },
                { best: [best(["d1h5"], 900)], novelty: false, is_sacrifice: false },
            ],
            { showVariations: true },
        );
        const { root } = store.getState();
        expect(root.children[0].children.map((c) => c.san)).toEqual(["f6", "d5"]);
        expect(root.children[0].children[1].children[0].san).toBe("d4");
        const ids = allIds(root);
        expect(ids.length).toBe(5);
        expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("ids are stable across edits elsewhere in the tree", () => {
        store.getState().makeMove({ payload: e4 });
        const e4Id = store.getState().root.children[0].id;
        store.getState().makeMove({ payload: e5 });
        store.getState().setComment("hi");
        expect(store.getState().root.children[0].id).toBe(e4Id);
    });

    test("getNodeById returns node and path", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        store.getState().goToMove([0]);
        store.getState().makeMove({ payload: d5 });
        const { root } = store.getState();
        const target = root.children[0].children[1];
        expect(getNodeById(root, target.id)).toEqual({ node: target, path: [0, 1] });
        expect(getNodeById(root, root.id)).toEqual({ node: root, path: [] });
        expect(getNodeById(root, "nope")).toBeNull();
    });

    test("ensureNodeIds fills in missing ids (in place, and for frozen trees)", () => {
        const bare = defaultTree().root;
        const child = createNode({ fen: "x", move: e4, san: "e4", halfMoves: 1 });
        // simulate a tree that came from storage without ids
        (child as { id?: string }).id = undefined;
        bare.children.push(child);
        const same = ensureNodeIds(bare);
        expect(same).toBe(bare);
        expect(child.id).toBeTruthy();

        const frozen = Object.freeze({
            ...defaultTree().root,
            children: [Object.freeze({ ...child, id: "" })],
        }) as TreeNode;
        const fixed = ensureNodeIds(frozen);
        expect(fixed).not.toBe(frozen);
        expect(fixed.children[0].id).toBeTruthy();
        expect(frozen.children[0].id).toBe("");
    });

    test("setState assigns ids to trees that lack them", () => {
        const tree = defaultTree();
        (tree.root as { id?: string }).id = undefined;
        store.getState().setState(tree);
        expect(store.getState().root.id).toBeTruthy();
    });
});

describe("undo / redo", () => {
    test("starts with nothing to undo or redo", () => {
        expect(store.getState().canUndo).toBe(false);
        expect(store.getState().canRedo).toBe(false);
        store.getState().undo();
        store.getState().redo();
        expect(mainlineSans()).toEqual([]);
    });

    test("undo/redo makeMove", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        expect(mainlineSans()).toEqual(["e4", "e5"]);
        expect(store.getState().position).toEqual([0, 0]);
        expect(store.getState().canUndo).toBe(true);
        expect(store.getState().canRedo).toBe(false);

        store.getState().undo();
        expect(mainlineSans()).toEqual(["e4"]);
        expect(store.getState().position).toEqual([0]);
        expect(store.getState().canUndo).toBe(true);
        expect(store.getState().canRedo).toBe(true);

        store.getState().undo();
        expect(mainlineSans()).toEqual([]);
        expect(store.getState().position).toEqual([]);
        expect(store.getState().canUndo).toBe(false);
        expect(store.getState().canRedo).toBe(true);

        store.getState().redo();
        store.getState().redo();
        expect(mainlineSans()).toEqual(["e4", "e5"]);
        expect(store.getState().position).toEqual([0, 0]);
        expect(store.getState().canRedo).toBe(false);
    });

    test("a new action after undo clears the redo stack", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        store.getState().undo();
        expect(store.getState().canRedo).toBe(true);
        store.getState().makeMove({ payload: d5 });
        expect(store.getState().canRedo).toBe(false);
        store.getState().redo();
        expect(mainlineSans()).toEqual(["e4", "d5"]);
    });

    test("undo/redo deleteMove restores the subtree with the same ids", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        const e4Id = store.getState().root.children[0].id;
        const e5Id = store.getState().root.children[0].children[0].id;

        store.getState().deleteMove([0]);
        expect(mainlineSans()).toEqual([]);
        expect(store.getState().position).toEqual([]);

        store.getState().undo();
        expect(mainlineSans()).toEqual(["e4", "e5"]);
        expect(store.getState().root.children[0].id).toBe(e4Id);
        expect(store.getState().root.children[0].children[0].id).toBe(e5Id);
        expect(store.getState().position).toEqual([0, 0]);

        store.getState().redo();
        expect(mainlineSans()).toEqual([]);
    });

    test("deleteMove shows a notification whose button undoes", () => {
        const show = vi.spyOn(notifications, "show");
        store.getState().makeMove({ payload: e4 });
        store.getState().deleteMove([0]);
        expect(show).toHaveBeenCalledTimes(1);
        const message = show.mock.calls[0][0].message as React.ReactElement<{
            children: React.ReactElement<{ onClick: () => void }>[];
        }>;
        const button = message.props.children[1];
        button.props.onClick();
        expect(mainlineSans()).toEqual(["e4"]);
        show.mockRestore();
    });

    test("deleteMove with nothing to delete shows no notification", () => {
        const show = vi.spyOn(notifications, "show");
        store.getState().deleteMove([]);
        expect(show).not.toHaveBeenCalled();
        show.mockRestore();
    });

    test("undo/redo setComment", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().setComment("first");
        store.getState().setComment("second");
        const node = () => store.getState().root.children[0];
        expect(node().comment).toBe("second");
        store.getState().undo();
        expect(node().comment).toBe("first");
        store.getState().undo();
        expect(node().comment).toBe("");
        store.getState().redo();
        expect(node().comment).toBe("first");
    });

    test("undo/redo setFen restores the wiped tree", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        const fen = "rnbq1bnr/ppppkppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR w - - 2 3";
        store.getState().setFen(fen);
        expect(store.getState().root.fen).toBe(fen);
        expect(mainlineSans()).toEqual([]);

        store.getState().undo();
        expect(mainlineSans()).toEqual(["e4", "e5"]);
        expect(store.getState().position).toEqual([0, 0]);

        store.getState().redo();
        expect(store.getState().root.fen).toBe(fen);
        expect(mainlineSans()).toEqual([]);
    });

    test("undo/redo setAnnotation, setShapes, promoteVariation, setHeaders", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().goToStart();
        store.getState().makeMove({ payload: parseUci("d2d4")! });
        expect(store.getState().root.children.map((c) => c.san)).toEqual(["e4", "d4"]);

        store.getState().promoteVariation([1]);
        expect(store.getState().root.children.map((c) => c.san)).toEqual(["d4", "e4"]);
        store.getState().undo();
        expect(store.getState().root.children.map((c) => c.san)).toEqual(["e4", "d4"]);

        store.getState().setAnnotation("!");
        store.getState().setShapes([{ brush: "red", orig: "e4", dest: "d5" }]);
        store.getState().setHeaders({ ...store.getState().headers, white: "Me" });
        expect(store.getState().headers.white).toBe("Me");
        store.getState().undo();
        expect(store.getState().headers.white).toBe("");
        store.getState().undo();
        expect(store.getState().currentNode().shapes).toEqual([]);
        store.getState().undo();
        expect(store.getState().currentNode().annotations).toEqual([]);
        store.getState().redo();
        expect(store.getState().currentNode().annotations).toEqual(["!"]);
    });

    test("undo/redo mark the tree dirty", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().save();
        expect(store.getState().dirty).toBe(false);
        store.getState().undo();
        expect(store.getState().dirty).toBe(true);
        store.getState().save();
        store.getState().redo();
        expect(store.getState().dirty).toBe(true);
    });

    test("navigation is not recorded", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        store.getState().goToStart();
        store.getState().goToNext();
        store.getState().goToEnd();
        store.getState().goToPrevious();
        store.getState().goToMove([0, 0]);
        store.getState().goToBranchStart();
        store.getState().goToBranchEnd();
        store.getState().nextBranch();
        store.getState().previousBranch();
        store.getState().nextBranching();
        store.getState().previousBranching();
        // existing-move makeMove is navigation too
        store.getState().goToStart();
        store.getState().makeMove({ payload: e4 });
        expect(store.getState().position).toEqual([0]);

        store.getState().undo();
        expect(mainlineSans()).toEqual(["e4"]);
        store.getState().undo();
        expect(mainlineSans()).toEqual([]);
        expect(store.getState().canUndo).toBe(false);
    });

    test("setPracticePath and setReportInProgress are not recorded", () => {
        store.getState().setPracticePath([0]);
        store.getState().setReportInProgress(true);
        expect(store.getState().canUndo).toBe(false);
        expect(store.getState().dirty).toBe(false);
    });

    test("transient setScore is not recorded and does not dirty", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().save();
        const score = { value: { type: "cp" as const, value: 42 }, wdl: null };
        store.getState().setScore([0], score, { transient: true });
        expect(store.getState().root.children[0].score).toEqual(score);
        expect(store.getState().dirty).toBe(false);
        expect(store.getState().canRedo).toBe(false);

        // the only recorded action is the makeMove
        store.getState().undo();
        expect(mainlineSans()).toEqual([]);
        expect(store.getState().canUndo).toBe(false);
    });

    test("transient setScore survives an unrelated undo", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().makeMove({ payload: e5 });
        const score = { value: { type: "cp" as const, value: 7 }, wdl: null };
        store.getState().setScore([0], score, { transient: true });
        store.getState().undo(); // undo e5
        expect(store.getState().root.children[0].score).toEqual(score);
    });

    test("non-transient setScore(path, score) is recorded and dirty", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().save();
        const score = { value: { type: "mate" as const, value: 1 }, wdl: null };
        store.getState().setScore([0], score);
        expect(store.getState().dirty).toBe(true);
        store.getState().undo();
        expect(store.getState().root.children[0].score).toBeNull();
    });

    test("legacy setScore(score) targets the current node", () => {
        store.getState().makeMove({ payload: e4 });
        const score = { value: { type: "cp" as const, value: 3 }, wdl: null };
        store.getState().setScore(score);
        expect(store.getState().root.children[0].score).toEqual(score);
    });

    test("setScore with a path that does not exist is a no-op", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().save();
        store.getState().setScore([5, 5], { value: { type: "cp", value: 1 }, wdl: null });
        expect(store.getState().root.score).toBeNull();
        expect(store.getState().root.children[0].score).toBeNull();
        expect(store.getState().dirty).toBe(false);
        // nothing was recorded: the only entry left is the makeMove
        store.getState().undo();
        expect(mainlineSans()).toEqual([]);
        expect(store.getState().canUndo).toBe(false);
    });

    test("setState and reset clear the history", () => {
        store.getState().makeMove({ payload: e4 });
        store.getState().setState(defaultTree());
        expect(store.getState().canUndo).toBe(false);
        store.getState().makeMove({ payload: e4 });
        store.getState().undo();
        expect(store.getState().canRedo).toBe(true);
        store.getState().reset();
        expect(store.getState().canUndo).toBe(false);
        expect(store.getState().canRedo).toBe(false);
    });

    test("history is capped", () => {
        for (let i = 0; i < TREE_HISTORY_CAP + 25; i++) {
            store.getState().setComment(`c${i}`);
        }
        let undone = 0;
        while (store.getState().canUndo) {
            store.getState().undo();
            undone++;
        }
        expect(undone).toBe(TREE_HISTORY_CAP);
        // the oldest 25 entries were dropped, so the root keeps comment c24
        expect(store.getState().root.comment).toBe("c24");
    });
});

function best(uciMoves: string[], cp: number) {
    return {
        depth: 1,
        multipv: 1,
        nodes: 1,
        score: { value: { type: "cp" as const, value: cp }, wdl: null },
        nps: 1000,
        sanMoves: [],
        uciMoves,
    };
}
