import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setLibraryBackendForTests, getDoc, listDocs } from "@/chessin/store/libraryStore";
import { clearReviewListeners, emitReviewSaved, onReviewSaved } from "./events";
import { gameKeyForOrigin, isReview, type Review, reviewDocId } from "./model";
import {
    deleteReview,
    getReview,
    hasReview,
    listReviews,
    parseReview,
    reviewTitle,
    saveReview,
} from "./store";

function review(gameKey: string, preset: Review["preset"] = "full"): Review {
    return {
        version: 1,
        gameKey,
        engine: "Test 1",
        depth: 10,
        createdAt: 1000,
        playerColor: "white",
        preset,
        headers: { white: "Alice", black: "Bob", result: "1-0" },
        plies: [],
        moments:
            preset === "full"
                ? [
                      {
                          id: `${gameKey}#4`,
                          ply: 4,
                          fenBefore: "x",
                          playedUci: "a2a3",
                          playedSan: "a3",
                          bestUci: "e2e4",
                          bestSan: "e4",
                          bestPv: ["e2e4"],
                          alternatives: [],
                          drop: 0.3,
                          findability: 0.8,
                          priority: 0.24,
                          phase: "opening",
                          kind: "blunder",
                          color: "white",
                      },
                  ]
                : [],
        phases: {
            opening: { endPly: 10, loss: 0 },
            middlegame: { endPly: 20, loss: 0 },
            endgame: { endPly: 30, loss: 0 },
        },
        summary: {
            accuracy: { white: 90, black: 80 },
            cpl: { white: 10, black: 20 },
            blunders: 1,
            mistakes: 0,
            inaccuracies: 0,
            timePressureMoves: [],
        },
    };
}

beforeEach(() => {
    __setLibraryBackendForTests(null);
    clearReviewListeners();
});

describe("review documents", () => {
    it("round-trips through the library store", async () => {
        const r = review("database:/tmp/a.db3#7");
        expect(await hasReview(r.gameKey)).toBe(false);
        await saveReview(r);
        expect(await hasReview(r.gameKey)).toBe(true);
        expect(await getReview(r.gameKey)).toEqual(r);

        const doc = await getDoc(reviewDocId(r.gameKey));
        expect(doc).toMatchObject({
            id: "review:database:/tmp/a.db3#7",
            kind: "review",
            origin: r.gameKey,
            title: "Alice – Bob 1-0",
        });

        const list = await listReviews();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ gameKey: r.gameKey, title: "Alice – Bob 1-0" });

        await deleteReview(r.gameKey);
        expect(await getReview(r.gameKey)).toBeNull();
        expect(await listReviews()).toEqual([]);
    });

    it("a blunder check replaces the full review instead of stacking", async () => {
        const key = "file:/games/x.pgn#2";
        await saveReview(review(key, "full"));
        await saveReview(review(key, "blunder_check"));
        expect(await listDocs("review")).toHaveLength(1);
        const stored = await getReview(key);
        expect(stored?.preset).toBe("blunder_check");
        expect(stored?.moments).toEqual([]);
        await saveReview(review(key, "full"));
        expect((await getReview(key))?.moments).toHaveLength(1);
        expect(await listDocs("review")).toHaveLength(1);
    });

    it("notifies onReviewSaved listeners after the write", async () => {
        const seen: string[] = [];
        const off = onReviewSaved((r) => seen.push(r.gameKey));
        await saveReview(review("library:doc-1"));
        expect(seen).toEqual(["library:doc-1"]);
        off();
        await saveReview(review("library:doc-2"));
        expect(seen).toEqual(["library:doc-1"]);
    });

    it("isolates listener failures", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const ok = vi.fn<() => void>();
        onReviewSaved(() => {
            throw new Error("boom");
        });
        onReviewSaved(ok);
        emitReviewSaved(review("k"));
        expect(ok).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it("ignores foreign or broken documents", () => {
        expect(parseReview("not json")).toBeNull();
        expect(parseReview(JSON.stringify({ version: 2 }))).toBeNull();
        expect(isReview(review("k"))).toBe(true);
        expect(reviewTitle({ ...review("k"), headers: undefined })).toBe("k");
    });

    it("derives game keys from origins", () => {
        expect(gameKeyForOrigin({ kind: "none" })).toBeNull();
        expect(gameKeyForOrigin({ kind: "library", docId: "abc" })).toBe("library:abc");
        expect(gameKeyForOrigin({ kind: "database", database: "/d.db3", gameId: 3 })).toBe(
            "database:/d.db3#3",
        );
        expect(gameKeyForOrigin(null)).toBeNull();
    });
});
