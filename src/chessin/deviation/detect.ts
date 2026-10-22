import { makeUci, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { standardUci } from "@/chessin/board/uci";
import {
    continuingGames,
    type ExplorerStats,
    movesTotal,
} from "@/chessin/repertoire/explorerCache";
import { type Reply, topReplies } from "@/chessin/repertoire/gaps";
import { type PlayerColor, type RepertoireMeta, toEpd } from "@/chessin/repertoire/model";
import type { PlyEval, Review } from "@/chessin/review/model";
import { positionFromFen } from "@/utils/chessops";
import { type TreeNode, treeIterator } from "@/utils/treeReducer";

/**
 * Deviation detection (S4-3, teardown W2-2).
 *
 * A reviewed game is walked against the user's repertoire trees for the
 * colour they played. Positions are matched by EPD, so transpositions count
 * and a repertoire that starts later than move one is entered when the game
 * first reaches one of its positions. From then on:
 *
 * - at the user's turn, the moves listed under the node (the prepared main
 *   reply and any alternatives the user wrote down) are "prepared"; playing
 *   anything else is a `mine` deviation and the prepared move shown is the
 *   node's main reply (first child);
 * - at the opponent's turn, a move with no child in the tree is a `theirs`
 *   deviation; the explorer cache then says how common it is at the user's
 *   level and which replies are played most;
 * - a node without children ends the repertoire (`exit.kind === "end"`).
 *
 * Only the first deviation is recorded: everything after it is outside the
 * repertoire anyway. With several repertoires for the colour (e.g. "vs 1.e4"
 * and "vs 1.d4"), the one the game follows for the most plies wins.
 */

export const DEVIATION_VERSION = 1 as const;

export type DeviationKind = "mine" | "theirs";

export type RepertoireRef = {
    /** Path of the repertoire PGN file. */
    path: string;
    /** File name without extension (the repertoire's title). */
    name: string;
};

export type RepertoireSource = RepertoireRef & {
    color: PlayerColor;
    root: TreeNode;
    /** Stored check settings (rating band, time control) for explorer lookups. */
    meta?: RepertoireMeta;
};

/** Where a position sits in the repertoire tree (id + path from the parse the detection ran on, FEN/EPD for re-location). */
export type NodeLocator = {
    id: string;
    path: number[];
    fen: string;
    epd: string;
};

export type Deviation = {
    kind: DeviationKind;
    /** 1-based half-move index of the deviating move. */
    ply: number;
    /** Side that played the deviating move (the user for `mine`). */
    color: PlayerColor;
    fenBefore: string;
    epd: string;
    playedSan: string;
    /** Standard UCI. */
    playedUci: string;
    /** `mine`: the repertoire's main reply at this node. */
    preparedSan?: string;
    preparedUci?: string;
    /** `theirs`: share (0..1) of games at the user's level with this move; null without data. */
    popularity?: number | null;
    /** `theirs`: games at the user's level with this move; null without data. */
    games?: number | null;
    /** `theirs`: most played replies in the position after the opponent's move. */
    replies?: Reply[];
    /** `theirs`: the position after the opponent's move (where a reply is missing). */
    fenAfter?: string;
    repertoire: RepertoireRef;
    /** The tree node of `fenBefore`. */
    node: NodeLocator;
};

export type ExitKind = DeviationKind | "end" | "none";

export type DeviationStatus = "ok" | "no_repertoire" | "no_match";

export type DeviationDoc = {
    version: typeof DEVIATION_VERSION;
    gameKey: string;
    playerColor: PlayerColor;
    createdAt: number;
    /** `ok`: a repertoire matched; `no_repertoire`: none for the colour; `no_match`: the game never entered one. */
    status: DeviationStatus;
    repertoire: RepertoireRef | null;
    /** First ply played from inside the repertoire, null when never entered. */
    enteredPly: number | null;
    /** How the game left the repertoire: the deviation, the end of the prepared line, or never (`none`). */
    exit: { kind: ExitKind; ply: number | null };
    deviation: Deviation | null;
    /** "本次忽略" (mine). */
    dismissed: boolean;
    /** "暂缓" (theirs). */
    snoozed: boolean;
};

export type WalkResult = {
    entered: boolean;
    enteredPly: number | null;
    /** Plies whose position was inside the tree. */
    depth: number;
    exit: { kind: ExitKind; ply: number | null };
    deviation: Deviation | null;
};

export type ReviewLike = Pick<Review, "gameKey" | "playerColor"> & {
    plies: Pick<PlyEval, "ply" | "san" | "uci" | "fenBefore" | "epd" | "color">[];
};

type IndexedNode = { node: TreeNode; path: number[] };

/** Every node of the tree by EPD (both colours, all lines). */
export function indexTreeByEpd(root: TreeNode): Map<string, IndexedNode[]> {
    const index = new Map<string, IndexedNode[]>();
    for (const { node, position } of treeIterator(root)) {
        const epd = toEpd(node.fen);
        const list = index.get(epd);
        if (list) list.push({ node, path: position });
        else index.set(epd, [{ node, path: position }]);
    }
    return index;
}

/** Castling-agnostic UCI of a move in `fen`; null when it cannot be parsed. */
function canonical(fen: string, uci: string): string | null {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci.trim().toLowerCase());
    if (!pos || !move || !("from" in move)) return null;
    try {
        return makeUci(normalizeMove(pos, move));
    } catch {
        return null;
    }
}

