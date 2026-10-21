import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseInfo } from "@/bindings";
import { clearCommands, getCommand } from "@/chessin/commands/registry";
import {
    closeFirstRun,
    firstRunDoneAtom,
    isFirstRunOpen,
    openFirstRun,
    setFirstRunVisible,
} from "./firstRunState";
import { classifyImportFile, titleFromFileName, uniqueDatabaseTitle } from "./importers";

function db(title: string): DatabaseInfo {
    return {
        type: "success",
        title,
        description: "",
        player_count: 0,
        event_count: 0,
        game_count: 0,
        storage_size: BigInt(0),
        filename: `${title}.db3`,
        indexed: true,
        file: `/tmp/${title}.db3`,
    };
}

describe("first run importers", () => {
    it("classifies supported import files by extension", () => {
        expect(classifyImportFile("/a/games.pgn")).toBe("pgn");
        expect(classifyImportFile("C:\\a\\Games.PGN")).toBe("pgn");
        expect(classifyImportFile("/a/lichess_2024.pgn.zst")).toBe("pgn");
        expect(classifyImportFile("/a/twic.pgn.bz2")).toBe("pgn");
        expect(classifyImportFile("/a/MegaBase.cbh")).toBe("cbh");
        expect(classifyImportFile("/a/notes.txt")).toBeNull();
        expect(classifyImportFile("/a/archive.zst")).toBeNull();
        expect(classifyImportFile("/a/base.cbg")).toBeNull();
    });

    it("derives a database title like AddDatabase does", () => {
        expect(titleFromFileName("my_games-2024.pgn")).toBe("My games 2024");
        expect(titleFromFileName("twic.pgn.zst")).toBe("Twic");
        expect(titleFromFileName("twic.pgn.bz2")).toBe("Twic");
        expect(titleFromFileName("Mega2024.cbh")).toBe("Mega2024");
    });

    it("de-duplicates titles against existing databases", () => {
        const existing = [db("Twic"), db("Twic (2)"), db("Other")];
        expect(uniqueDatabaseTitle("Twic", existing)).toBe("Twic (3)");
        expect(uniqueDatabaseTitle("Fresh", existing)).toBe("Fresh");
        expect(uniqueDatabaseTitle("   ", [])).toBe("Games");
    });
});

describe("first run state", () => {
    beforeEach(() => {
        closeFirstRun();
        setFirstRunVisible(false);
    });

    it("persists the done flag under chessin.firstRunDone", () => {
        localStorage.removeItem("chessin.firstRunDone");
        const store = createStore();
        expect(store.get(firstRunDoneAtom)).toBe(false);
        store.set(firstRunDoneAtom, true);
        expect(store.get(firstRunDoneAtom)).toBe(true);
        expect(localStorage.getItem("chessin.firstRunDone")).toBe("true");
        store.set(firstRunDoneAtom, false);
        expect(localStorage.getItem("chessin.firstRunDone")).toBe("false");
    });

    it("tracks visibility for other modules", () => {
        expect(isFirstRunOpen()).toBe(false);
        setFirstRunVisible(true);
        expect(isFirstRunOpen()).toBe(true);
    });

    it("registers the firstRun.open command at module load", () => {
        const command = getCommand("firstRun.open");
        expect(command?.section).toBe("help");
        expect(typeof command?.title).toBe("function");
        expect(typeof command?.run).toBe("function");
        expect(command?.aliases).toContain("新手引导");
        // openFirstRun() does not depend on the registry.
        clearCommands();
        expect(getCommand("firstRun.open")).toBeUndefined();
        expect(() => openFirstRun()).not.toThrow();
        closeFirstRun();
    });
});
