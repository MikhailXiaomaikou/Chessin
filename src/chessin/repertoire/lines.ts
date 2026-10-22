import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";

/** "12." / "12..." prefix for a SAN at `halfMoves` plies from the initial position. */
export function moveLabel(halfMoves: number, san: string): string {
    const moveNumber = Math.ceil(halfMoves / 2);
    const white = halfMoves % 2 === 1;
    return `${moveNumber}${white ? "." : "..."}${san}`;
}

/**
 * The moves along `path` as "1.e4 e5 2.Nf3 Nc6" (a black move that starts the
 * line gets "1...e5"). Empty for the root.
 */
export function formatLine(root: TreeNode, path: number[]): string {
    const parts: string[] = [];
    let node = root;
    let previousWhite = false;
    for (const index of path) {
        const child = node.children[index];
        if (!child || !child.san) break;
        const white = child.halfMoves % 2 === 1;
        if (white) {
            parts.push(`${Math.ceil(child.halfMoves / 2)}.${child.san}`);
        } else if (previousWhite) {
            parts.push(child.san);
        } else {
            parts.push(`${Math.ceil(child.halfMoves / 2)}...${child.san}`);
        }
        previousWhite = white;
        node = child;
    }
    return parts.join(" ");
}

/** The line to `path` followed by one more move played from that node. */
export function formatLineWithMove(root: TreeNode, path: number[], san: string): string {
    const node = getNodeAtPath(root, path);
    const prefix = formatLine(root, path);
    const next = moveLabel(node.halfMoves + 1, san);
    const nextIsBlack = (node.halfMoves + 1) % 2 === 0;
    if (prefix && nextIsBlack) {
        return `${prefix} ${san}`;
    }
    return prefix ? `${prefix} ${next}` : next;
}
