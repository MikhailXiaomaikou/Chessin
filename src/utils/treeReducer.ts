import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Move } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { produce } from "immer";
import type { Outcome, Score } from "@/bindings";
import type { Annotation } from "./annotation";
import { positionFromFen } from "./chessops";

export interface TreeState {
    root: TreeNode;
    headers: GameHeaders;
    position: number[];
    dirty: boolean;
    report: ReportState;
}

export interface TreeNode {
    /**
     * Stable identity of the node for the life of the tree. Assigned in
     * `createNode` / `defaultTree`; regenerated on PGN parse; never serialised
     * to PGN. Use `getNodeById` to resolve it back to a node + path.
     */
    id: string;
    fen: string;
    move: Move | null;
    san: string | null;
    children: TreeNode[];
    score: Score | null;
    depth: number | null;
    halfMoves: number;
    shapes: DrawShape[];
    annotations: Annotation[];
    comment: string;
    clock?: number;
}

export type ListNode = {
    position: number[];
    node: TreeNode;
};

let nodeIdCounter = 0;

/** Generates a new unique node id (UUID when available, counter+random otherwise). */
export function newNodeId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === "function") {
        return c.randomUUID();
    }
    nodeIdCounter += 1;
    return `${Date.now().toString(36)}-${nodeIdCounter.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

function collectNodesMissingId(root: TreeNode): { missing: TreeNode[]; frozen: boolean } {
    const missing: TreeNode[] = [];
    let frozen = false;
    for (const { node } of treeIterator(root)) {
        if (typeof node.id !== "string" || node.id === "") {
            missing.push(node);
            if (Object.isFrozen(node)) frozen = true;
        }
    }
    return { missing, frozen };
}

/**
 * Makes sure every node in the tree has an `id`. Trees produced by
 * `createNode`/`defaultTree` already have ids; this is for trees loaded from
 * storage or built by hand. Mutates in place when possible and returns the
 * same root; returns a new (structurally shared) root when the input is frozen.
 */
export function ensureNodeIds(root: TreeNode): TreeNode {
    const { missing, frozen } = collectNodesMissingId(root);
    if (missing.length === 0) return root;
    if (!frozen && !Object.isFrozen(root)) {
        for (const node of missing) {
            node.id = newNodeId();
        }
        return root;
    }
    return produce(root, (draft) => {
        for (const { node } of treeIterator(draft)) {
            if (typeof node.id !== "string" || node.id === "") {
                node.id = newNodeId();
            }
        }
    });
}

/** Finds a node by its stable id. Returns the node and its path from the root, or null. */
export function getNodeById(root: TreeNode, id: string): { node: TreeNode; path: number[] } | null {
    for (const { node, position } of treeIterator(root)) {
        if (node.id === id) {
            return { node, path: position };
        }
    }
    return null;
}

export function* treeIterator(node: TreeNode): Generator<ListNode> {
    const stack: ListNode[] = [{ position: [], node }];
    while (stack.length > 0) {
        const { position, node } = stack.pop()!;
        yield { position, node };
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ position: [...position, i], node: node.children[i] });
        }
    }
}

export function findFen(fen: string, node: TreeNode): number[] {
    const iterator = treeIterator(node);
    for (const item of iterator) {
        if (item.node.fen === fen) {
            return item.position;
        }
    }
    return [];
}

export function* treeIteratorMainLine(node: TreeNode): Generator<ListNode> {
    let current: ListNode | undefined = { position: [], node };
    while (current?.node) {
        yield current;
        current = {
            position: [...current.position, 0],
            node: current.node.children[0],
        };
    }
}

export function countMainPly(node: TreeNode): number {
    let count = 0;
    let cur = node;
    while (cur.children.length > 0) {
        count++;
        cur = cur.children[0];
    }
    return count;
}

export function defaultTree(fen?: string): TreeState {
    const [pos] = positionFromFen(fen ?? INITIAL_FEN);

    return {
        dirty: false,
        position: [],
        root: {
            id: newNodeId(),
            fen: fen?.trim() ?? INITIAL_FEN,
            move: null,
            san: null,
            children: [],
            score: null,
            depth: null,
            halfMoves: pos?.turn === "black" ? 1 : 0,
            shapes: [],
            annotations: [],
            comment: "",
        },
        headers: {
            id: 0,
            fen: fen ?? INITIAL_FEN,
            black: "",
            white: "",
            result: "*",
            event: "",
            site: "",
        },
        report: {
            inProgress: false,
        },
    };
}

export function createNode({
    fen,
    move,
    san,
    halfMoves,
    clock,
}: {
    move: Move;
    san: string;
    fen: string;
    halfMoves: number;
    clock?: number;
}): TreeNode {
    return {
        id: newNodeId(),
        fen,
        move,
        san,
        clock: clock ? clock / 1000 : undefined,
        children: [],
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

export type GameHeaders = {
    id: number;
    fen: string;
    event: string;
    site: string;
    date?: string | null;
    time?: string | null;
    round?: string | null;
    white: string;
    white_elo?: number | null;
    black: string;
    black_elo?: number | null;
    result: Outcome;
    time_control?: string | null;
    white_time_control?: string | null;
    black_time_control?: string | null;
    eco?: string | null;
    variant?: string | null;
    other?: Record<string, string>;
    // Repertoire headers
    start?: number[];
    orientation?: "white" | "black";
};

export function getGameName(headers: GameHeaders) {
    if ((headers.white && headers.white !== "?") || (headers.black && headers.black !== "?")) {
        return `${headers.white} - ${headers.black}`;
    }
    if (headers.event) {
        return headers.event;
    }
    return "Unknown";
}

export const getNodeAtPath = (node: TreeNode, path: number[]): TreeNode => {
    let currentNode = node;
    for (const index of path) {
        if (!currentNode.children || index >= currentNode.children.length) {
            return currentNode;
        }
        currentNode = currentNode.children[index];
    }
    return currentNode;
};

export function getTreeStructureHash(node: TreeNode): string {
    const parts: string[] = [];
    const stack: TreeNode[] = [node];
    while (stack.length > 0) {
        const n = stack.pop()!;
        parts.push(`${n.fen}|${n.san ?? ""}|${n.halfMoves}|${n.children.length}`);
        for (let i = n.children.length - 1; i >= 0; i--) {
            stack.push(n.children[i]);
        }
    }
    return parts.join(";");
}

export interface ReportState {
    inProgress: boolean;
}
