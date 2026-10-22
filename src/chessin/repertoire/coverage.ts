import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { positionFromFen } from "@/utils/chessops";
import { getNodeAtPath, type TreeNode, treeIterator } from "@/utils/treeReducer";
import { continuingGames, type ExplorerStats, movesTotal } from "./explorerCache";
import { DEFAULT_DEPTH_MOVES, isUserTurn, type PlayerColor, toEpd } from "./model";

/**
 * Probability-weighted coverage of a repertoire tree (S3-5).
 *
 * Starting from the repertoire's start node with probability 1, the walk
 * alternates between the user's nodes (follow the prepared reply, i.e. the
 * first child) and the opponent's nodes (fetch explorer statistics for the
 * position and split the probability mass over the opponent's moves by their
 * frequency). The covered mass is the probability of the opponent lines that
 * end — at depth N, at a position too rare to have data, or at a pruned
 * branch — with the user still having a prepared move; an opponent move that
 * leads to a position without a prepared reply loses its whole mass and is
 * reported as a gap candidate.
 *
 * Transpositions: a position the user already answers in another line counts
 * as covered (its continuation is evaluated there). Requests are only made
 * for opponent-to-move positions *inside* the tree, so the request count is
 * bounded by the tree, not by the explorer.
 */

export type StatsProvider = (fen: string) => Promise<ExplorerStats | null>;

export type CoverageOptions = {
    color: PlayerColor;
    /** Path of the repertoire's start node (`headers.start`); root when empty. */
    startPath?: number[];
    /** Full moves from the start node (default 10 → 20 plies). */
    depthMoves?: number;
    /** Positions with fewer continuing games are treated as covered. */
    minGames?: number;
    /** Branches whose probability drops below this are not queried (counted covered). */
    pruneBelow?: number;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
};

export type GapCandidate = {
    /** Opponent-to-move node the move is played from. */
    nodeId: string;
    path: number[];
    fen: string;
    epd: string;
    halfMoves: number;
    san: string;
    uci: string;
    /** Probability of reaching the position after the move (from the start node). */
    probability: number;
    /** Games in which the move was played at this level. */
    games: number;
    /** Position after the opponent's move (user to move). */
    childFen: string;
    childEpd: string;
    /** The opponent's move exists in the tree but the user has no reply there. */
    inTree: boolean;
    childPath?: number[];
};

export type CoverageResult = {
    /** Covered probability mass, 0..1. */
    covered: number;
    /** Tree nodes visited. */
    nodes: number;
    /** Explorer lookups made (cached or fetched). */
    requests: number;
    /** Lookups that returned no data (offline without cache, or unknown position). */
    unknown: number;
    /** Mass sitting on positions without data (counted as covered). */
    unknownMass: number;
    /** Mass that reached the depth limit (counted as covered). */
    truncatedMass: number;
    /** Mass of pruned branches (counted as covered). */
    prunedMass: number;
    /** Reach probability per node id (nodes the walk visited or classified). */
    reach: Map<string, number>;
    /** Highest reach probability per EPD. */
    epdReach: Map<string, number>;
    gaps: GapCandidate[];
};

export const DEFAULT_MIN_GAMES = 1;

export class CoverageAbortError extends Error {
    constructor() {
        super("Repertoire check cancelled");
        this.name = "CoverageAbortError";
    }
}

export function isCoverageAbortError(error: unknown): boolean {
    return (
        error instanceof CoverageAbortError ||
        (typeof error === "object" &&
            error !== null &&
            (error as { name?: unknown }).name === "CoverageAbortError")
    );
}

/**
 * Index of the positions (by EPD) where the user has a prepared reply, with
 * the ids of the nodes holding it. Built over the whole tree so transpositions
 * from any line are found.
 */
export function buildUserMoveIndex(root: TreeNode, color: PlayerColor): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const { node } of treeIterator(root)) {
        if (!isUserTurn(node.halfMoves, color) || node.children.length === 0) continue;
        const epd = toEpd(node.fen);
        let ids = index.get(epd);
        if (!ids) {
            ids = new Set();
            index.set(epd, ids);
        }
        ids.add(node.id);
    }
    return index;
}

/**
 * Opponent-to-move nodes inside the depth window: the upper bound of explorer
 * lookups a check makes, used as the progress denominator.
 */
export function countOpponentNodes(
    root: TreeNode,
    color: PlayerColor,
    startPath: number[] = [],
    depthMoves: number = DEFAULT_DEPTH_MOVES,
): number {
    const start = getNodeAtPath(root, startPath);
    const maxPlies = depthMoves * 2;
    let count = 0;
    const stack: { node: TreeNode; plies: number }[] = [{ node: start, plies: 0 }];
    while (stack.length > 0) {
        const { node, plies } = stack.pop()!;
        const userToMove = isUserTurn(node.halfMoves, color);
        if (!userToMove) {
            if (plies >= maxPlies) continue;
            count++;
            for (const child of node.children) stack.push({ node: child, plies: plies + 1 });
        } else if (node.children.length > 0) {
            // Only the prepared reply is followed; alternatives are not queried.
            stack.push({ node: node.children[0], plies: plies + 1 });
        }
    }
    return count;
}

function findChildForMove(node: TreeNode, san: string, uci: string): number {
    const bySan = node.children.findIndex((c) => c.san === san);
    if (bySan !== -1) return bySan;
    return node.children.findIndex((c) => {
        const m = c.move;
        if (!m || !("from" in m)) return false;
        const promo = m.promotion ? m.promotion[0] : "";
        return uciOf(m.from, m.to, promo) === uci;
    });
}

