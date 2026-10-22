import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { standardUci } from "@/chessin/board/uci";
import type { ExplorerStats } from "@/chessin/repertoire/explorerCache";
import { toEpd } from "@/chessin/repertoire/model";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, type TreeNode } from "@/utils/treeReducer";
import {
    detectDeviations,
    deviationMoveLabel,
    isDeviationDoc,
    moveNumberOf,
    movePopularity,
    pickRepertoire,
    type RepertoireSource,
    type ReviewLike,
    walkRepertoire,
} from "./detect";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();

function line(path: number[], sans: string[]) {
    store.getState().goToMove(path);
    store.getState().makeMoves({ payload: sans, changeHeaders: false });
}

/** A fresh tree with the given lines (each `[path, sans]` added in order). */
function tree(lines: [number[], string[]][]): TreeNode {
    store.getState().setState(defaultTree());
    for (const [path, sans] of lines) line(path, sans);
    return store.getState().root;
}

function source(
    name: string,
    color: "white" | "black",
    lines: [number[], string[]][],
): RepertoireSource {
    return { path: `/rep/${name}.pgn`, name, color, root: tree(lines) };
}

/** Review plies for a game given as SAN from the initial position. */
function plies(sans: string[]): ReviewLike["plies"] {
    const pos = Chess.default();
    return sans.map((san, i) => {
        const fenBefore = makeFen(pos.toSetup());
        const move = parseSan(pos, san);
        if (!move) throw new Error(`illegal ${san}`);
        const out = {
            ply: i + 1,
            san: makeSan(pos, move),
            uci: standardUci(pos, move),
            fenBefore,
            epd: toEpd(fenBefore),
            color: pos.turn,
        };
        pos.play(move);
        return out;
    });
}

function review(gameKey: string, color: "white" | "black" | null, sans: string[]): ReviewLike {
    return { gameKey, playerColor: color, plies: plies(sans) };
}

beforeEach(() => {
    store.getState().setState(defaultTree());
});

