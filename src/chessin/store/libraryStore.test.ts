import { beforeEach, describe, expect, it } from "vitest";
import { writeSessionMirror } from "@/state/store/debouncedStorage";
import {
    __setLibraryBackendForTests,
    createCheckpoint,
    createMemoryBackend,
    deleteDoc,
    deleteKv,
    getDoc,
    getKv,
    hasNativeLibraryCommands,
    hasTauri,
    isLibraryStoreNative,
    listDocs,
    listDocVersions,
    putDoc,
    restoreDocVersion,
    setKv,
    unwrapResult,
    VERSION_CAP,
    VERSION_MERGE_MS,
} from "./libraryStore";
import { getSaveState, resetSaveState } from "./saveState";

beforeEach(() => {
    __setLibraryBackendForTests(null);
    sessionStorage.clear();
    resetSaveState();
});

describe("libraryStore fallback", () => {
    it("uses the in-memory backend outside Tauri", async () => {
        expect(hasTauri()).toBe(false);
        expect(isLibraryStoreNative()).toBe(false);

        expect(await getKv("missing")).toBeNull();
        await setKv("workspace.tabs", "[]");
        expect(await getKv("workspace.tabs")).toBe("[]");
        await deleteKv("workspace.tabs");
        expect(await getKv("workspace.tabs")).toBeNull();
    });

    it("picks the native backend inside Tauri once the plugin commands exist", () => {
        const w = window as unknown as Record<string, unknown>;
        w.__TAURI_INTERNALS__ = {};
        try {
            expect(hasTauri()).toBe(true);
            expect(hasNativeLibraryCommands()).toBe(true);
            expect(isLibraryStoreNative()).toBe(true);
        } finally {
            delete w.__TAURI_INTERNALS__;
        }
    });

    it("unwraps plain values and tauri-specta Result envelopes", () => {
        expect(unwrapResult<string>("x")).toBe("x");
        expect(unwrapResult<string | null>(null)).toBeNull();
        expect(unwrapResult<number>({ status: "ok", data: 3 })).toBe(3);
        expect(() => unwrapResult({ status: "error", error: "boom" })).toThrow("boom");
    });

    it("round-trips documents and lists metadata without data", async () => {
        await putDoc({ id: "t1", kind: "game", title: "A - B", data: '{"a":1}' });
        await putDoc({ id: "t2", kind: "note", title: "Notes", origin: "x", data: "{}" });

        const doc = await getDoc("t1");
        expect(doc).toMatchObject({ id: "t1", kind: "game", title: "A - B", origin: null });
        expect(doc?.data).toBe('{"a":1}');
        expect(await getDoc("nope")).toBeNull();

        const games = await listDocs("game");
        expect(games.map((d) => d.id)).toEqual(["t1"]);
        expect("data" in games[0]).toBe(false);
        expect((await listDocs()).map((d) => d.id).sort()).toEqual(["t1", "t2"]);

        await deleteDoc("t1");
        expect(await getDoc("t1")).toBeNull();
        expect(await listDocVersions("t1")).toEqual([]);
    });

    it("merges autosave versions within 5 minutes, always keeps checkpoints, caps at 50", async () => {
        let now = 1_000;
        __setLibraryBackendForTests(createMemoryBackend(() => now));

        await putDoc({ id: "g", kind: "game", title: "g", data: "v1" });
        now += 1_000;
        await putDoc({ id: "g", kind: "game", title: "g", data: "v2" });
        expect(await listDocVersions("g")).toHaveLength(1);

        now += VERSION_MERGE_MS;
        await putDoc({ id: "g", kind: "game", title: "g", data: "v3" });
        expect(await listDocVersions("g")).toHaveLength(2);

        now += 1;
        await putDoc({ id: "g", kind: "game", title: "g", data: "v4", checkpoint: "before" });
        const versions = await listDocVersions("g");
        expect(versions).toHaveLength(3);
        expect(versions[0].label).toBe("before");

        for (let i = 0; i < VERSION_CAP + 10; i++) {
            now += 1;
            await putDoc({ id: "g", kind: "game", title: "g", data: `c${i}`, checkpoint: `c${i}` });
        }
        expect(await listDocVersions("g")).toHaveLength(VERSION_CAP);
    });

    it("restores a version into the document", async () => {
        await putDoc({ id: "r", kind: "game", title: "r", data: "old", checkpoint: "first" });
        await putDoc({ id: "r", kind: "game", title: "r", data: "new", checkpoint: "second" });
        const first = (await listDocVersions("r")).find((v) => v.label === "first")!;
        await restoreDocVersion("r", first.id);
        expect((await getDoc("r"))?.data).toBe("old");
        await expect(restoreDocVersion("r", 9999)).rejects.toThrow("No version 9999");
    });

    it("createCheckpoint writes the session mirror as a labelled version", async () => {
        expect(await createCheckpoint("no-such-tab")).toBeNull();

        const raw = JSON.stringify({
            version: 0,
            state: { headers: { white: "Carlsen", black: "Ding", event: "WCh" } },
        });
        writeSessionMirror("tab-x", raw);
        const result = await createCheckpoint("tab-x", "before sac");
        expect(result).toEqual({ id: "tab-x", label: "before sac" });

        const doc = await getDoc("tab-x");
        expect(doc?.data).toBe(raw);
        expect(doc?.title).toBe("Carlsen - Ding");
        expect((await listDocVersions("tab-x"))[0].label).toBe("before sac");
        expect(getSaveState()).toBe("saved");
    });
});