const FILES = "abcdefgh";

function squareName(square: number): string {
    return `${FILES[square % 8]}${Math.floor(square / 8) + 1}`;
}

function uciOf(from: number, to: number, promotion: string): string {
    return `${squareName(from)}${squareName(to)}${promotion}`;
}

/** FEN after playing `uci` from `fen`, or "" when the move is not legal there. */
export function fenAfterUci(fen: string, uci: string): string {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci);
    if (!pos || !move || !pos.isLegal(move)) return "";
    pos.play(move);
    return makeFen(pos.toSetup());
}

export async function computeCoverage(
    root: TreeNode,
    provider: StatsProvider,
    options: CoverageOptions,
): Promise<CoverageResult> {
    const {
        color,
        startPath = [],
        depthMoves = DEFAULT_DEPTH_MOVES,
        minGames = DEFAULT_MIN_GAMES,
        pruneBelow = 0,
        onProgress,
        signal,
    } = options;
    const maxPlies = depthMoves * 2;
    const total = countOpponentNodes(root, color, startPath, depthMoves);
    const userMoves = buildUserMoveIndex(root, color);
    const start = getNodeAtPath(root, startPath);

    const result: CoverageResult = {
        covered: 0,
        nodes: 0,
        requests: 0,
        unknown: 0,
        unknownMass: 0,
        truncatedMass: 0,
        prunedMass: 0,
        reach: new Map(),
        epdReach: new Map(),
        gaps: [],
    };
    let done = 0;

    const setReach = (node: TreeNode, prob: number) => {
        const previous = result.reach.get(node.id) ?? 0;
        if (prob > previous || !result.reach.has(node.id)) result.reach.set(node.id, prob);
        const epd = toEpd(node.fen);
        const epdPrevious = result.epdReach.get(epd) ?? 0;
        if (prob > epdPrevious || !result.epdReach.has(epd)) result.epdReach.set(epd, prob);
    };

    const checkAborted = () => {
        if (signal?.aborted) throw new CoverageAbortError();
    };

    const step = () => {
        done++;
        onProgress?.(done, total);
    };

    /** A user-to-move node without children: covered when answered elsewhere. */
    const answeredElsewhere = (node: TreeNode): boolean => {
        const ids = userMoves.get(toEpd(node.fen));
        if (!ids) return false;
        for (const id of ids) if (id !== node.id) return true;
        return false;
    };

    async function visitUser(node: TreeNode, path: number[], prob: number, plies: number) {
        result.nodes++;
        checkAborted();
        if (node.children.length === 0) {
            return answeredElsewhere(node) ? prob : 0;
        }
        // The prepared reply is the first child; alternatives share its reach.
        for (const child of node.children) setReach(child, prob);
        return visitOpponent(node.children[0], [...path, 0], prob, plies + 1);
    }

    async function visitOpponent(
        node: TreeNode,
        path: number[],
        prob: number,
        plies: number,
    ): Promise<number> {
        result.nodes++;
        checkAborted();
        if (plies >= maxPlies) {
            result.truncatedMass += prob;
            return prob;
        }
        if (pruneBelow > 0 && prob < pruneBelow) {
            result.prunedMass += prob;
            for (const child of node.children) setReach(child, prob);
            step();
            return prob;
        }
        const stats = await provider(node.fen);
        result.requests++;
        step();
        checkAborted();
        if (!stats) {
            result.unknown++;
            result.unknownMass += prob;
            for (const child of node.children) setReach(child, prob);
            return prob;
        }
        const games = continuingGames(stats);
        if (games < Math.max(1, minGames)) {
            // Too rare to split: keep the mass as covered, children inherit it.
            for (const child of node.children) setReach(child, prob);
            return prob;
        }

        let covered = 0;
        const matched = new Set<number>();
        for (const move of stats.moves) {
            const moveGames = movesTotal(move);
            if (moveGames === 0) continue;
            const p = (prob * moveGames) / games;
            const idx = findChildForMove(node, move.san, move.uci);
            const base = {
                nodeId: node.id,
                path,
                fen: node.fen,
                epd: toEpd(node.fen),
                halfMoves: node.halfMoves,
                san: move.san,
                uci: move.uci,
                probability: p,
                games: moveGames,
            };
            if (idx === -1) {
                const childFen = fenAfterUci(node.fen, move.uci);
                result.gaps.push({
                    ...base,
                    childFen,
                    childEpd: childFen ? toEpd(childFen) : "",
                    inTree: false,
                });
                continue;
            }
            matched.add(idx);
            const child = node.children[idx];
            setReach(child, p);
            if (child.children.length === 0) {
                if (answeredElsewhere(child)) {
                    covered += p;
                } else {
                    result.gaps.push({
                        ...base,
                        childFen: child.fen,
                        childEpd: toEpd(child.fen),
                        inTree: true,
                        childPath: [...path, idx],
                    });
                }
                continue;
            }
            covered += await visitUser(child, [...path, idx], p, plies + 1);
        }
        // Tree moves the explorer never lists at this level are unreachable here.
        node.children.forEach((child, idx) => {
            if (!matched.has(idx)) setReach(child, 0);
        });
        return covered;
    }

    setReach(start, 1);
    result.covered = isUserTurn(start.halfMoves, color)
        ? await visitUser(start, startPath, 1, 0)
        : await visitOpponent(start, startPath, 1, 0);
    // Rounding guard: the mass is a probability.
    result.covered = Math.min(1, Math.max(0, result.covered));
    return result;
}
