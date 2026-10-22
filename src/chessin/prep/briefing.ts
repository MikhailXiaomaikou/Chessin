import { INITIAL_FEN } from "chessops/fen";
import type { NormalizedGame, Outcome } from "@/bindings";
import { standardUci } from "@/chessin/board/uci";
import {
    continuingGames,
    type ExplorerStats,
    getExplorerCache,
} from "@/chessin/repertoire/explorerCache";
import { isUserTurn, type PlayerColor, toEpd } from "@/chessin/repertoire/model";
import { parseGameTimestamp } from "@/chessin/sync/myGames";
import { positionFromFen } from "@/utils/chessops";
import { query_games } from "@/utils/db";
import { type TreeNode, treeIterator } from "@/utils/treeReducer";
import type { CandidateSource, QueryGames } from "./candidates";
import { type ReplayPly, replayMovetext } from "./movetext";

/**
 * Prep briefing v0 (S4-2, teardown W1-1): what one opponent plays, from the
 * local databases only.
 *
 * Pure except for the injected `BriefingDeps` (database queries, the masters
 * explorer through the 7-day kv cache, my repertoire index), so every section
 * is testable with mocked games:
 *
 * - overview: ratings, games by colour, time controls, years;
 * - opening tree for `mySide`: the opponent's games as the *other* colour,
 *   as a trie of the first `treeDepth` plies with count / score / last date
 *   and a `recentShift` flag (share in the last 6 months differs from before
 *   by ≥ 25 points);
 * - leave theory: the first opponent move of each common line that Lichess
 *   masters play in < 2 % of games (≤ `mastersBudget` positions looked up);
 * - style: average length, draw rate, decisive share per colour, with the
 *   sample size of each metric (no "accuracy %");
 * - clash: where the opponent's lines meet my repertoire, ranked by
 *   opponent frequency × my coverage.
 *
 * Maia-style move distributions are deliberately absent (licence-gated).
 */

export type MastersStats = (fen: string) => Promise<ExplorerStats | null>;

export type OpponentGame = {
    /** `database:<path>#<id>` (same key as reviews and notebook cards). */
    key: string;
    database: string;
    gameId: number;
    /** The opponent's colour in this game. */
    color: PlayerColor;
    result: Outcome;
    /** The opponent's points (1 / 0.5 / 0); null for an unfinished game. */
    points: number | null;
    date: string | null;
    timestamp: number | null;
    /** The opponent's rating in this game. */
    elo: number | null;
    otherElo: number | null;
    timeControl: string | null;
    event: string;
    /** Main line replayed up to the tree depth. */
    plies: ReplayPly[];
    /** Length of the whole game in plies (`ply_count`, else the movetext). */
    plyCount: number;
    /** Started from the initial position (only those feed the opening tree). */
    standardStart: boolean;
};

export type Overview = {
    games: number;
    ratings: { latest: number | null; max: number | null; avg: number | null; games: number };
    gamesByColour: { white: number; black: number };
    timeControls: Record<TimeControlBucket, number>;
    years: { from: number | null; to: number | null };
};

export type TimeControlBucket = "classical" | "rapid" | "blitz" | "bullet" | "unknown";

export type OpeningNode = {
    san: string;
    uci: string;
    /** 1-based half-move index of the move. */
    ply: number;
    /** Position after the move. */
    fen: string;
    epd: string;
    /** Played by the opponent (as the other colour of `mySide`). */
    byOpponent: boolean;
    count: number;
    /** Games in the last six months. */
    recentCount: number;
    /** The opponent's points share over the finished games through this node. */
    score: number | null;
    scoreGames: number;
    lastDate: string | null;
    /** The move's share among the siblings moved by ≥ 25 points in the last six months. */
    recentShift: boolean;
    children: OpeningNode[];
};

export type OpeningTree = {
    /** The opponent's colour in the tree (the other colour of `mySide`). */
    color: PlayerColor;
    /** Games of that colour from the initial position. */
    games: number;
    recentGames: number;
    root: OpeningNode[];
};

export type LeaveTheory = {
    /** Position before the opponent's move. */
    fen: string;
    epd: string;
    ply: number;
    san: string;
    uci: string;
    /** Share of masters games that play the move here (0 when unseen). */
    mastersFreq: number;
    mastersGames: number;
    /** The opponent's games through this move. */
    count: number;
    /** SAN of the line up to and including the move. */
    line: string[];
};

