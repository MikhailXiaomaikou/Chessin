import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setLibraryBackendForTests, getDoc } from "@/chessin/store/libraryStore";
import type { DeviationDoc } from "./detect";
import {
    clearDeviationListeners,
    DEVIATION_DOC_KIND,
    deleteDeviationDoc,
    deviationDocId,
    deviationTitle,
    gameKeyFromDeviationDocId,
    getDeviationDoc,
    listDeviationDocs,
    onDeviationSaved,
    parseDeviationDoc,
    saveDeviationDoc,
    updateDeviationDoc,
} from "./store";

function doc(gameKey: string, kind: "mine" | "theirs" | null = "mine"): DeviationDoc {
    return {
        version: 1,
        gameKey,
        playerColor: "white",
        createdAt: 1000,
        status: "ok",
        repertoire: { path: "/rep/a.pgn", name: "a" },
        enteredPly: 1,
        exit: { kind: kind ?? "end", ply: 5 },
        deviation: kind
            ? {
                  kind,
                  ply: 5,
                  color: "white",
                  fenBefore: "x",
                  epd: "x",
                  playedSan: "Bc4",
                  playedUci: "f1c4",
                  preparedSan: "Bb5",
                  preparedUci: "f1b5",
                  repertoire: { path: "/rep/a.pgn", name: "a" },
                  node: { id: "n", path: [0, 0, 0, 0], fen: "x", epd: "x" },
              }
            : null,
        dismissed: false,
        snoozed: false,
    };
}

beforeEach(() => {
    __setLibraryBackendForTests(null);
    clearDeviationListeners();
});

describe("deviation store", () => {
    it("saves one document per game and notifies listeners", async () => {
        const seen: string[] = [];
        onDeviationSaved((d) => seen.push(d.gameKey));
        await saveDeviationDoc(doc("file:/a.pgn#0"));
        const stored = await getDoc(deviationDocId("file:/a.pgn#0"));
        expect(stored?.kind).toBe(DEVIATION_DOC_KIND);
        expect(stored?.origin).toBe("file:/a.pgn#0");
        expect(stored?.title).toContain("3.Bc4");
        expect(seen).toEqual(["file:/a.pgn#0"]);
        const loaded = await getDeviationDoc("file:/a.pgn#0");
        expect(loaded).toEqual(doc("file:/a.pgn#0"));
        await saveDeviationDoc(doc("file:/a.pgn#0", "theirs"));
        expect((await listDeviationDocs()).map((m) => m.gameKey)).toEqual(["file:/a.pgn#0"]);
        expect((await getDeviationDoc("file:/a.pgn#0"))?.deviation?.kind).toBe("theirs");
    });

    it("updates the dismissed / snoozed flags in place", async () => {
        expect(await updateDeviationDoc("missing", { dismissed: true })).toBeNull();
        await saveDeviationDoc(doc("g"));
        const listener = vi.fn<() => void>();
        onDeviationSaved(listener);
        const next = await updateDeviationDoc("g", { dismissed: true });
        expect(next?.dismissed).toBe(true);
        expect(next?.snoozed).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect((await getDeviationDoc("g"))?.dismissed).toBe(true);
        await deleteDeviationDoc("g");
        expect(await getDeviationDoc("g")).toBeNull();
    });

    it("parses only its own payloads and derives keys from ids", () => {
        expect(parseDeviationDoc(JSON.stringify(doc("g")))).toEqual(doc("g"));
        expect(parseDeviationDoc("{not json")).toBeNull();
        expect(parseDeviationDoc(JSON.stringify({ version: 2 }))).toBeNull();
        expect(parseDeviationDoc(null)).toBeNull();
        expect(gameKeyFromDeviationDocId("dev:library:abc")).toBe("library:abc");
        expect(gameKeyFromDeviationDocId("review:x")).toBeNull();
        expect(deviationTitle(doc("g", null))).toBe("g");
        expect(deviationTitle(doc("g", "theirs"))).toContain("3.Bc4");
    });
});
