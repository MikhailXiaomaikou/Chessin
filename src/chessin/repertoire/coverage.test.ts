import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { computeCoverage, countOpponentNodes, fenAfterUci, isCoverageAbortError } from "./coverage";
import type { ExplorerStats } from "./explorerCache";
import { toEpd } from "./model";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();

/** Explorer stats from `[san, uci, games]` rows (a fixed 40/20/40 result split). */
function stats(rows: [string, string, number][]): ExplorerStats {
    const moves = rows.map(([san, uci, games]) => ({
        san,
        uci,
        white: Math.round(games * 0.4),
        draws: games - 2 * Math.round(games * 0.4),
        black: Math.round(games * 0.4),
    }));
    return {
        white: moves.reduce((a, m) => a + m.white, 0),
        draws: moves.reduce((a, m) => a + m.draws, 0),
        black: moves.reduce((a, m) => a + m.black, 0),
        moves,
    };
}

/** Plays `sans` from `path` as a variation and returns the FEN reached. */
function line(path: number[], sans: string[]): string {
    store.getState().goToMove(path);
    store.getState().makeMoves({ payload: sans, changeHeaders: false });
    return store.getState().currentNode().fen;
}

function fenAt(path: number[]): string {
    return getNodeAtPath(store.getState().root, path).fen;
}

type Provider = {
    calls: string[];
    inFlight: number;
    maxInFlight: number;
    get: (fen: string) => Promise<ExplorerStats | null>;
};

function providerFrom(table: Record<string, ExplorerStats | null>): Provider {
    const p: Provider = {
        calls: [],
        inFlight: 0,
        maxInFlight: 0,
        get: async (fen) => {
            p.inFlight++;
            p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
            p.calls.push(toEpd(fen));
            await Promise.resolve();
            p.inFlight--;
            const key = toEpd(fen);
            return key in table ? table[key] : null;
        },
    };
    return p;
}

beforeEach(() => {
    store.getState().setState(defaultTree());
});