export type LeaveTheoryResult = {
    items: LeaveTheory[];
    /** Distinct positions looked up. */
    requests: number;
    /** Stopped because the lookup budget ran out. */
    exhausted: boolean;
    /** Lookups without data (offline without cache). */
    unknown: number;
};

export type StyleMetric = { value: number | null; sampleSize: number };

export type Style = {
    /** Average game length in moves. */
    avgLength: StyleMetric;
    drawRate: StyleMetric;
    /** Share of the opponent's games as White that were decisive. */
    decisiveAsWhite: StyleMetric;
    decisiveAsBlack: StyleMetric;
    sacrificeRate?: StyleMetric;
};

export type Reply = { uci: string; san: string; nodeId: string };

export type Clash = {
    /** Position after the opponent's move (my move). */
    fen: string;
    epd: string;
    ply: number;
    san: string;
    uci: string;
    /** SAN of the line up to and including the opponent's move. */
    line: string[];
    count: number;
    /** `count` over the opponent's games of that colour. */
    opponentFreq: number;
    /** My coverage of the position (reach from the last check, else 1 when prepared). */
    coverage: number;
    /** `opponentFreq × coverage`: how likely the line is to come up and be met prepared. */
    likelihood: number;
    prepared: boolean;
    nodeIds: string[];
    /** My prepared replies (when a reply index was given). */
    replies: Reply[];
};

export type ClashResult = {
    rows: Clash[];
    /** No repertoire index for `mySide` was given. */
    noRepertoire: boolean;
};

export type Briefing = {
    opponent: string;
    mySide: PlayerColor;
    opponentColor: PlayerColor;
    /** Games loaded (both colours). */
    games: number;
    overview: Overview;
    openingTree: OpeningTree;
    leaveTheory: LeaveTheoryResult;
    style: Style;
    clash: ClashResult;
    generatedAt: number;
};

export type BriefingOptions = {
    mySide: PlayerColor;
    /** Only games on or after this date (ms timestamp or `YYYY.MM.DD`). */
    since?: number | string | null;
};

export type BriefingDeps = {
    queryGames: QueryGames;
    mastersStats: MastersStats;
    /** `buildUserMoveIndex` over my repertoire files for `mySide`; null = none. */
    userMoveIndex?: Map<string, Set<string>> | null;
    /** `buildReplyIndex` over the same files (what to answer, for pinning). */
    userReplies?: Map<string, Reply[]> | null;
    /** Reach probability per EPD from the last repertoire check. */
    coverage?: Map<string, number> | null;
    now?: () => number;
    /** Games fetched per database (default 500). */
    maxGamesPerSource?: number;
    /** Plies kept in the opening tree (default 30). */
    treeDepth?: number;
    /** Masters positions looked up (default 20). */
    mastersBudget?: number;
};

export const DEFAULT_MAX_GAMES_PER_SOURCE = 500;
export const DEFAULT_TREE_DEPTH = 30;
export const DEFAULT_MASTERS_BUDGET = 20;
/** A move played in fewer masters games than this share leaves theory. */
export const LEAVE_THEORY_THRESHOLD = 0.02;
export const RECENT_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
export const RECENT_SHIFT_POINTS = 0.25;
export const CLASH_LIMIT = 50;

export function otherColor(color: PlayerColor): PlayerColor {
    return color === "white" ? "black" : "white";
}