/** Standard UCI (castling as a two-square king move) of a tree child, from its parent's FEN. */
export function childUci(parentFen: string, child: TreeNode): string {
    if (!child.move || !("from" in child.move)) return "";
    const [pos] = positionFromFen(parentFen);
    if (!pos) return makeUci(child.move);
    return standardUci(pos, child.move);
}

/** True when the ply's move is the child's move (SAN first, then castling-agnostic UCI). */
export function sameMove(
    parentFen: string,
    ply: Pick<PlyEval, "san" | "uci">,
    child: TreeNode,
): boolean {
    if (child.san && ply.san && child.san === ply.san) return true;
    if (!child.move || !("from" in child.move)) return false;
    const a = canonical(parentFen, ply.uci);
    return a !== null && a === canonical(parentFen, makeUci(child.move));
}

/** FEN after `uci` in `fen`, or "" when illegal. */
export function fenAfter(fen: string, uci: string): string {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci.trim().toLowerCase());
    if (!pos || !move || !pos.isLegal(move)) return "";
    pos.play(move);
    return makeFen(pos.toSetup());
}

function locator(entry: IndexedNode): NodeLocator {
    return {
        id: entry.node.id,
        path: entry.path,
        fen: entry.node.fen,
        epd: toEpd(entry.node.fen),
    };
}

/** Walks the game's plies through one repertoire tree (pure). */
export function walkRepertoire(plies: ReviewLike["plies"], source: RepertoireSource): WalkResult {
    const index = indexTreeByEpd(source.root);
    const ref: RepertoireRef = { path: source.path, name: source.name };
    let entered = false;
    let enteredPly: number | null = null;
    let depth = 0;
    let lastPly: number | null = null;

    for (const ply of plies) {
        const epd = ply.epd || toEpd(ply.fenBefore);
        const entries = index.get(epd);
        if (!entries) {
            if (!entered) continue;
            // Cannot happen after a matched move (its child is in the tree); be safe.
            break;
        }
        if (!entered) {
            entered = true;
            enteredPly = ply.ply;
        }
        depth++;
        lastPly = ply.ply;
        const withChildren = entries.filter((e) => e.node.children.length > 0);
        if (withChildren.length === 0) {
            return {
                entered,
                enteredPly,
                depth,
                exit: { kind: "end", ply: ply.ply },
                deviation: null,
            };
        }
        const base = {
            ply: ply.ply,
            color: ply.color,
            fenBefore: ply.fenBefore,
            epd,
            playedSan: ply.san,
            playedUci: ply.uci,
            repertoire: ref,
        };
        if (ply.color === source.color) {
            const prepared = withChildren.some((e) =>
                e.node.children.some((child) => sameMove(e.node.fen, ply, child)),
            );
            if (prepared) continue;
            const entry = withChildren[0];
            const main = entry.node.children[0];
            return {
                entered,
                enteredPly,
                depth,
                exit: { kind: "mine", ply: ply.ply },
                deviation: {
                    kind: "mine",
                    ...base,
                    preparedSan: main.san ?? "",
                    preparedUci: childUci(entry.node.fen, main),
                    node: locator(entry),
                },
            };
        }
        const known = withChildren.some((e) =>
            e.node.children.some((child) => sameMove(e.node.fen, ply, child)),
        );
        if (known) continue;
        return {
            entered,
            enteredPly,
            depth,
            exit: { kind: "theirs", ply: ply.ply },
            deviation: {
                kind: "theirs",
                ...base,
                fenAfter: fenAfter(ply.fenBefore, ply.uci),
                node: locator(withChildren[0]),
            },
        };
    }
    return {
        entered,
        enteredPly,
        depth,
        exit: { kind: entered ? "end" : "none", ply: entered ? lastPly : null },
        deviation: null,
    };
}

