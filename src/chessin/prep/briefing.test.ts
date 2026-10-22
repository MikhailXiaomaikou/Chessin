import { parseUci } from "chessops";
import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { buildUserMoveIndex } from "@/chessin/repertoire/coverage";
import type { ExplorerStats } from "@/chessin/repertoire/explorerCache";
import { toEpd } from "@/chessin/repertoire/model";
import type { TreeNode } from "@/utils/treeReducer";
import {
    type BriefingDeps,
    buildBriefing,
    buildClash,
    buildOpeningTree,
    buildReplyIndex,
    computeOverview,
    computeStyle,
    findLeaveTheory,
    loadOpponentGames,
    type OpponentGame,
    RECENT_MONTHS_MS,
    timeControlBucket,
    toOpponentGame,
} from "./briefing";
import type { QueryGames } from "./candidates";
import { followedPlies, formatSanLine, replayMovetext, sanTokens } from "./movetext";

const OPP = 7;
const ME = 1;
const DB = "/dbs/club.db3";
const SOURCES = [{ database: DB, playerId: OPP }];
const NOW = Date.UTC(2026, 9, 22);
const DAY = 24 * 60 * 60 * 1000;

function dateOf(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

type GameSpec = {
    id: number;
    /** The opponent's colour. */
    color: "white" | "black";
    moves: string;
    result?: NormalizedGame["result"];
    daysAgo?: number;
    elo?: number;
    tc?: string | null;
    fen?: string;
    plyCount?: number;
};

function row(spec: GameSpec): NormalizedGame {
    const ts = NOW - (spec.daysAgo ?? 10) * DAY;
    const oppWhite = spec.color === "white";
    return {
        id: spec.id,
        fen: spec.fen ?? "",
        event: "Club Championship",
        event_id: 1,
        site: "Shanghai",
        site_id: 1,
        date: dateOf(ts),
        time: "12:00:00",
        white: oppWhite ? "Ding, Liren" : "Me",
        white_id: oppWhite ? OPP : ME,
        white_elo: oppWhite ? (spec.elo ?? 2700) : 1900,
        black: oppWhite ? "Me" : "Ding, Liren",
        black_id: oppWhite ? ME : OPP,
        black_elo: oppWhite ? 1900 : (spec.elo ?? 2700),
        result: spec.result ?? "1-0",
        time_control: spec.tc === undefined ? "5400+30" : spec.tc,
        ply_count: spec.plyCount,
        moves: spec.moves,
    };
}

function games(specs: GameSpec[]): OpponentGame[] {
    return specs.map((s) => toOpponentGame(row(s), SOURCES[0])!);
}

function stats(moves: { san: string; uci: string; n: number }[]): ExplorerStats {
    return {
        white: 0,
        draws: 0,
        black: 0,
        moves: moves.map((m) => ({ san: m.san, uci: m.uci, white: m.n, draws: 0, black: 0 })),
    };
}

const queryGamesOf = (rows: NormalizedGame[]) =>
    vi.fn<QueryGames>(async () => ({ data: rows, count: rows.length }));

function deps(
    rows: NormalizedGame[],
    masters: Record<string, ExplorerStats | null> = {},
): BriefingDeps {
    return {
        queryGames: queryGamesOf(rows),
        mastersStats: async (fen) => masters[toEpd(fen)] ?? null,
        now: () => NOW,
    };
}

// A tiny white repertoire tree: 1.e4 c5 2.Nf3 / 1.e4 e6 2.d4 (halfMoves = plies from the start).
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4_C5_NF3 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
const AFTER_E4_E6 = "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4_E6_D4 = "rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2";

function node(
    id: string,
    fen: string,
    halfMoves: number,
    uci: string | null,
    san: string | null,
    children: TreeNode[] = [],
): TreeNode {
    return {
        id,
        fen,
        move: uci ? parseUci(uci)! : null,
        san,
        children,
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

function repertoire(): TreeNode {
    return node("root", INITIAL_FEN, 0, null, null, [
        node("e4", AFTER_E4, 1, "e2e4", "e4", [
            node("c5", AFTER_E4_C5, 2, "c7c5", "c5", [
                node("Nf3", AFTER_E4_C5_NF3, 3, "g1f3", "Nf3"),
            ]),
            node("e6", AFTER_E4_E6, 2, "e7e6", "e6", [node("d4", AFTER_E4_E6_D4, 3, "d2d4", "d4")]),
        ]),
    ]);
}

describe("movetext", () => {
    it("keeps only the main-line SAN tokens", () => {
        expect(
            sanTokens(
                "1. e4 $1 c5!? {Sicilian} 2. Nf3 (2. c3 d5) 2... d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 ; note\n a6 1/2-1/2",
            ),
        ).toEqual(["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"]);
        expect(sanTokens("1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.0-0 *")).toEqual([
            "e4",
            "e5",
            "Nf3",
            "Nc6",
            "Bb5",
            "a6",
            "O-O",
        ]);
        expect(sanTokens("1-0")).toEqual([]);
    });

    it("replays the main line into positions and stops at an unplayable move", () => {
        const replay = replayMovetext("1. e4 c5 2. Nf3 d6 1-0");
        expect(replay.plies.map((p) => p.san)).toEqual(["e4", "c5", "Nf3", "d6"]);
        expect(replay.plies[0]).toMatchObject({
            ply: 1,
            uci: "e2e4",
            color: "white",
            epdBefore: toEpd(INITIAL_FEN),
            epdAfter: toEpd(AFTER_E4),
        });
        expect(replay.plies[1].color).toBe("black");
        expect(replay.invalidStart).toBe(false);

        const broken = replayMovetext("1. e4 Qh4 2. Nf3");
        expect(broken.plies.map((p) => p.san)).toEqual(["e4"]);
        expect(broken.tokens).toBe(3);
        expect(replayMovetext("1. e4", "not a fen").invalidStart).toBe(true);
        expect(replayMovetext("1. e4 e5 2. Nf3 Nc6", null, 2).plies).toHaveLength(2);
    });

    it("formats lines and counts how far a game followed one", () => {
        expect(formatSanLine(["e4", "c5", "Nf3"])).toBe("1.e4 c5 2.Nf3");
        expect(formatSanLine(["c5", "Nf3"], 2)).toBe("1...c5 2.Nf3");
        expect(formatSanLine([])).toBe("");
        expect(followedPlies(["e4", "c5", "Nf3"], ["e4", "c5", "Nf3", "d6"])).toBe(3);
        expect(followedPlies(["e4", "c5", "Nf3"], ["e4", "c5", "Nc3"])).toBe(2);
        expect(followedPlies(["e4", "c5"], ["d4"])).toBe(0);
        expect(
            followedPlies(["e4", "e5", "Nf3", "Nc6", "Bb5+"], ["e4", "e5", "Nf3", "Nc6", "Bb5"]),
        ).toBe(5);
    });
});

describe("opponent games", () => {
    it("reads the opponent's colour, points and rating from the row", () => {
        const asBlack = toOpponentGame(
            row({ id: 1, color: "black", moves: "1. e4 c5", result: "0-1", elo: 2650 }),
            SOURCES[0],
        );
        expect(asBlack).toMatchObject({
            key: `database:${DB}#1`,
            color: "black",
            points: 1,
            elo: 2650,
            otherElo: 1900,
            standardStart: true,
        });
        expect(asBlack!.plies.map((p) => p.san)).toEqual(["e4", "c5"]);
        expect(
            toOpponentGame(
                row({ id: 2, color: "white", moves: "1. d4", result: "1/2-1/2" }),
                SOURCES[0],
            )!.points,
        ).toBe(0.5);
        expect(
            toOpponentGame(row({ id: 3, color: "white", moves: "1. d4", result: "*" }), SOURCES[0])!
                .points,
        ).toBeNull();
        expect(
            toOpponentGame(row({ id: 4, color: "white", moves: "1. d4" }), {
                database: DB,
                playerId: 99,
            }),
        ).toBeNull();
        const odd = toOpponentGame(
            row({
                id: 5,
                color: "white",
                moves: "1. e4",
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            }),
            SOURCES[0],
        );
        expect(odd!.standardStart).toBe(true);
        expect(
            toOpponentGame(row({ id: 6, color: "white", moves: "", fen: AFTER_E4 }), SOURCES[0])!
                .standardStart,
        ).toBe(false);
    });

    it("queries each source for both colours, filters by date and skips broken databases", async () => {
        const rows = [
            row({ id: 1, color: "black", moves: "1. e4 c5", daysAgo: 5 }),
            row({ id: 2, color: "white", moves: "1. d4 d5", daysAgo: 400 }),
            row({ id: 1, color: "black", moves: "1. e4 c5", daysAgo: 5 }),
        ];
        const queryGames = vi.fn<QueryGames>(async (db) => {
            if (db === "/dbs/broken.db3") throw new Error("locked");
            return { data: rows, count: rows.length };
        });
        const d: BriefingDeps = { queryGames, mastersStats: async () => null, now: () => NOW };
        const all = await loadOpponentGames(
            [...SOURCES, { database: "/dbs/broken.db3", playerId: 3 }],
            d,
        );
        expect(all.map((g) => g.gameId)).toEqual([1, 2]);
        expect(queryGames).toHaveBeenCalledWith(
            DB,
            expect.objectContaining({ player1: OPP, sides: "Any" }),
        );
        const recent = await loadOpponentGames(SOURCES, d, { since: NOW - 30 * DAY });
        expect(recent.map((g) => g.gameId)).toEqual([1]);
        expect(
            (await loadOpponentGames(SOURCES, d, { since: dateOf(NOW - 30 * DAY) })).map(
                (g) => g.gameId,
            ),
        ).toEqual([1]);
    });
});

describe("overview and style", () => {
    it("buckets PGN time controls the Lichess way", () => {
        expect(timeControlBucket("5400+30")).toBe("classical");
        expect(timeControlBucket("40/7200:3600")).toBe("classical");
        expect(timeControlBucket("900+10")).toBe("rapid");
        expect(timeControlBucket("180+2")).toBe("blitz");
        expect(timeControlBucket("60")).toBe("bullet");
        expect(timeControlBucket("-")).toBe("unknown");
        expect(timeControlBucket(null)).toBe("unknown");
        expect(timeControlBucket("abc")).toBe("unknown");
    });

    it("summarises ratings, colours, time controls and years", () => {
        const o = computeOverview(
            games([
                { id: 1, color: "white", moves: "1. e4", elo: 2700, daysAgo: 1, tc: "5400+30" },
                { id: 2, color: "black", moves: "1. e4 c5", elo: 2720, daysAgo: 400, tc: "600+5" },
                { id: 3, color: "black", moves: "1. d4 d5", elo: 2680, daysAgo: 800, tc: null },
            ]),
        );
        expect(o.games).toBe(3);
        expect(o.ratings).toEqual({ latest: 2700, max: 2720, avg: 2700, games: 3 });
        expect(o.gamesByColour).toEqual({ white: 1, black: 2 });
        expect(o.timeControls).toEqual({ classical: 1, rapid: 1, blitz: 0, bullet: 0, unknown: 1 });
        expect(o.years).toEqual({ from: 2024, to: 2026 });
        expect(computeOverview([]).ratings).toEqual({
            latest: null,
            max: null,
            avg: null,
            games: 0,
        });
    });

    it("computes style metrics with their sample sizes and never an accuracy", () => {
        const s = computeStyle(
            games([
                { id: 1, color: "white", moves: "1. e4", result: "1-0", plyCount: 80 },
                { id: 2, color: "white", moves: "1. e4", result: "1/2-1/2", plyCount: 40 },
                { id: 3, color: "black", moves: "1. e4 c5", result: "0-1", plyCount: 60 },
                { id: 4, color: "black", moves: "", result: "*", plyCount: 0 },
            ]),
        );
        expect(s.avgLength).toEqual({ value: 30, sampleSize: 3 });
        expect(s.drawRate.value).toBeCloseTo(1 / 3);
        expect(s.drawRate.sampleSize).toBe(3);
        expect(s.decisiveAsWhite).toEqual({ value: 0.5, sampleSize: 2 });
        expect(s.decisiveAsBlack).toEqual({ value: 1, sampleSize: 1 });
        expect(s.sacrificeRate).toBeUndefined();
        expect(computeStyle([]).drawRate).toEqual({ value: null, sampleSize: 0 });
    });
});

describe("opening tree", () => {
    it("builds the opponent's tree as the other colour, most frequent first", () => {
        const tree = buildOpeningTree(
            games([
                { id: 1, color: "black", moves: "1. e4 c5 2. Nf3 d6", result: "0-1" },
                { id: 2, color: "black", moves: "1. e4 c5 2. Nf3 Nc6", result: "1/2-1/2" },
                { id: 3, color: "black", moves: "1. e4 e5 2. Nf3", result: "1-0" },
                { id: 4, color: "white", moves: "1. d4 d5" },
                { id: 5, color: "black", moves: "1. d4 d5", fen: AFTER_E4 },
            ]),
            "white",
            { now: NOW },
        );
        expect(tree.color).toBe("black");
        expect(tree.games).toBe(3);
        expect(tree.root.map((n) => n.san)).toEqual(["e4"]);
        const e4 = tree.root[0];
        expect(e4.byOpponent).toBe(false);
        expect(e4.children.map((n) => [n.san, n.count])).toEqual([
            ["c5", 2],
            ["e5", 1],
        ]);
        const c5 = e4.children[0];
        expect(c5).toMatchObject({
            byOpponent: true,
            ply: 2,
            epd: toEpd(AFTER_E4_C5),
            scoreGames: 2,
        });
        expect(c5.score).toBeCloseTo(0.75);
        expect(c5.lastDate).toBe(dateOf(NOW - 10 * DAY));
        expect(e4.children[1].score).toBe(0);
        expect(c5.children[0].children.map((n) => n.san).sort()).toEqual(["Nc6", "d6"]);
        expect(
            buildOpeningTree(games([{ id: 1, color: "white", moves: "1. e4" }]), "white").root,
        ).toEqual([]);
    });

    it("flags a reply whose share moved by 25 points in the last six months", () => {
        const old = 300;
        const fresh = 20;
        const tree = buildOpeningTree(
            games([
                { id: 1, color: "black", moves: "1. e4 e5", daysAgo: old },
                { id: 2, color: "black", moves: "1. e4 e5", daysAgo: old + 1 },
                { id: 3, color: "black", moves: "1. e4 e5", daysAgo: old + 2 },
                { id: 4, color: "black", moves: "1. e4 c5", daysAgo: old + 3 },
                { id: 5, color: "black", moves: "1. e4 c5", daysAgo: fresh },
                { id: 6, color: "black", moves: "1. e4 c5", daysAgo: fresh + 1 },
                { id: 7, color: "black", moves: "1. e4 c5", daysAgo: fresh + 2 },
            ]),
            "white",
            { now: NOW },
        );
        expect(old * DAY).toBeGreaterThan(RECENT_MONTHS_MS);
        expect(tree.recentGames).toBe(3);
        const replies = Object.fromEntries(
            tree.root[0].children.map((n) => [n.san, n.recentShift]),
        );
        expect(replies).toEqual({ c5: true, e5: true });
        // My own move never carries the flag, and too few games never do.
        expect(tree.root[0].recentShift).toBe(false);
        const small = buildOpeningTree(
            games([
                { id: 1, color: "black", moves: "1. e4 e5", daysAgo: old },
                { id: 2, color: "black", moves: "1. e4 c5", daysAgo: fresh },
            ]),
            "white",
            { now: NOW },
        );
        expect(small.root[0].children.every((n) => !n.recentShift)).toBe(true);
    });
});

describe("leave theory", () => {
    const tree = () =>
        buildOpeningTree(
            games([
                { id: 1, color: "black", moves: "1. e4 c5 2. Nf3 d6" },
                { id: 2, color: "black", moves: "1. e4 c5 2. Nf3 d6" },
                { id: 3, color: "black", moves: "1. e4 a6 2. d4 b5" },
                { id: 4, color: "black", moves: "1. e4 e5 2. Nf3 Nc6" },
            ]),
            "white",
            { now: NOW },
        );
    const masters: Record<string, ExplorerStats | null> = {
        [toEpd(AFTER_E4)]: stats([
            { san: "c5", uci: "c7c5", n: 600 },
            { san: "e5", uci: "e7e5", n: 350 },
            { san: "a6", uci: "a7a6", n: 5 },
        ]),
        [toEpd(AFTER_E4_C5_NF3)]: stats([
            { san: "d6", uci: "d7d6", n: 500 },
            { san: "Nc6", uci: "b8c6", n: 300 },
        ]),
    };

    it("reports the first rare move of each line and shares one lookup per position", async () => {
        const lookups: string[] = [];
        const result = await findLeaveTheory(tree(), async (fen) => {
            lookups.push(toEpd(fen));
            return masters[toEpd(fen)] ?? null;
        });
        expect(result.items.map((i) => [i.san, i.ply, i.count])).toEqual([["a6", 2, 1]]);
        expect(result.items[0]).toMatchObject({
            epd: toEpd(AFTER_E4),
            line: ["e4", "a6"],
            mastersGames: 955,
        });
        expect(result.items[0].mastersFreq).toBeCloseTo(5 / 955);
        // 1.e4 (three replies, one lookup), 2.Nf3 after c5 (one), 2.Nf3 after e5 (no data).
        expect(new Set(lookups).size).toBe(lookups.length);
        expect(result.requests).toBe(3);
        expect(result.unknown).toBe(1);
        expect(result.exhausted).toBe(false);
    });

    it("stops at the lookup budget and treats an unseen move as leaving theory", async () => {
        const limited = await findLeaveTheory(tree(), async (fen) => masters[toEpd(fen)] ?? null, {
            budget: 1,
        });
        expect(limited.requests).toBe(1);
        expect(limited.exhausted).toBe(true);
        expect(limited.items.map((i) => i.san)).toEqual(["a6"]);

        const unseen = await findLeaveTheory(
            buildOpeningTree(games([{ id: 1, color: "black", moves: "1. e4 h5" }]), "white"),
            async () => stats([{ san: "c5", uci: "c7c5", n: 100 }]),
        );
        expect(unseen.items[0]).toMatchObject({ san: "h5", mastersFreq: 0, mastersGames: 100 });

        const failing = await findLeaveTheory(tree(), async () => {
            throw new Error("boom");
        });
        expect(failing.items).toEqual([]);
        expect(failing.unknown).toBe(1);
    });
});

describe("clash with my repertoire", () => {
    const root = repertoire();
    const userMoveIndex = buildUserMoveIndex(root, "white");
    const userReplies = buildReplyIndex(root, "white");
    const opponent = () =>
        buildOpeningTree(
            games([
                { id: 1, color: "black", moves: "1. e4 c5 2. Nf3 d6" },
                { id: 2, color: "black", moves: "1. e4 c5 2. Nc3 Nc6" },
                { id: 3, color: "black", moves: "1. e4 e5 2. Nf3" },
                { id: 4, color: "black", moves: "1. d4 d5" },
            ]),
            "white",
            { now: NOW },
        );

    it("indexes my prepared replies per position", () => {
        expect(userReplies.get(toEpd(INITIAL_FEN))).toEqual([
            { uci: "e2e4", san: "e4", nodeId: "root" },
        ]);
        expect(userReplies.get(toEpd(AFTER_E4_C5))).toEqual([
            { uci: "g1f3", san: "Nf3", nodeId: "c5" },
        ]);
        expect(userReplies.has(toEpd(AFTER_E4))).toBe(false);
        expect(buildReplyIndex(root, "black").get(toEpd(AFTER_E4))).toEqual([
            { uci: "c7c5", san: "c5", nodeId: "e4" },
            { uci: "e7e6", san: "e6", nodeId: "e4" },
        ]);
    });

    it("ranks the meeting points by opponent frequency × coverage and marks gaps", () => {
        const clash = buildClash(opponent(), { userMoveIndex, userReplies });
        expect(clash.noRepertoire).toBe(false);
        expect(clash.rows.map((r) => [r.san, r.count, r.prepared])).toEqual([
            ["c5", 2, true],
            ["e5", 1, false],
            ["d6", 1, false],
        ]);
        const c5 = clash.rows[0];
        expect(c5).toMatchObject({
            epd: toEpd(AFTER_E4_C5),
            line: ["e4", "c5"],
            coverage: 1,
            nodeIds: ["c5"],
            replies: [{ uci: "g1f3", san: "Nf3", nodeId: "c5" }],
        });
        // Four games as Black (1.d4 d5 included), two of them 1.e4 c5.
        expect(c5.opponentFreq).toBeCloseTo(0.5);
        expect(c5.likelihood).toBeCloseTo(0.5);
        expect(clash.rows[1]).toMatchObject({ coverage: 0, likelihood: 0, replies: [] });
        // 1.d4 games never meet a 1.e4 repertoire; after 2.Nc3 (not my move) nothing is followed.
        expect(clash.rows.some((r) => r.line[0] === "d4")).toBe(false);
        expect(clash.rows.some((r) => r.san === "Nc6")).toBe(false);
    });

    it("uses the coverage map when given and reports a missing repertoire", () => {
        const coverage = new Map([[toEpd(AFTER_E4_C5), 0.4]]);
        const clash = buildClash(opponent(), { userMoveIndex, userReplies, coverage });
        expect(clash.rows[0].coverage).toBe(0.4);
        expect(clash.rows[0].likelihood).toBeCloseTo(0.5 * 0.4);
        expect(buildClash(opponent(), { userMoveIndex: null })).toEqual({
            rows: [],
            noRepertoire: true,
        });
        // Without a reply index any prepared position lets the line continue
        // (1.d4 and 2.Nc3 are followed too, so their replies show up as gaps).
        const loose = buildClash(opponent(), { userMoveIndex }).rows.map((r) => r.san);
        expect(loose[0]).toBe("c5");
        expect(loose).toEqual(expect.arrayContaining(["e5", "d5", "Nc6", "d6"]));
    });
});

describe("buildBriefing", () => {
    it("assembles every section from mocked data", async () => {
        const rows = [
            row({ id: 1, color: "black", moves: "1. e4 c5 2. Nf3 d6", result: "0-1", daysAgo: 3 }),
            row({ id: 2, color: "black", moves: "1. e4 a6", result: "1-0", daysAgo: 30 }),
            row({ id: 3, color: "white", moves: "1. d4 d5", result: "1/2-1/2", daysAgo: 60 }),
        ];
        const root = repertoire();
        const d = deps(rows, {
            [toEpd(AFTER_E4)]: stats([
                { san: "c5", uci: "c7c5", n: 90 },
                { san: "a6", uci: "a7a6", n: 1 },
            ]),
        });
        const briefing = await buildBriefing(
            { name: "Ding, Liren", sources: SOURCES },
            { mySide: "white" },
            {
                ...d,
                userMoveIndex: buildUserMoveIndex(root, "white"),
                userReplies: buildReplyIndex(root, "white"),
            },
        );
        expect(briefing).toMatchObject({
            opponent: "Ding, Liren",
            mySide: "white",
            opponentColor: "black",
            games: 3,
            generatedAt: NOW,
        });
        expect(briefing.overview.gamesByColour).toEqual({ white: 1, black: 2 });
        expect(briefing.openingTree.games).toBe(2);
        expect(briefing.leaveTheory.items.map((i) => i.san)).toEqual(["a6"]);
        expect(briefing.style.drawRate.sampleSize).toBe(3);
        expect(briefing.clash.rows.map((r) => [r.san, r.prepared])).toEqual([
            ["c5", true],
            ["a6", false],
            ["d6", false],
        ]);
        expect(d.queryGames).toHaveBeenCalledTimes(1);

        const empty = await buildBriefing({ name: "Nobody", sources: [] }, { mySide: "black" }, d);
        expect(empty.games).toBe(0);
        expect(empty.openingTree.root).toEqual([]);
        expect(empty.leaveTheory.requests).toBe(0);
        expect(empty.clash.noRepertoire).toBe(true);
    });
});