export function defaultBriefingDeps(): BriefingDeps {
    const cache = getExplorerCache();
    return {
        queryGames: query_games,
        mastersStats: async (fen) => (await cache.lookup(fen, { kind: "masters" })).stats,
        now: () => Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Games

export function pointsFor(result: Outcome, color: PlayerColor): number | null {
    switch (result) {
        case "1-0":
            return color === "white" ? 1 : 0;
        case "0-1":
            return color === "black" ? 1 : 0;
        case "1/2-1/2":
            return 0.5;
        default:
            return null;
    }
}

function sinceTimestamp(since: BriefingOptions["since"]): number | null {
    if (since === undefined || since === null) return null;
    if (typeof since === "number") return Number.isFinite(since) ? since : null;
    return parseGameTimestamp(since);
}

/** Turns a database row into an opponent game; null when the player is not in it. */
export function toOpponentGame(
    game: NormalizedGame,
    source: Pick<CandidateSource, "database" | "playerId">,
    treeDepth: number = DEFAULT_TREE_DEPTH,
): OpponentGame | null {
    let color: PlayerColor;
    if (game.white_id === source.playerId) color = "white";
    else if (game.black_id === source.playerId) color = "black";
    else return null;
    const start = game.fen?.trim() ?? "";
    const standardStart = !start || toEpd(start) === toEpd(INITIAL_FEN);
    const replay = replayMovetext(game.moves ?? "", start || null, treeDepth);
    const plyCount =
        typeof game.ply_count === "number" && game.ply_count > 0 ? game.ply_count : replay.tokens;
    return {
        key: `database:${source.database}#${game.id}`,
        database: source.database,
        gameId: game.id,
        color,
        result: game.result,
        points: pointsFor(game.result, color),
        date: game.date ?? null,
        timestamp: parseGameTimestamp(game.date, game.time),
        elo: (color === "white" ? game.white_elo : game.black_elo) ?? null,
        otherElo: (color === "white" ? game.black_elo : game.white_elo) ?? null,
        timeControl: game.time_control ?? null,
        event: game.event,
        plies: replay.plies,
        plyCount,
        standardStart,
    };
}

/** The opponent's games across the candidate's database sources, newest first. */
export async function loadOpponentGames(
    sources: readonly Pick<CandidateSource, "database" | "playerId">[],
    deps: BriefingDeps,
    options: Pick<BriefingOptions, "since"> = {},
): Promise<OpponentGame[]> {
    const pageSize = deps.maxGamesPerSource ?? DEFAULT_MAX_GAMES_PER_SOURCE;
    const treeDepth = deps.treeDepth ?? DEFAULT_TREE_DEPTH;
    const since = sinceTimestamp(options.since);
    const results = await Promise.allSettled(
        sources.map((source) =>
            deps.queryGames(source.database, {
                player1: source.playerId,
                sides: "Any",
                options: { page: 1, pageSize, sort: "date", direction: "desc", skipCount: true },
            }),
        ),
    );
    const games: OpponentGame[] = [];
    const seen = new Set<string>();
    results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        for (const row of result.value.data) {
            const game = toOpponentGame(row, sources[i], treeDepth);
            if (!game || seen.has(game.key)) continue;
            if (since !== null && (game.timestamp === null || game.timestamp < since)) continue;
            seen.add(game.key);
            games.push(game);
        }
    });
    return games.sort((a, b) => {
        if (a.timestamp === b.timestamp) return 0;
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return b.timestamp - a.timestamp;
    });
}

// ---------------------------------------------------------------------------
// Overview

/** PGN `TimeControl` → Lichess-style bucket (base + 40 × increment seconds). */
export function timeControlBucket(tc: string | null | undefined): TimeControlBucket {
    if (!tc) return "unknown";
    const text = tc.trim();
    if (!text || text === "-" || text === "?") return "unknown";
    // "40/7200:3600" → first period's base; "5400+30" → base + increment.
    const first = text.split(":")[0];
    const afterSlash = first.includes("/") ? first.slice(first.indexOf("/") + 1) : first;
    const [baseText, incText] = afterSlash.split("+");
    const base = Number(baseText);
    const inc = incText === undefined ? 0 : Number(incText);
    if (!Number.isFinite(base) || base <= 0) return "unknown";
    const estimated = base + 40 * (Number.isFinite(inc) ? inc : 0);
    if (estimated < 180) return "bullet";
    if (estimated < 480) return "blitz";
    if (estimated < 1500) return "rapid";
    return "classical";
}

export function computeOverview(games: readonly OpponentGame[]): Overview {
    const ratings = games.map((g) => g.elo).filter((e): e is number => e !== null && e > 0);
    const timeControls: Record<TimeControlBucket, number> = {
        classical: 0,
        rapid: 0,
        blitz: 0,
        bullet: 0,
        unknown: 0,
    };
    let white = 0;
    let black = 0;
    let from: number | null = null;
    let to: number | null = null;
    for (const game of games) {
        if (game.color === "white") white++;
        else black++;
        timeControls[timeControlBucket(game.timeControl)]++;
        const year = game.date ? Number(game.date.slice(0, 4)) : Number.NaN;
        if (Number.isFinite(year) && year > 0) {
            from = from === null ? year : Math.min(from, year);
            to = to === null ? year : Math.max(to, year);
        }
    }
    // Games arrive newest first; the first rated game carries the latest rating.
    const latest = games.find((g) => g.elo !== null && g.elo > 0)?.elo ?? null;
    return {
        games: games.length,
        ratings: {
            latest,
            max: ratings.length ? Math.max(...ratings) : null,
            avg: ratings.length
                ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length)
                : null,
            games: ratings.length,
        },
        gamesByColour: { white, black },
        timeControls,
        years: { from, to },
    };
}

