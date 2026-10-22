import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { standardUci } from "@/chessin/board/uci";
import { __setCardBackendForTests, getCard } from "@/chessin/notebook/cards";
import { toEpd } from "@/chessin/repertoire/model";
import type { Review } from "@/chessin/review/model";
import { __setLibraryBackendForTests } from "@/chessin/store/libraryStore";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import {
    checkDeviations,
    deviationCardId,
    handleReviewSaved,
    loadRepertoireSources,
    locateDeviationNode,
    type RepertoireLoaderDeps,
    setAsMyMove,
    trainLine,
} from "./actions";
import { type Deviation, type DeviationDoc, type RepertoireSource, walkRepertoire } from "./detect";
import { clearDeviationListeners, getDeviationDoc, saveDeviationDoc } from "./store";

vi.mock("@/utils/sound", () => ({ playSound: () => {} }));

const store = createTreeStore();

function line(path: number[], sans: string[]) {
    store.getState().goToMove(path);
    store.getState().makeMoves({ payload: sans, changeHeaders: false });
}

function plies(sans: string[]): Review["plies"] {
    const pos = Chess.default();
    return sans.map((san, i) => {
        const fenBefore = makeFen(pos.toSetup());
        const move = parseSan(pos, san)!;
        const out = {
            ply: i + 1,
            san: makeSan(pos, move),
            uci: standardUci(pos, move),
            fenBefore,
            epd: toEpd(fenBefore),
            color: pos.turn,
            score: 0,
            bestUci: "",
            bestScore: 0,
            winChanceDrop: 0,
            cpLoss: 0,
            depth: 1,
        };
        pos.play(move);
        return out;
    });
}

function review(gameKey: string, color: "white" | "black" | null, sans: string[]): Review {
    return {
        version: 1,
        gameKey,
        engine: "t",
        depth: 1,
        createdAt: 0,
        playerColor: color,
        preset: "full",
        plies: plies(sans),
        moments: [],
        phases: {
            opening: { endPly: 0, loss: 0 },
            middlegame: { endPly: 0, loss: 0 },
            endgame: { endPly: 0, loss: 0 },
        },
        summary: {
            accuracy: { white: 0, black: 0 },
            cpl: { white: 0, black: 0 },
            blunders: 0,
            mistakes: 0,
            inaccuracies: 0,
            timePressureMoves: [],
        },
    };
}

