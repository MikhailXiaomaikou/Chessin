import { atom, getDefaultStore } from "jotai";
import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import { type PlayerColor, toEpd } from "./model";

/**
 * Cold shelf (S3-5): repertoire lines whose reach probability at the user's
 * level is below `coldThreshold`. They are flagged, never deleted. A
 * follow-up in the practice panel can skip them through `isColdNode` /
 * `coldNodesAtom`; both key by EPD (a full FEN is accepted and reduced).
 */

export type ColdNode = {
    nodeId: string;
    path: number[];
    fen: string;
    epd: string;
    san: string | null;
    halfMoves: number;
    /** Effective reach probability (inherited from the nearest classified ancestor). */
    reach: number;
};

export type ColdShelf = {
    threshold: number;
    /** Every node below the threshold (both colours), in tree order. */
    nodes: ColdNode[];
    /** Cold nodes whose parent is not cold: the heads of the shelved lines. */
    heads: ColdNode[];
    /** EPDs whose best reach over all occurrences is below the threshold. */
    epds: Set<string>;
};

export type FindColdOptions = {
    color: PlayerColor;
    coldThreshold: number;
    startPath?: number[];
};

/**
 * Walks the start subtree, assigning every node the reach recorded for it or,
 * when the coverage walk never classified it (beyond the depth limit, pruned),
 * its parent's reach. Nodes on the way to the start node are never cold.
 */
export function findColdNodes(
    root: TreeNode,
    reach: ReadonlyMap<string, number>,
    options: FindColdOptions,
): ColdShelf {
    const { coldThreshold, startPath = [] } = options;
    const start = getNodeAtPath(root, startPath);
    const effective = new Map<string, number>();
    const epdBest = new Map<string, number>();
    const nodes: ColdNode[] = [];
    const heads: ColdNode[] = [];

    const stack: { node: TreeNode; path: number[]; parentReach: number; parentCold: boolean }[] = [
        { node: start, path: startPath, parentReach: 1, parentCold: false },
    ];
    while (stack.length > 0) {
        const { node, path, parentReach, parentCold } = stack.pop()!;
        const isStart = node === start;
        const r = isStart ? 1 : (reach.get(node.id) ?? parentReach);
        effective.set(node.id, r);
        const epd = toEpd(node.fen);
        epdBest.set(epd, Math.max(epdBest.get(epd) ?? 0, r));
        const cold = !isStart && r < coldThreshold;
        if (cold) {
            const entry: ColdNode = {
                nodeId: node.id,
                path,
                fen: node.fen,
                epd,
                san: node.san,
                halfMoves: node.halfMoves,
                reach: r,
            };
            nodes.push(entry);
            if (!parentCold) heads.push(entry);
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({
                node: node.children[i],
                path: [...path, i],
                parentReach: r,
                parentCold: cold,
            });
        }
    }
    // The stack yields nodes in pre-order (children pushed reversed), so lists are in tree order.
    const epds = new Set<string>();
    for (const [epd, best] of epdBest) if (best < coldThreshold) epds.add(epd);
    return { threshold: coldThreshold, nodes, heads, epds };
}

export type ColdShelfState = {
    /** `rep:<file path>` of the repertoire the shelf belongs to, null before any check. */
    repertoireId: string | null;
    threshold: number;
    epds: Set<string>;
    count: number;
};

export const EMPTY_COLD_SHELF: ColdShelfState = {
    repertoireId: null,
    threshold: 0,
    epds: new Set(),
    count: 0,
};

/** The cold shelf of the most recently checked repertoire. */
export const coldNodesAtom = atom<ColdShelfState>(EMPTY_COLD_SHELF);

/** True when the position (FEN or EPD) is on the cold shelf of the last check. */
export function isColdNode(fenOrEpd: string, store = getDefaultStore()): boolean {
    return store.get(coldNodesAtom).epds.has(toEpd(fenOrEpd));
}