// ---------------------------------------------------------------------------
// Opening tree

type Accumulator = {
    san: string;
    uci: string;
    ply: number;
    fen: string;
    epd: string;
    byOpponent: boolean;
    count: number;
    recentCount: number;
    points: number;
    scoreGames: number;
    lastTimestamp: number | null;
    lastDate: string | null;
    children: Map<string, Accumulator>;
};

function newAccumulator(ply: ReplayPly, byOpponent: boolean): Accumulator {
    return {
        san: ply.san,
        uci: ply.uci,
        ply: ply.ply,
        fen: ply.fenAfter,
        epd: ply.epdAfter,
        byOpponent,
        count: 0,
        recentCount: 0,
        points: 0,
        scoreGames: 0,
        lastTimestamp: null,
        lastDate: null,
        children: new Map(),
    };
}

function laterDate(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return b > a ? b : a;
}

function finish(acc: Accumulator, parent: { count: number; recentCount: number }): OpeningNode {
    const children = Array.from(acc.children.values())
        .map((child) => finish(child, acc))
        .sort((a, b) => b.count - a.count || a.san.localeCompare(b.san));
    let recentShift = false;
    if (acc.byOpponent) {
        const olderParent = parent.count - parent.recentCount;
        const olderNode = acc.count - acc.recentCount;
        if (parent.recentCount >= 2 && olderParent >= 2) {
            const recentShare = acc.recentCount / parent.recentCount;
            const olderShare = olderNode / olderParent;
            recentShift = Math.abs(recentShare - olderShare) >= RECENT_SHIFT_POINTS;
        }
    }
    return {
        san: acc.san,
        uci: acc.uci,
        ply: acc.ply,
        fen: acc.fen,
        epd: acc.epd,
        byOpponent: acc.byOpponent,
        count: acc.count,
        recentCount: acc.recentCount,
        score: acc.scoreGames > 0 ? acc.points / acc.scoreGames : null,
        scoreGames: acc.scoreGames,
        lastDate: acc.lastDate,
        recentShift,
        children,
    };
}

/**
 * The opponent's games as the other colour of `mySide`, as a trie of the
 * first `depth` plies. Both sides' moves are nodes (`byOpponent` tells them
 * apart) so a line can be followed move by move.
 */
export function buildOpeningTree(
    games: readonly OpponentGame[],
    mySide: PlayerColor,
    options: { now?: number; depth?: number } = {},
): OpeningTree {
    const color = otherColor(mySide);
    const now = options.now ?? Date.now();
    const depth = options.depth ?? DEFAULT_TREE_DEPTH;
    const recentSince = now - RECENT_MONTHS_MS;
    const root = new Map<string, Accumulator>();
    let total = 0;
    let recentTotal = 0;
    for (const game of games) {
        if (game.color !== color || !game.standardStart) continue;
        total++;
        const recent = game.timestamp !== null && game.timestamp >= recentSince;
        if (recent) recentTotal++;
        let level = root;
        for (const ply of game.plies) {
            if (ply.ply > depth) break;
            const byOpponent = ply.color === color;
            let acc = level.get(ply.san);
            if (!acc) {
                acc = newAccumulator(ply, byOpponent);
                level.set(ply.san, acc);
            }
            acc.count++;
            if (recent) acc.recentCount++;
            if (game.points !== null) {
                acc.points += game.points;
                acc.scoreGames++;
            }
            if (game.timestamp !== null) {
                if (acc.lastTimestamp === null || game.timestamp > acc.lastTimestamp) {
                    acc.lastTimestamp = game.timestamp;
                    acc.lastDate = game.date;
                }
            } else if (acc.lastTimestamp === null) {
                acc.lastDate = laterDate(acc.lastDate, game.date);
            }
            level = acc.children;
        }
    }
    const parent = { count: total, recentCount: recentTotal };
    const nodes = Array.from(root.values())
        .map((acc) => finish(acc, parent))
        .sort((a, b) => b.count - a.count || a.san.localeCompare(b.san));
    return { color, games: total, recentGames: recentTotal, root: nodes };
}