function spanish(): RepertoireSource {
    store.getState().setState(defaultTree());
    line([], ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    return {
        path: "/rep/spanish.pgn",
        name: "spanish",
        color: "white",
        root: store.getState().root,
    };
}

/** My deviation 3.Bc4 against the Spanish repertoire currently in `store`. */
function myDeviation(root: TreeNode): Deviation {
    const walk = walkRepertoire(plies(["e4", "e5", "Nf3", "Nc6", "Bc4"]), {
        path: "/rep/spanish.pgn",
        name: "spanish",
        color: "white",
        root,
    });
    return walk.deviation!;
}

beforeEach(() => {
    __setLibraryBackendForTests(null);
    __setCardBackendForTests(null);
    clearDeviationListeners();
    store.getState().setState(defaultTree());
});

describe("locateDeviationNode", () => {
    it("finds the node by id, by path and by EPD after edits", () => {
        const rep = spanish();
        const dev = myDeviation(rep.root);
        const byId = locateDeviationNode(store.getState().root, dev);
        expect(byId?.path).toEqual([0, 0, 0, 0]);
        // A different parse of the same line: ids differ, the path still matches.
        store.getState().setState(defaultTree());
        line([], ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        const byPath = locateDeviationNode(store.getState().root, dev);
        expect(byPath?.path).toEqual([0, 0, 0, 0]);
        expect(byPath?.node.id).not.toBe(dev.node.id);
        // The line moved to a variation: found by EPD.
        store.getState().setState(defaultTree());
        line([], ["d4", "d5"]);
        line([], ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        const byEpd = locateDeviationNode(store.getState().root, dev);
        expect(byEpd?.path).toEqual([1, 0, 0, 0]);
        store.getState().setState(defaultTree());
        expect(locateDeviationNode(store.getState().root, dev)).toBeNull();
    });
});

describe("setAsMyMove", () => {
    it("adds a missing move in front of the prepared one", () => {
        const rep = spanish();
        const dev = myDeviation(rep.root);
        store.getState().goToMove([0, 0]);
        expect(setAsMyMove(store, dev)).toBe(true);
        const node = getNodeAtPath(store.getState().root, [0, 0, 0, 0]);
        expect(node.children.map((c) => c.san)).toEqual(["Bc4", "Bb5"]);
        expect(store.getState().position).toEqual([0, 0]);
        // Idempotent.
        expect(setAsMyMove(store, dev)).toBe(true);
        expect(node.children.map((c) => c.san)).toEqual(["Bc4", "Bb5"]);
    });

    it("promotes an existing variation and refuses foreign positions", () => {
        const rep = spanish();
        line([0, 0, 0, 0], ["Bc4", "Bc5"]);
        const dev = myDeviation(rep.root);
        expect(
            getNodeAtPath(store.getState().root, [0, 0, 0, 0]).children.map((c) => c.san),
        ).toEqual(["Bb5", "Bc4"]);
        expect(setAsMyMove(store, dev)).toBe(true);
        expect(
            getNodeAtPath(store.getState().root, [0, 0, 0, 0]).children.map((c) => c.san),
        ).toEqual(["Bc4", "Bb5"]);
        store.getState().setState(defaultTree());
        line([], ["d4", "d5"]);
        expect(setAsMyMove(store, dev)).toBe(false);
        expect(setAsMyMove(store, { ...dev, kind: "theirs" })).toBe(false);
    });
});

describe("trainLine", () => {
    it("creates a deviation card for the prepared move", async () => {
        const rep = spanish();
        const dev = myDeviation(rep.root);
        const doc: DeviationDoc = {
            version: 1,
            gameKey: "file:/g.pgn#0",
            playerColor: "white",
            createdAt: 0,
            status: "ok",
            repertoire: dev.repertoire,
            enteredPly: 1,
            exit: { kind: "mine", ply: 5 },
            deviation: dev,
            dismissed: false,
            snoozed: false,
        };
        const result = await trainLine(doc, 5000);
        expect(result?.created).toBe(true);
        const card = await getCard(deviationCardId(dev.epd));
        expect(card).toMatchObject({
            kind: "deviation",
            epd: dev.epd,
            answers: ["f1b5"],
            source: { gameKey: "file:/g.pgn#0", ply: 5 },
            meta: { san: "Bb5", playedSan: "Bc4", playerColor: "white", title: "spanish" },
        });
        expect(await trainLine({ ...doc, deviation: { ...dev, kind: "theirs" } })).toBeNull();
        expect(await trainLine({ ...doc, deviation: null })).toBeNull();
    });
});

describe("checkDeviations", () => {
    it("stores the document and keeps a dismissal across re-detection", async () => {
        const rep = spanish();
        const r = review("file:/g.pgn#0", "white", ["e4", "e5", "Nf3", "Nc6", "Bc4"]);
        const first = await checkDeviations(r, {
            sources: [rep],
            detect: { lookup: async () => null },
        });
        expect(first?.deviation?.kind).toBe("mine");
        expect((await getDeviationDoc("file:/g.pgn#0"))?.deviation?.playedSan).toBe("Bc4");
        await saveDeviationDoc({ ...first!, dismissed: true });
        const again = await checkDeviations(r, {
            sources: [rep],
            detect: { lookup: async () => null },
        });
        expect(again?.dismissed).toBe(true);
        // A different deviation resets the flag.
        const other = review("file:/g.pgn#0", "white", ["e4", "e5", "Nf3", "Nf6"]);
        const third = await checkDeviations(other, {
            sources: [rep],
            detect: { lookup: async () => null },
        });
        expect(third?.deviation?.kind).toBe("theirs");
        expect(third?.dismissed).toBe(false);
    });

    it("does nothing without a player colour", async () => {
        const rep = spanish();
        expect(await checkDeviations(review("g", null, ["e4"]), { sources: [rep] })).toBeNull();
        handleReviewSaved(review("g", null, ["e4"]));
        expect(await getDeviationDoc("g")).toBeNull();
    });
});

describe("loadRepertoireSources", () => {
    it("reads the repertoire files through the injected deps", async () => {
        const jotai = createStore();
        void jotai;
        store.getState().setState(defaultTree());
        line([], ["e4", "e5"]);
        const parsed = store.getState();
        const deps: RepertoireLoaderDeps = {
            documentDir: () => "/docs",
            listFiles: async (dir) => {
                expect(dir).toBe("/docs");
                return [
                    {
                        type: "file",
                        name: "white",
                        path: "/docs/white.pgn",
                        numGames: 1,
                        metadata: { type: "repertoire", tags: [] },
                        lastModified: 2,
                    },
                    {
                        type: "file",
                        name: "broken",
                        path: "/docs/broken.pgn",
                        numGames: 1,
                        metadata: { type: "repertoire", tags: [] },
                        lastModified: 1,
                    },
                ];
            },
            readPgn: async (path) => (path.endsWith("white.pgn") ? "1. e4 e5" : null),
            parse: async () => ({ ...parsed, root: parsed.root }),
            loadMeta: async (file, headers) => ({
                color: file.name === "white" ? "white" : "black",
                startFen: headers.fen,
                eloRange: [1600, 1800],
                ratingSource: "lichess",
                timeControl: "rapid",
                coverageTarget: 100,
                coldThreshold: 0.01,
            }),
        };
        const sources = await loadRepertoireSources(deps);
        expect(sources.map((s) => [s.name, s.color])).toEqual([["white", "white"]]);
        expect(sources[0].root.children[0].san).toBe("e4");
        expect(await loadRepertoireSources({ ...deps, documentDir: () => "" })).toEqual([]);
    });
});
