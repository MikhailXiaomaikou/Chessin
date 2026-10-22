import { parseUci } from "chessops";
import type { TreeStore } from "@/state/store/tree";
import { positionFromFen } from "@/utils/chessops";
import { getNodeById, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";

/**
 * "在棋盘上演示": plays an engine line as a variation of the main board.
 *
 * The line starts from the position *before* the key moment's move, i.e. the
 * parent of the main-line node that holds the played move. The variation is
 * added through the store's `makeMoves`, so it is one undoable action
 * (Ctrl/Cmd+Z removes it again) and existing identical children are reused.
 */

export const DEFAULT_LINE_PLIES = 10;

export type MomentLocator = {
    /** Id of the main-line node after the played move (from the review). */
    nodeId?: string;
    /** 1-based half-move index of the played move in the main line. */
    ply: number;
    /** Position before the played move. */
    fenBefore: string;
};

function fenCore(fen: string): string {
    return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/**
 * Path to the node *before* the moment's move in `root`: by node id when the
 * review was built from this tree, else the main-line node at `ply - 1` when
 * its FEN matches, else any node with that FEN.
 */
export function locateMomentParent(root: TreeNode, locator: MomentLocator): number[] | null {
    if (locator.nodeId) {
        const found = getNodeById(root, locator.nodeId);
        if (found && found.path.length > 0) {
            const parentPath = found.path.slice(0, -1);
            return parentPath;
        }
    }
    const wanted = fenCore(locator.fenBefore);
    let i = 0;
    let candidate: number[] | null = null;
    for (const { node, position } of treeIteratorMainLine(root)) {
        if (i === locator.ply - 1 && fenCore(node.fen) === wanted) return position;
        if (candidate === null && fenCore(node.fen) === wanted) candidate = position;
        i++;
    }
    return candidate;
}

/** Path to the node *after* the moment's move (for highlighting it on the board). */
export function locateMomentNode(root: TreeNode, locator: MomentLocator): number[] | null {
    if (locator.nodeId) {
        const found = getNodeById(root, locator.nodeId);
        if (found) return found.path;
    }
    const parent = locateMomentParent(root, locator);
    if (!parent) return null;
    let node = root;
    for (const index of parent) node = node.children[index];
    return node.children.length > 0 ? [...parent, 0] : parent;
}

export type ApplyLineResult = {
    /** Path of the variation's last added node (the board is left there). */
    path: number[];
    /** Number of plies that were played. */
    plies: number;
};

/**
 * Adds `line` (UCI) under the moment's parent as a variation and navigates to
 * its end. Returns null when the parent cannot be found or no move is legal.
 */
export function applyLineAsVariation(
    store: TreeStore,
    locator: MomentLocator,
    line: string[],
    maxPlies = DEFAULT_LINE_PLIES,
): ApplyLineResult | null {
    const state = store.getState();
    const parentPath = locateMomentParent(state.root, locator);
    if (!parentPath) return null;

    let node = state.root;
    for (const index of parentPath) node = node.children[index];
    const [pos] = positionFromFen(node.fen);
    if (!pos) return null;

    // Keep only the legal prefix so one bad move does not drop the whole line.
    const legal: string[] = [];
    const probe = pos.clone();
    for (const uci of line.slice(0, maxPlies)) {
        const move = parseUci(uci);
        if (!move || !probe.isLegal(move)) break;
        probe.play(move);
        legal.push(uci);
    }
    if (legal.length === 0) return null;

    state.goToMove(parentPath);
    state.makeMoves({ payload: legal, mainline: false, changeHeaders: false });
    return { path: store.getState().position, plies: legal.length };
}

/** Navigates the board to the moment's node (after the played move). Returns false when not found. */
export function goToMoment(store: TreeStore, locator: MomentLocator): boolean {
    const path = locateMomentNode(store.getState().root, locator);
    if (!path) return false;
    store.getState().goToMove(path);
    return true;
}
