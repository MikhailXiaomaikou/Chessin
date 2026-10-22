import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    type LibraryBackend,
    type PutDocInput,
} from "./libraryStore";
import { getSaveState, resetSaveState } from "./saveState";
import {
    createDocumentStorage,
    DOC_DEBOUNCE_MS,
    flushDocWrites,
    hasPendingDocWrites,
    resetTreePersistence,
} from "./treePersist";

function recordingBackend(): { backend: LibraryBackend; puts: Required<PutDocInput>[] } {
    const inner = createMemoryBackend();
    const puts: Required<PutDocInput>[] = [];
    return {
        puts,
        backend: {
            ...inner,
            async docPut(input) {
                puts.push(input);
                await inner.docPut(input);
            },
        },
    };
}

type Doc = { headers?: { white: string; black: string }; n?: number };

describe("createDocumentStorage", () => {
    let puts: Required<PutDocInput>[];

    beforeEach(() => {
        vi.useFakeTimers();
        sessionStorage.clear();
        resetSaveState();
        resetTreePersistence();
        const rec = recordingBackend();
        puts = rec.puts;
        __setLibraryBackendForTests(rec.backend);
    });

    afterEach(() => {
        resetTreePersistence();
        __setLibraryBackendForTests(null);
        vi.useRealTimers();
    });

    it("writes doc_put once, 500 ms after the last change, with the latest value", async () => {
        const storage = createDocumentStorage<Doc>();
        storage.setItem("tab-1", { state: { n: 1 }, version: 0 });
        storage.setItem("tab-1", { state: { n: 2 }, version: 0 });
        expect(getSaveState()).toBe("unsaved");
        expect(hasPendingDocWrites()).toBe(true);
        // The mirror answers immediately from the pending queue.
        expect(storage.getItem("tab-1")).toEqual({ state: { n: 2 }, version: 0 });

        await vi.advanceTimersByTimeAsync(DOC_DEBOUNCE_MS - 1);
        expect(puts).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(puts).toHaveLength(1);
        expect(puts[0]).toMatchObject({ id: "tab-1", kind: "game", checkpoint: null });
        expect(puts[0].data).toBe(JSON.stringify({ state: { n: 2 }, version: 0 }));
        expect(getSaveState()).toBe("saved");
        expect(sessionStorage.getItem("tab-1")).toBe(
            JSON.stringify({ state: { n: 2 }, version: 0 }),
        );
    });

    it("skips unchanged payloads and titles documents from the game headers", async () => {
        const storage = createDocumentStorage<Doc>();
        storage.setItem("tab-1", { state: { n: 2 }, version: 0 });
        await vi.advanceTimersByTimeAsync(DOC_DEBOUNCE_MS);
        storage.setItem("tab-1", { state: { n: 2 }, version: 0 });
        await vi.advanceTimersByTimeAsync(DOC_DEBOUNCE_MS);
        expect(puts).toHaveLength(1);
        expect(getSaveState()).toBe("saved");

        storage.setItem("tab-2", {
            state: { headers: { white: "Carlsen", black: "Ding" } },
            version: 0,
        });
        await vi.advanceTimersByTimeAsync(DOC_DEBOUNCE_MS);
        expect(puts[1]).toMatchObject({ id: "tab-2", title: "Carlsen - Ding" });
    });

    it("flushDocWrites writes pending documents immediately", async () => {
        const storage = createDocumentStorage<Doc>();
        storage.setItem("tab-3", { state: { n: 3 }, version: 0 });
        await flushDocWrites();
        expect(puts).toHaveLength(1);
        expect(hasPendingDocWrites()).toBe(false);
        expect(getSaveState()).toBe("saved");
    });

    it("reports unsaved when the write fails", async () => {
        __setLibraryBackendForTests({
            ...createMemoryBackend(),
            async docPut() {
                throw new Error("disk full");
            },
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const storage = createDocumentStorage<Doc>();
        storage.setItem("tab-4", { state: { n: 4 }, version: 0 });
        await vi.advanceTimersByTimeAsync(DOC_DEBOUNCE_MS);
        expect(getSaveState()).toBe("unsaved");
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
