import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoPromoteAtom, fontSizeAtom, showCoordinatesAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { SETTING_ENTRIES } from "./defaults";
import {
    applySettingsFile,
    collectSettings,
    exportSettingsToFile,
    importSettingsFromFile,
    parseSettingsFile,
    serializeSettings,
    SETTINGS_FILE_NAME,
} from "./exportImport";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

beforeEach(() => {
    localStorage.clear();
});

describe("settings file", () => {
    it("collects every registered setting with its current value", () => {
        const store = createStore();
        store.set(fontSizeAtom, 120);
        const file = collectSettings(store, new Date("2026-10-22T08:00:00Z"));
        expect(file.app).toBe("chessin");
        expect(file.version).toBe(1);
        expect(file.exportedAt).toBe("2026-10-22T08:00:00.000Z");
        expect(Object.keys(file.settings).sort()).toEqual(SETTING_ENTRIES.map((e) => e.id).sort());
        expect(file.settings["font-size"]).toBe(120);
        expect(file.settings["auto-promote"]).toBe(true);
    });

    it("round-trips through JSON and applies the values to another store", () => {
        const source = createStore();
        source.set(autoPromoteAtom, false);
        source.set(showCoordinatesAtom, "all");
        source.set(keyMapAtom, (prev) => ({ ...prev, UNDO: { ...prev.UNDO, keys: "ctrl+u" } }));
        const text = serializeSettings(collectSettings(source));

        const parsed = parseSettingsFile(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const target = createStore();
        const { applied, skipped } = applySettingsFile(target, parsed.file);
        expect(skipped).toEqual([]);
        expect(applied.length).toBe(SETTING_ENTRIES.length);
        expect(target.get(autoPromoteAtom)).toBe(false);
        expect(target.get(showCoordinatesAtom)).toBe("all");
        expect(target.get(keyMapAtom).UNDO.keys).toBe("ctrl+u");
        // The stored copies are updated as well (atomWithStorage writes through).
        expect(JSON.parse(localStorage.getItem("auto-promote") ?? "null")).toBe(false);
    });

    it("rejects broken JSON, foreign files and newer versions", () => {
        expect(parseSettingsFile("{")).toEqual({ ok: false, reason: "json" });
        expect(parseSettingsFile('{"app":"other","version":1,"settings":{}}')).toEqual({
            ok: false,
            reason: "format",
        });
        expect(parseSettingsFile('{"app":"chessin","version":1}')).toEqual({
            ok: false,
            reason: "format",
        });
        expect(parseSettingsFile('{"app":"chessin","version":99,"settings":{}}')).toEqual({
            ok: false,
            reason: "version",
        });
    });

    it("skips unknown ids and values of the wrong shape, applying the rest", () => {
        const store = createStore();
        const result = applySettingsFile(store, {
            app: "chessin",
            version: 1,
            settings: {
                "auto-promote": false,
                "font-size": "big",
                coordinates: "sideways",
                sessions: [{ token: "never" }],
            },
        });
        expect(result.applied).toEqual(["auto-promote"]);
        expect(result.skipped).toEqual(["font-size", "coordinates", "sessions"]);
        expect(store.get(autoPromoteAtom)).toBe(false);
        expect(store.get(fontSizeAtom)).toBe(100);
    });

    it("exports through the save dialog and writes the file", async () => {
        const store = createStore();
        store.set(fontSizeAtom, 110);
        const written: { path: string; contents: string }[] = [];
        const path = await exportSettingsToFile(store, {
            save: async (options) => {
                expect(options.defaultPath).toBe(SETTINGS_FILE_NAME);
                return "/tmp/out.json";
            },
            writeTextFile: async (path, contents) => {
                written.push({ path, contents });
            },
        });
        expect(path).toBe("/tmp/out.json");
        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0].contents).settings["font-size"]).toBe(110);

        const cancelled = await exportSettingsToFile(store, {
            save: async () => null,
            writeTextFile: async () => {
                throw new Error("must not write");
            },
        });
        expect(cancelled).toBeNull();
    });

    it("imports through the open dialog, reporting cancel / invalid / applied", async () => {
        const store = createStore();
        const text = serializeSettings({
            app: "chessin",
            version: 1,
            settings: { "auto-promote": false, bogus: 1 },
        });
        const applied = await importSettingsFromFile(store, {
            open: async () => "/tmp/in.json",
            readTextFile: async () => text,
        });
        expect(applied).toEqual({
            status: "applied",
            path: "/tmp/in.json",
            applied: ["auto-promote"],
            skipped: ["bogus"],
        });
        expect(store.get(autoPromoteAtom)).toBe(false);

        expect(
            await importSettingsFromFile(store, {
                open: async () => null,
                readTextFile: async () => text,
            }),
        ).toEqual({ status: "cancelled" });

        expect(
            await importSettingsFromFile(store, {
                open: async () => ["/tmp/x.json"],
                readTextFile: async () => "nope",
            }),
        ).toEqual({ status: "invalid", reason: "json" });
    });
});