// ---------------------------------------------------------------------------
// Leave theory

function sameMove(move: { uci: string; san: string }, node: OpeningNode): boolean {
    return move.uci === node.uci || move.san === node.san;
}

/**
 * The first opponent move of each line that masters play in fewer than
 * `threshold` of their games from that position. Lines are visited most
 * common first; at most `budget` distinct positions are looked up (siblings
 * share one lookup), so the request count is bounded whatever the tree.
 */
export async function findLeaveTheory(
    tree: OpeningTree,
    mastersStats: MastersStats,
    options: { budget?: number; threshold?: number; startFen?: string } = {},
): Promise<LeaveTheoryResult> {
    const budget = options.budget ?? DEFAULT_MASTERS_BUDGET;
    const threshold = options.threshold ?? LEAVE_THEORY_THRESHOLD;
    const result: LeaveTheoryResult = { items: [], requests: 0, exhausted: false, unknown: 0 };
    const lookups = new Map<string, ExplorerStats | null>();
    type Item = { node: OpeningNode; parentFen: string; line: string[] };
    const queue: Item[] = tree.root.map((node) => ({
        node,
        parentFen: options.startFen ?? INITIAL_FEN,
        line: [node.san],
    }));
    const descend = (item: Item) => {
        for (const child of item.node.children) {
            queue.push({ node: child, parentFen: item.node.fen, line: [...item.line, child.san] });
        }
    };
    while (queue.length > 0) {
        // Most common line first (the queue is small: one entry per visited node).
        queue.sort((a, b) => b.node.count - a.node.count || a.node.ply - b.node.ply);
        const item = queue.shift()!;
        const { node, parentFen } = item;
        if (!node.byOpponent) {
            descend(item);
            continue;
        }
        let stats: ExplorerStats | null;
        if (lookups.has(parentFen)) {
            stats = lookups.get(parentFen) ?? null;
        } else {
            if (result.requests >= budget) {
                // Out of lookups: lines whose position is already known still get classified.
                result.exhausted = true;
                continue;
            }
            result.requests++;
            try {
                stats = await mastersStats(parentFen);
            } catch {
                stats = null;
            }
            lookups.set(parentFen, stats);
            if (!stats) result.unknown++;
        }
        if (!stats) continue;
        const total = continuingGames(stats);
        const move = stats.moves.find((m) => sameMove(m, node));
        const games = move ? move.white + move.draws + move.black : 0;
        const freq = total > 0 ? games / total : 0;
        if (freq < threshold) {
            result.items.push({
                fen: parentFen,
                epd: toEpd(parentFen),
                ply: node.ply,
                san: node.san,
                uci: node.uci,
                mastersFreq: freq,
                mastersGames: total,
                count: node.count,
                line: item.line,
            });
            continue;
        }
        descend(item);
    }
    result.items.sort((a, b) => b.count - a.count || a.ply - b.ply);
    return result;
}

// ---------------------------------------------------------------------------
// Style

function metric(values: number[]): StyleMetric {
    if (values.length === 0) return { value: null, sampleSize: 0 };
    return {
        value: values.reduce((a, b) => a + b, 0) / values.length,
        sampleSize: values.length,
    };
}

export function computeStyle(games: readonly OpponentGame[]): Style {
    const lengths = games.filter((g) => g.plyCount > 0).map((g) => g.plyCount / 2);
    const finished = games.filter((g) => g.points !== null);
    const draws = finished.map((g) => (g.points === 0.5 ? 1 : 0));
    const decisiveAs = (color: PlayerColor) =>
        finished.filter((g) => g.color === color).map((g) => (g.points === 0.5 ? 0 : 1));
    return {
        avgLength: metric(lengths),
        drawRate: metric(draws),
        decisiveAsWhite: metric(decisiveAs("white")),
        decisiveAsBlack: metric(decisiveAs("black")),
    };
}

// ---------------------------------------------------------------------------
// Clash with my repertoire

/**
 * My prepared replies per EPD (user-to-move positions with children), with
 * the node ids holding them. Companion of `buildUserMoveIndex`, for pinning.
 */
