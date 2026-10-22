import { describe, expect, it } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { collectRepertoires, type FileEntry } from "./repertoireFiles";

function file(
    name: string,
    type: FileMetadata["metadata"]["type"],
    lastModified = 0,
): FileMetadata {
    return {
        type: "file",
        name,
        path: `/docs/${name}.pgn`,
        numGames: 1,
        metadata: { type, tags: [] },
        lastModified,
    };
}

describe("collectRepertoires", () => {
    it("keeps only repertoire files, including those in subfolders", () => {
        const entries: FileEntry[] = [
            file("games", "game", 5),
            file("white", "repertoire", 3),
            {
                type: "directory",
                name: "openings",
                path: "/docs/openings",
                children: [file("black", "repertoire", 9), file("puzzles", "puzzle", 10)],
            },
        ];
        expect(collectRepertoires(entries).map((f) => f.name)).toEqual(["black", "white"]);
    });

    it("lists the most recently modified first and breaks ties by name", () => {
        const entries: FileEntry[] = [
            file("b", "repertoire", 1),
            file("a", "repertoire", 1),
            file("c", "repertoire", 2),
        ];
        expect(collectRepertoires(entries).map((f) => f.name)).toEqual(["c", "a", "b"]);
    });

    it("returns an empty list when there is nothing", () => {
        expect(collectRepertoires([])).toEqual([]);
        expect(collectRepertoires([file("x", "other")])).toEqual([]);
    });
});