describe("computeCoverage (white repertoire)", () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 and 1.e4 c5 2.Nf3
    function buildTree() {
        line([], ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        line([0], ["c5", "Nf3"]);
    }

    function table() {
        return {
            [toEpd(fenAt([0]))]: stats([
                ["e5", "e7e5", 60],
                ["c5", "c7c5", 30],
                ["e6", "e7e6", 10],
            ]),
            [toEpd(fenAt([0, 0, 0]))]: stats([
                ["Nc6", "b8c6", 80],
                ["Nf6", "g8f6", 20],
            ]),
            [toEpd(fenAt([0, 1, 0]))]: stats([
                ["d6", "d7d6", 50],
                ["Nc6", "b8c6", 50],
            ]),
            [toEpd(fenAt([0, 0, 0, 0, 0]))]: stats([["a6", "a7a6", 100]]),
        };
    }

    it("splits the mass by move frequency and reports uncovered moves as gaps", async () => {
        buildTree();
        const provider = providerFrom(table());
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 2,
        });
        expect(result.covered).toBeCloseTo(0.48, 6);
        expect(result.truncatedMass).toBeCloseTo(0.48, 6);
        expect(result.requests).toBe(3);
        expect(result.nodes).toBe(8);
        const gaps = result.gaps.map((g) => [g.san, Number(g.probability.toFixed(4))]);
        expect(gaps).toEqual(
            expect.arrayContaining([
                ["Nf6", 0.12],
                ["d6", 0.15],
                ["Nc6", 0.15],
                ["e6", 0.1],
            ]),
        );
        expect(result.gaps).toHaveLength(4);
        const e6 = result.gaps.find((g) => g.san === "e6")!;
        expect(e6.inTree).toBe(false);
        expect(e6.childFen).toBe(fenAfterUci(fenAt([0]), "e7e6"));
        expect(e6.childEpd).toBe(toEpd(e6.childFen));
    });

    it("queries one position at a time and reports exact progress", async () => {
        buildTree();
        const provider = providerFrom(table());
        const progress: [number, number][] = [];
        await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 2,
            onProgress: (done, total) => progress.push([done, total]),
        });
        expect(provider.maxInFlight).toBe(1);
        expect(provider.calls).toHaveLength(3);
        expect(progress).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);
    });

    it("counts positions without data as covered and reports them as unknown", async () => {
        buildTree();
        const t = table();
        delete t[toEpd(fenAt([0, 1, 0]))];
        const provider = providerFrom(t);
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 2,
        });
        expect(result.unknown).toBe(1);
        expect(result.unknownMass).toBeCloseTo(0.3, 6);
        expect(result.covered).toBeCloseTo(0.78, 6);
    });

    it("reports an opponent move that is in the tree without a reply as an in-tree gap", async () => {
        line([], ["e4", "e5", "Nf3"]);
        line([0], ["c5"]);
        const provider = providerFrom({
            [toEpd(fenAt([0]))]: stats([
                ["e5", "e7e5", 60],
                ["c5", "c7c5", 40],
            ]),
        });
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 2,
        });
        const c5 = result.gaps.find((g) => g.san === "c5")!;
        expect(c5.inTree).toBe(true);
        expect(c5.childPath).toEqual([0, 1]);
        expect(c5.childFen).toBe(fenAt([0, 1]));
        expect(result.covered).toBeCloseTo(0.6, 6);
    });

    it("treats a position answered in another line (transposition) as covered", async () => {
        line([], ["d4", "d5", "c4", "e6", "Nc3"]);
        line([0], ["e6", "c4", "d5"]);
        const provider = providerFrom({
            [toEpd(fenAt([0]))]: stats([
                ["d5", "d7d5", 50],
                ["e6", "e7e6", 50],
            ]),
            [toEpd(fenAt([0, 0, 0]))]: stats([["e6", "e7e6", 100]]),
            [toEpd(fenAt([0, 1, 0]))]: stats([["d5", "d7d5", 100]]),
        });
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
        });
        expect(result.covered).toBeCloseTo(1, 6);
        expect(result.gaps).toEqual([]);
        const leaf = getNodeAtPath(store.getState().root, [0, 1, 0, 0]);
        expect(result.reach.get(leaf.id)).toBeCloseTo(0.5, 6);
        expect(result.epdReach.get(toEpd(leaf.fen))).toBeCloseTo(0.5, 6);
    });

    it("gives tree moves the explorer never lists a reach of zero", async () => {
        line([], ["e4", "e5", "Nf3"]);
        line([0], ["a6", "Nf3"]);
        const provider = providerFrom({
            [toEpd(fenAt([0]))]: stats([["e5", "e7e5", 100]]),
        });
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 1,
        });
        const e5 = getNodeAtPath(store.getState().root, [0, 0]);
        const a6 = getNodeAtPath(store.getState().root, [0, 1]);
        expect(result.reach.get(e5.id)).toBe(1);
        expect(result.reach.get(a6.id)).toBe(0);
    });

    it("prunes branches below `pruneBelow` without querying them", async () => {
        buildTree();
        const provider = providerFrom(table());
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "white",
            depthMoves: 2,
            pruneBelow: 0.5,
        });
        expect(provider.calls).not.toContain(toEpd(fenAt([0, 1, 0])));
        expect(result.prunedMass).toBeCloseTo(0.3, 6);
        expect(result.covered).toBeCloseTo(0.78, 6);
        expect(result.gaps.map((g) => g.san).sort()).toEqual(["Nf6", "e6"]);
    });

    it("stops when the signal aborts", async () => {
        buildTree();
        const controller = new AbortController();
        const provider = providerFrom(table());
        const aborting = async (fen: string) => {
            const out = await provider.get(fen);
            controller.abort();
            return out;
        };
        await expect(
            computeCoverage(store.getState().root, aborting, {
                color: "white",
                signal: controller.signal,
            }),
        ).rejects.toSatisfy(isCoverageAbortError);
        expect(provider.calls).toHaveLength(1);
    });
});

describe("computeCoverage (black repertoire)", () => {
    it("starts at an opponent-to-move root", async () => {
        line([], ["e4", "c5"]);
        const provider = providerFrom({
            [toEpd(fenAt([]))]: stats([
                ["e4", "e2e4", 70],
                ["d4", "d2d4", 30],
            ]),
        });
        const result = await computeCoverage(store.getState().root, provider.get, {
            color: "black",
        });
        expect(result.covered).toBeCloseTo(0.7, 6);
        expect(result.unknown).toBe(1);
        expect(result.gaps.map((g) => [g.san, g.probability])).toEqual([["d4", 0.3]]);
    });
});

describe("helpers", () => {
    it("countOpponentNodes respects the depth window and follows only the main reply", () => {
        line([], ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        line([0], ["c5", "Nf3"]);
        line([0, 0, 0, 0], ["Bc4"]);
        const root = store.getState().root;
        expect(countOpponentNodes(root, "white", [], 10)).toBe(4);
        expect(countOpponentNodes(root, "white", [], 2)).toBe(3);
        expect(countOpponentNodes(root, "white", [], 1)).toBe(1);
        // Black: ...c5 is an alternative at the user's node, so only the ...e5 line is walked.
        expect(countOpponentNodes(root, "black", [], 10)).toBe(3);
    });

    it("fenAfterUci plays legal moves and rejects illegal ones", () => {
        const start = store.getState().root.fen;
        const afterE4 = line([], ["e4"]);
        expect(fenAfterUci(start, "e2e4")).toBe(afterE4);
        expect(fenAfterUci(start, "e2e5")).toBe("");
        expect(fenAfterUci("not a fen", "e2e4")).toBe("");
    });
});