export function buildReplyIndex(root: TreeNode, color: PlayerColor): Map<string, Reply[]> {
    const index = new Map<string, Reply[]>();
    for (const { node } of treeIterator(root)) {
        if (!isUserTurn(node.halfMoves, color) || node.children.length === 0) continue;
        const [pos] = positionFromFen(node.fen);
        if (!pos) continue;
        const epd = toEpd(node.fen);
        const replies = index.get(epd) ?? [];
        for (const child of node.children) {
            const move = child.move;
            if (!move || !("from" in move) || !child.san) continue;
            let uci: string;
            try {
                uci = standardUci(pos, move);
            } catch {
                continue;
            }
            if (!replies.some((r) => r.uci === uci)) {
                replies.push({ uci, san: child.san, nodeId: node.id });
            }
        }
        if (replies.length > 0) index.set(epd, replies);
    }
    return index;
}

export function buildClash(
    tree: OpeningTree,
    deps: Pick<BriefingDeps, "userMoveIndex" | "userReplies" | "coverage">,
    options: { limit?: number; startFen?: string } = {},
): ClashResult {
    const index = deps.userMoveIndex;
    if (!index) return { rows: [], noRepertoire: true };
    const replies = deps.userReplies ?? null;
    const coverage = deps.coverage ?? null;
    const limit = options.limit ?? CLASH_LIMIT;
    const startEpd = toEpd(options.startFen ?? INITIAL_FEN);
    const byEpd = new Map<string, Clash>();

    const followMyMove = (parentEpd: string, node: OpeningNode): boolean => {
        const prepared = replies?.get(parentEpd);
        if (prepared) return prepared.some((r) => r.uci === node.uci || r.san === node.san);
        return index.has(parentEpd);
    };

    const visit = (nodes: OpeningNode[], parentEpd: string, line: string[]) => {
        for (const node of nodes) {
            const nextLine = [...line, node.san];
            if (!node.byOpponent) {
                if (followMyMove(parentEpd, node)) visit(node.children, node.epd, nextLine);
                continue;
            }
            const prepared = index.has(node.epd);
            const cov = coverage?.get(node.epd) ?? (prepared ? 1 : 0);
            const freq = tree.games > 0 ? node.count / tree.games : 0;
            const existing = byEpd.get(node.epd);
            if (existing) {
                existing.count += node.count;
                existing.opponentFreq = tree.games > 0 ? existing.count / tree.games : 0;
                existing.likelihood = existing.opponentFreq * existing.coverage;
                if (nextLine.length < existing.line.length) existing.line = nextLine;
            } else {
                byEpd.set(node.epd, {
                    fen: node.fen,
                    epd: node.epd,
                    ply: node.ply,
                    san: node.san,
                    uci: node.uci,
                    line: nextLine,
                    count: node.count,
                    opponentFreq: freq,
                    coverage: cov,
                    likelihood: freq * cov,
                    prepared,
                    nodeIds: Array.from(index.get(node.epd) ?? []),
                    replies: replies?.get(node.epd) ?? [],
                });
            }
            if (prepared) visit(node.children, node.epd, nextLine);
        }
    };
    visit(tree.root, startEpd, []);

    const rows = Array.from(byEpd.values())
        .sort((a, b) => b.likelihood - a.likelihood || b.count - a.count || a.ply - b.ply)
        .slice(0, limit);
    return { rows, noRepertoire: false };
}

// ---------------------------------------------------------------------------
// Briefing

export async function buildBriefing(
    candidate: { name: string; sources: readonly Pick<CandidateSource, "database" | "playerId">[] },
    options: BriefingOptions,
    deps: BriefingDeps = defaultBriefingDeps(),
): Promise<Briefing> {
    const now = deps.now ?? (() => Date.now());
    const games = await loadOpponentGames(candidate.sources, deps, options);
    const openingTree = buildOpeningTree(games, options.mySide, {
        now: now(),
        depth: deps.treeDepth ?? DEFAULT_TREE_DEPTH,
    });
    const leaveTheory = await findLeaveTheory(openingTree, deps.mastersStats, {
        budget: deps.mastersBudget ?? DEFAULT_MASTERS_BUDGET,
    });
    return {
        opponent: candidate.name,
        mySide: options.mySide,
        opponentColor: otherColor(options.mySide),
        games: games.length,
        overview: computeOverview(games),
        openingTree,
        leaveTheory,
        style: computeStyle(games),
        clash: buildClash(openingTree, deps),
        generatedAt: now(),
    };
}