/** The repertoire the game follows for the most plies (ties: the earlier source). */
export function pickRepertoire(
    plies: ReviewLike["plies"],
    sources: readonly RepertoireSource[],
): { source: RepertoireSource; walk: WalkResult } | null {
    let best: { source: RepertoireSource; walk: WalkResult } | null = null;
    for (const source of sources) {
        const walk = walkRepertoire(plies, source);
        if (!walk.entered) continue;
        if (!best || walk.depth > best.walk.depth) best = { source, walk };
    }
    return best;
}

export type StatsLookup = (fen: string, source: RepertoireSource) => Promise<ExplorerStats | null>;

export type DetectDeps = {
    /** Explorer statistics for a position (the shared cache by default); null = no data. */
    lookup?: StatsLookup;
    now?: () => number;
    /** Replies shown under a `theirs` card. */
    replyCount?: number;
};

/** Share and count of `uci` among the games continuing from the position. */
export function movePopularity(
    stats: ExplorerStats | null,
    fen: string,
    uci: string,
    san: string,
): { popularity: number | null; games: number | null } {
    if (!stats) return { popularity: null, games: null };
    const total = continuingGames(stats);
    const wanted = canonical(fen, uci);
    const move = stats.moves.find(
        (m) => m.san === san || (wanted !== null && canonical(fen, m.uci) === wanted),
    );
    const games = move ? movesTotal(move) : 0;
    return { popularity: total > 0 ? games / total : 0, games };
}

/**
 * Detects the first deviation of a reviewed game from the user's repertoires
 * and builds the document to store. `review.playerColor` must be set.
 */
export async function detectDeviations(
    review: ReviewLike,
    repertoires: readonly RepertoireSource[],
    deps: DetectDeps = {},
): Promise<DeviationDoc> {
    const now = deps.now ?? (() => Date.now());
    const color = review.playerColor;
    if (!color) throw new Error("detectDeviations: the review has no player colour");
    const forColor = repertoires.filter((r) => r.color === color);
    const base = {
        version: DEVIATION_VERSION,
        gameKey: review.gameKey,
        playerColor: color,
        createdAt: now(),
        dismissed: false,
        snoozed: false,
    };
    if (forColor.length === 0) {
        return {
            ...base,
            status: "no_repertoire",
            repertoire: null,
            enteredPly: null,
            exit: { kind: "none", ply: null },
            deviation: null,
        };
    }
    const picked = pickRepertoire(review.plies, forColor);
    if (!picked) {
        return {
            ...base,
            status: "no_match",
            repertoire: null,
            enteredPly: null,
            exit: { kind: "none", ply: null },
            deviation: null,
        };
    }
    const { source, walk } = picked;
    const deviation = walk.deviation;
    if (deviation && deviation.kind === "theirs" && deps.lookup) {
        try {
            const before = await deps.lookup(deviation.fenBefore, source);
            const pop = movePopularity(
                before,
                deviation.fenBefore,
                deviation.playedUci,
                deviation.playedSan,
            );
            deviation.popularity = pop.popularity;
            deviation.games = pop.games;
            if (deviation.fenAfter) {
                const after = await deps.lookup(deviation.fenAfter, source);
                deviation.replies = after ? topReplies(after, color, deps.replyCount ?? 3) : [];
            }
        } catch (e) {
            console.warn("deviation: explorer lookup failed", e);
            deviation.popularity ??= null;
            deviation.games ??= null;
        }
    } else if (deviation && deviation.kind === "theirs") {
        deviation.popularity = null;
        deviation.games = null;
        deviation.replies = [];
    }
    return {
        ...base,
        status: "ok",
        repertoire: { path: source.path, name: source.name },
        enteredPly: walk.enteredPly,
        exit: walk.exit,
        deviation,
    };
}

/** Full-move number of a ply (`1` for plies 1 and 2). */
export function moveNumberOf(ply: number): number {
    return Math.max(1, Math.ceil(ply / 2));
}

/** `"12.Nf3"` / `"12...Nf3"`. */
export function deviationMoveLabel(ply: number, san: string): string {
    return `${moveNumberOf(ply)}${ply % 2 === 1 ? "." : "..."}${san}`;
}

/** Structural check for a stored document payload. */
export function isDeviationDoc(value: unknown): value is DeviationDoc {
    if (!value || typeof value !== "object") return false;
    const d = value as Partial<DeviationDoc>;
    return (
        d.version === DEVIATION_VERSION &&
        typeof d.gameKey === "string" &&
        (d.playerColor === "white" || d.playerColor === "black") &&
        typeof d.status === "string" &&
        !!d.exit &&
        typeof d.dismissed === "boolean" &&
        typeof d.snoozed === "boolean"
    );
}