describe("walkRepertoire", () => {
    it("reports my deviation with the prepared move", () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]]]);
        const walk = walkRepertoire(plies(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]), rep);
        expect(walk.entered).toBe(true);
        expect(walk.enteredPly).toBe(1);
        expect(walk.depth).toBe(5);
        expect(walk.exit).toEqual({ kind: "mine", ply: 5 });
        expect(walk.deviation).toMatchObject({
            kind: "mine",
            ply: 5,
            color: "white",
            playedSan: "Bc4",
            playedUci: "f1c4",
            preparedSan: "Bb5",
            preparedUci: "f1b5",
            repertoire: { path: "/rep/spanish.pgn", name: "spanish" },
        });
        expect(walk.deviation?.node.path).toEqual([0, 0, 0, 0]);
        expect(walk.deviation?.epd).toBe(toEpd(walk.deviation?.fenBefore ?? ""));
    });

    it("reports the opponent's move that is not in the tree", () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const walk = walkRepertoire(plies(["e4", "e5", "Nf3", "Nf6", "Nxe5"]), rep);
        expect(walk.exit).toEqual({ kind: "theirs", ply: 4 });
        expect(walk.deviation).toMatchObject({
            kind: "theirs",
            ply: 4,
            color: "black",
            playedSan: "Nf6",
            playedUci: "g8f6",
        });
        expect(walk.deviation?.fenAfter).toContain(" w ");
        expect(walk.deviation?.node.path).toEqual([0, 0, 0]);
        expect(walk.deviation?.preparedSan).toBeUndefined();
    });

    it("ends without a deviation when the prepared line runs out", () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const walk = walkRepertoire(plies(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"]), rep);
        expect(walk.deviation).toBeNull();
        expect(walk.exit).toEqual({ kind: "end", ply: 6 });
        expect(walk.depth).toBe(6);
    });

    it("stays inside when the whole game is prepared", () => {
        const rep = source("short", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const walk = walkRepertoire(plies(["e4", "e5", "Nf3"]), rep);
        expect(walk.deviation).toBeNull();
        expect(walk.exit).toEqual({ kind: "end", ply: 3 });
    });

    it("accepts an alternative the user listed under the node", () => {
        const rep = source("italian-too", "white", [
            [[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]],
            [[0, 0, 0, 0], ["Bc4"]],
        ]);
        const walk = walkRepertoire(plies(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]), rep);
        expect(walk.deviation).toBeNull();
        expect(walk.exit).toEqual({ kind: "end", ply: 6 });
    });

    it("enters a late-starting repertoire through a transposition", () => {
        // A repertoire whose PGN starts after 1.d4 Nf6 2.c4 e6 (FEN header).
        const start = Chess.default();
        for (const san of ["d4", "Nf6", "c4", "e6"]) start.play(parseSan(start, san)!);
        store.getState().setState(defaultTree(makeFen(start.toSetup())));
        line([], ["Nc3", "Bb4"]);
        const rep: RepertoireSource = {
            path: "/rep/nimzo.pgn",
            name: "nimzo",
            color: "white",
            root: store.getState().root,
        };
        const walk = walkRepertoire(plies(["c4", "Nf6", "d4", "e6", "Nf3"]), rep);
        expect(walk.entered).toBe(true);
        expect(walk.enteredPly).toBe(5);
        expect(walk.depth).toBe(1);
        expect(walk.deviation).toMatchObject({ kind: "mine", ply: 5, preparedSan: "Nc3" });
        expect(walk.deviation?.node.path).toEqual([]);
        // The same game as black never reaches it.
        const vsBlack = walkRepertoire(plies(["c4", "c5"]), rep);
        expect(vsBlack.entered).toBe(false);
    });

    it("answers a transposed position from another line of the tree", () => {
        const rep = source("qgd", "white", [
            [[], ["d4", "Nf6", "c4", "e6", "Nc3"]],
            [[0], ["e6", "c4", "Nf6"]], // 1.d4 e6 2.c4 Nf6: same position, no reply here
        ]);
        const walk = walkRepertoire(plies(["d4", "e6", "c4", "Nf6", "Nf3"]), rep);
        expect(walk.deviation).toMatchObject({ kind: "mine", ply: 5, preparedSan: "Nc3" });
        expect(walk.deviation?.node.path).toEqual([0, 0, 0, 0]);
        const inBook = walkRepertoire(plies(["d4", "e6", "c4", "Nf6", "Nc3"]), rep);
        expect(inBook.deviation).toBeNull();
    });

    it("never enters a repertoire the game does not reach", () => {
        const rep = source("qgd", "white", [[[], ["d4", "d5", "c4"]]]);
        // The initial position is the root of every tree, so a white repertoire
        // is entered at ply 1; the first move then deviates.
        const walk = walkRepertoire(plies(["e4", "e5"]), rep);
        expect(walk.entered).toBe(true);
        expect(walk.deviation).toMatchObject({ kind: "mine", ply: 1, preparedSan: "d4" });
        // A black repertoire starting after 1.d4 is not reached by 1.e4 c5.
        const black = source("vs-d4", "black", [[[], ["d4", "d5"]]]);
        const w2 = walkRepertoire(plies(["e4", "c5", "Nf3"]).slice(1), black);
        expect(w2.entered).toBe(false);
        expect(w2.exit).toEqual({ kind: "none", ply: null });
    });

    it("handles a black repertoire: my deviation and the opponent's first move", () => {
        const rep = source("sicilian", "black", [[[], ["e4", "c5", "Nf3", "d6", "d4"]]]);
        const mine = walkRepertoire(plies(["e4", "c5", "Nf3", "Nc6"]), rep);
        expect(mine.deviation).toMatchObject({
            kind: "mine",
            ply: 4,
            color: "black",
            playedSan: "Nc6",
            preparedSan: "d6",
        });
        const theirs = walkRepertoire(plies(["d4", "d5"]), rep);
        expect(theirs.deviation).toMatchObject({ kind: "theirs", ply: 1, playedSan: "d4" });
    });

    it("matches castling whatever the UCI spelling", () => {
        const rep = source("castle", "white", [
            [[], ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6"]],
        ]);
        const walk = walkRepertoire(
            plies(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6", "d3"]),
            rep,
        );
        expect(walk.deviation).toBeNull();
        expect(walk.exit).toEqual({ kind: "end", ply: 9 });
    });
});

describe("pickRepertoire", () => {
    it("prefers the repertoire the game follows for the most plies", () => {
        const short = source("short", "white", [[[], ["e4", "e5", "Nf3"]]]);
        const long = source("long", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const picked = pickRepertoire(plies(["e4", "e5", "Nf3", "Nc6", "Bc4"]), [short, long]);
        expect(picked?.source.name).toBe("long");
        expect(picked?.walk.deviation?.kind).toBe("mine");
    });

    it("returns null when no repertoire is entered", () => {
        const black = source("vs-d4", "black", [[[], ["d4", "d5"]]]);
        expect(pickRepertoire(plies(["e4", "c5"]).slice(1), [black])).toBeNull();
    });
});

describe("detectDeviations", () => {
    const stats = (moves: [string, string, number][]): ExplorerStats => ({
        white: 0,
        draws: 0,
        black: 0,
        moves: moves.map(([uci, san, n]) => ({
            uci,
            san,
            white: Math.floor(n / 2),
            draws: 0,
            black: n - Math.floor(n / 2),
        })),
    });

    it("requires a player colour", async () => {
        await expect(detectDeviations(review("g", null, ["e4"]), [])).rejects.toThrow(
            "player colour",
        );
    });

    it("reports no_repertoire when only the other colour has one", async () => {
        const black = source("sicilian", "black", [[[], ["e4", "c5"]]]);
        const doc = await detectDeviations(review("g", "white", ["e4", "c5"]), [black], {
            now: () => 42,
        });
        expect(doc).toMatchObject({
            version: 1,
            gameKey: "g",
            playerColor: "white",
            createdAt: 42,
            status: "no_repertoire",
            repertoire: null,
            deviation: null,
            dismissed: false,
            snoozed: false,
        });
        expect(isDeviationDoc(doc)).toBe(true);
    });

    it("reports no_match when the game never reaches the repertoire", async () => {
        const black = source("vs-d4", "black", [[[], ["d4", "d5"]]]);
        const r = review("g", "black", ["e4", "c5"]);
        r.plies = r.plies.slice(1);
        const doc = await detectDeviations(r, [black]);
        expect(doc.status).toBe("no_match");
        expect(doc.exit).toEqual({ kind: "none", ply: null });
    });

    it("adds popularity and replies for the opponent's deviation", async () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const seen: string[] = [];
        const doc = await detectDeviations(
            review("g", "white", ["e4", "e5", "Nf3", "Nf6", "Nxe5"]),
            [rep],
            {
                lookup: async (fen) => {
                    seen.push(fen);
                    if (fen.includes(" w ")) {
                        // position after 3...Nf6: white's replies
                        return stats([
                            ["f3e5", "Nxe5", 60],
                            ["b1c3", "Nc3", 30],
                            ["d2d4", "d4", 8],
                            ["f1c4", "Bc4", 2],
                        ]);
                    }
                    return stats([
                        ["b8c6", "Nc6", 75],
                        ["g8f6", "Nf6", 25],
                    ]);
                },
            },
        );
        expect(doc.status).toBe("ok");
        expect(doc.repertoire).toEqual({ path: "/rep/spanish.pgn", name: "spanish" });
        expect(seen).toHaveLength(2);
        expect(doc.deviation).toMatchObject({ kind: "theirs", popularity: 0.25, games: 25 });
        expect(doc.deviation?.replies?.map((r) => r.san)).toEqual(["Nxe5", "Nc3", "d4"]);
        expect(doc.deviation?.replies?.[0].share).toBe(0.6);
    });

    it("leaves popularity null without data", async () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const doc = await detectDeviations(
            review("g", "white", ["e4", "e5", "Nf3", "Nf6"]),
            [rep],
            { lookup: async () => null },
        );
        expect(doc.deviation).toMatchObject({ kind: "theirs", popularity: null, games: null });
        expect(doc.deviation?.replies).toEqual([]);
        const noLookup = await detectDeviations(review("g", "white", ["e4", "e5", "Nf3", "Nf6"]), [
            rep,
        ]);
        expect(noLookup.deviation?.popularity).toBeNull();
    });

    it("does not look anything up for my own deviation", async () => {
        const rep = source("spanish", "white", [[[], ["e4", "e5", "Nf3", "Nc6", "Bb5"]]]);
        const lookup = vi.fn<() => Promise<null>>(async () => null);
        const doc = await detectDeviations(
            review("g", "white", ["e4", "e5", "Nf3", "Nc6", "Bc4"]),
            [rep],
            { lookup },
        );
        expect(lookup).not.toHaveBeenCalled();
        expect(doc.deviation?.kind).toBe("mine");
        expect(doc.enteredPly).toBe(1);
        expect(doc.exit).toEqual({ kind: "mine", ply: 5 });
    });
});

