import { describe, expect, it } from "vitest";
import type { Tab } from "@/utils/tabs";
import {
    describeSource,
    isLibraryOrigin,
    isReadOnlySource,
    libraryDocIdFor,
    originToString,
    retargetTabToLibrary,
    shouldAutoSave,
} from "./saveModel";

const file = {
    type: "file" as const,
    name: "games.pgn",
    path: "/home/me/Documents/games.pgn",
    numGames: 3,
    metadata: { tags: [], type: "game" as const },
    lastModified: 0,
};

const tab = (gameOrigin: Tab["gameOrigin"]): Tab => ({
    name: "Tab",
    value: "tab-1",
    type: "analysis",
    gameOrigin,
});

const fileTab = tab({ kind: "file", file, gameNumber: 2 });
const tempTab = tab({ kind: "temp_file", file, gameNumber: 0 });
const dbTab = tab({ kind: "database", database: "C:\\dbs\\mega.db3", gameId: 42 });
const libraryTab = tab({ kind: "library", docId: "doc-9" });
const scratchTab = tab({ kind: "none" });

describe("read-only source predicate", () => {
    it("treats external files and database games as read-only sources", () => {
        expect(isReadOnlySource(fileTab)).toBe(true);
        expect(isReadOnlySource(dbTab)).toBe(true);
    });

    it("does not treat scratch, temp or library tabs as read-only sources", () => {
        expect(isReadOnlySource(tempTab)).toBe(false);
        expect(isReadOnlySource(libraryTab)).toBe(false);
        expect(isReadOnlySource(scratchTab)).toBe(false);
        expect(isReadOnlySource(undefined)).toBe(false);
        expect(isReadOnlySource(null)).toBe(false);
    });
});

describe("autosave applies to library documents only", () => {
    it("is on only for a library tab with the toggle enabled", () => {
        expect(shouldAutoSave(libraryTab, true)).toBe(true);
        expect(shouldAutoSave(libraryTab, false)).toBe(false);
    });

    it("never writes external or scratch sources, whatever the toggle says", () => {
        for (const t of [fileTab, dbTab, tempTab, scratchTab, undefined]) {
            expect(shouldAutoSave(t, true)).toBe(false);
            expect(shouldAutoSave(t, false)).toBe(false);
        }
    });

    it("isLibraryOrigin only matches the library kind", () => {
        expect(isLibraryOrigin(libraryTab)).toBe(true);
        expect(isLibraryOrigin(fileTab)).toBe(false);
        expect(isLibraryOrigin(undefined)).toBe(false);
    });
});

describe("re-targeting a tab to the library", () => {
    it("replaces the origin and keeps everything else", () => {
        const next = retargetTabToLibrary(fileTab, "tab-1");
        expect(next).toEqual({ ...fileTab, gameOrigin: { kind: "library", docId: "tab-1" } });
        expect(next).not.toBe(fileTab);
        // The source tab is untouched.
        expect(fileTab.gameOrigin.kind).toBe("file");
        expect(isLibraryOrigin(next)).toBe(true);
        expect(isReadOnlySource(next)).toBe(false);
    });

    it("uses the tab id as document id unless the tab is already a library doc", () => {
        expect(libraryDocIdFor(fileTab)).toBe("tab-1");
        expect(libraryDocIdFor(dbTab)).toBe("tab-1");
        expect(libraryDocIdFor(scratchTab)).toBe("tab-1");
        expect(libraryDocIdFor(libraryTab)).toBe("doc-9");
    });
});

describe("origin descriptions", () => {
    it("serialises external origins for the documents.origin column", () => {
        expect(originToString(fileTab.gameOrigin)).toBe("file:/home/me/Documents/games.pgn#2");
        expect(originToString(tempTab.gameOrigin)).toBe("file:/home/me/Documents/games.pgn#0");
        expect(originToString(dbTab.gameOrigin)).toBe("database:C:\\dbs\\mega.db3#42");
        expect(originToString(libraryTab.gameOrigin)).toBeNull();
        expect(originToString(scratchTab.gameOrigin)).toBeNull();
    });

    it("describes the source with its base name on both path separators", () => {
        expect(describeSource(fileTab)).toEqual({
            kind: "file",
            name: "games.pgn",
            path: "/home/me/Documents/games.pgn",
            gameNumber: 2,
        });
        expect(describeSource(dbTab)).toEqual({
            kind: "database",
            name: "mega.db3",
            path: "C:\\dbs\\mega.db3",
            gameId: 42,
        });
        expect(describeSource(libraryTab)).toBeNull();
        expect(describeSource(scratchTab)).toBeNull();
        expect(describeSource(undefined)).toBeNull();
    });
});
