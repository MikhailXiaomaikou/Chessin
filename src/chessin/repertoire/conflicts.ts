import type { TreeStore } from "@/state/store/tree";
import { getNodeAtPath, getNodeById, type TreeNode, treeIterator } from "@/utils/treeReducer";
import { formatLine } from "./lines";
import { isUserTurn, type PlayerColor, toEpd } from "./model";

/**
 * Conflicts (S3-5): the same position — by EPD, so transpositions count —
 * answered with different prepared moves in different lines. The prepared
 * move of a node is its first child (what practice drills). Alternatives
 * listed under one node are deliberate and never a conflict.
 */

export type ConflictOccurrence = {
    nodeId: string;
    path: number[];
    /** The prepared reply at this node. */
    san: string;
    /** Moves leading to the node, e.g. "1.e4 e5 2.Nf3 Nc6". */
    line: string;
};

export type Conflict = {
    epd: string;
    fen: string;
    halfMoves: number;
    /** Distinct prepared replies, most frequent first. */
    moves: string[];
    occurrences: ConflictOccurrence[];
};

export function findConflicts(
    root: TreeNode,
    color: PlayerColor,
    startPath: number[] = [],
): Conflict[] {
    const start = getNodeAtPath(root, startPath);
    const byEpd = new Map<string, { fen: string; halfMoves: number; occ: ConflictOccurrence[] }>();
    for (const { node, position } of treeIterator(start)) {
        if (!isUserTurn(node.halfMoves, color) || node.children.length === 0) continue;
        const san = node.children[0].san;
        if (!san) continue;
        const path = [...startPath, ...position];
        const epd = toEpd(node.fen);
        let group = byEpd.get(epd);
        if (!group) {
            group = { fen: node.fen, halfMoves: node.halfMoves, occ: [] };
            byEpd.set(epd, group);
        }
        group.occ.push({ nodeId: node.id, path, san, line: formatLine(root, path) });
    }
    const conflicts: Conflict[] = [];
    for (const [epd, group] of byEpd) {
        const counts = new Map<string, number>();
        for (const o of group.occ) counts.set(o.san, (counts.get(o.san) ?? 0) + 1);
        if (counts.size < 2) continue;
        const moves = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([san]) => san);
        conflicts.push({
            epd,
            fen: group.fen,
            halfMoves: group.halfMoves,
            moves,
            occurrences: group.occ,
        });
    }
    conflicts.sort((a, b) => a.halfMoves - b.halfMoves || a.epd.localeCompare(b.epd));
    return conflicts;
}

/**
 * Makes `san` the prepared reply at every occurrence of the conflict: an
 * existing child is promoted to the first slot, a missing one is added as the
 * new main reply. Other replies stay as variations (nothing is deleted);
 * continuations are not copied across lines. Returns the number of nodes
 * changed; the board is left where it was.
 */
export function unifyConflict(store: TreeStore, conflict: Conflict, san: string): number {
    const originalPosition = store.getState().position;
    let changed = 0;
    for (const occurrence of conflict.occurrences) {
        if (occurrence.san === san) continue;
        const state = store.getState();
        const found = getNodeById(state.root, occurrence.nodeId);
        if (!found) continue;
        const idx = found.node.children.findIndex((c) => c.san === san);
        if (idx === 0) continue;
        if (idx > 0) {
            state.promoteVariation([...found.path, idx]);
            changed++;
            continue;
        }
        state.goToMove(found.path);
        state.makeMove({ payload: san, mainline: true, changeHeaders: false });
        const after = getNodeById(store.getState().root, occurrence.nodeId);
        if (after && after.node.children[0]?.san === san) changed++;
    }
    store.getState().goToMove(originalPosition);
    return changed;
}