describe("helpers", () => {
    it("movePopularity finds the move by SAN or castling-agnostic UCI", () => {
        const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        const s: ExplorerStats = {
            white: 0,
            draws: 0,
            black: 0,
            moves: [
                { uci: "e2e4", san: "e4", white: 50, draws: 20, black: 30 },
                { uci: "d2d4", san: "d4", white: 40, draws: 20, black: 40 },
            ],
        };
        expect(movePopularity(s, fen, "d2d4", "d4")).toEqual({ popularity: 0.5, games: 100 });
        expect(movePopularity(s, fen, "c2c4", "c4")).toEqual({ popularity: 0, games: 0 });
        expect(movePopularity(null, fen, "e2e4", "e4")).toEqual({ popularity: null, games: null });
    });

    it("labels moves and rejects foreign documents", () => {
        expect(moveNumberOf(1)).toBe(1);
        expect(moveNumberOf(2)).toBe(1);
        expect(moveNumberOf(5)).toBe(3);
        expect(deviationMoveLabel(5, "Bc4")).toBe("3.Bc4");
        expect(deviationMoveLabel(4, "Nf6")).toBe("2...Nf6");
        expect(isDeviationDoc(null)).toBe(false);
        expect(isDeviationDoc({ version: 1, gameKey: "x" })).toBe(false);
    });
});
