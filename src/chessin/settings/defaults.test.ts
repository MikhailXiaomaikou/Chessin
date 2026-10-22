import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keymapPresetAtom } from "@/chessin/keymap/presets";
import { autoPromoteAtom, fontSizeAtom, pieceSetAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import {
    isSettingModified,
    modifiedSettingIds,
    resetAllSettings,
    resetSetting,
    SETTING_ENTRIES,
    settingEntry,
} from "./defaults";

// `keybinds.ts` asks the OS plugin for the platform at import time (vi.mock is hoisted).
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

beforeEach(() => {
    localStorage.clear();
});

describe("setting defaults registry", () => {
    it("lists each id once", () => {
        const ids = SETTING_ENTRIES.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(settingEntry("auto-promote")?.default).toBe(true);
        expect(settingEntry("nope")).toBeUndefined();
    });

    it("declares the same default a fresh store reads", () => {
        const store = createStore();
        for (const e of SETTING_ENTRIES) {
            expect({ id: e.id, value: store.get(e.atom) }).toEqual({ id: e.id, value: e.default });
            expect(e.accept(e.default)).toBe(true);
        }
    });

    it("marks a changed value as modified and resets it", () => {
        const store = createStore();
        expect(isSettingModified(store, "auto-promote")).toBe(false);
        store.set(autoPromoteAtom, false);
        expect(isSettingModified(store, "auto-promote")).toBe(true);
        expect(modifiedSettingIds(store)).toEqual(["auto-promote"]);
        resetSetting(store, "auto-promote");
        expect(store.get(autoPromoteAtom)).toBe(true);
        expect(isSettingModified(store, "auto-promote")).toBe(false);
    });

    it("resets a derived atom by writing its default value", () => {
        const store = createStore();
        store.set(pieceSetAtom, "merida");
        expect(isSettingModified(store, "piece-set")).toBe(true);
        resetSetting(store, "piece-set");
        expect(store.get(pieceSetAtom)).toBe("cburnett");
    });

    it("resets the keymap together with its preset", () => {
        const store = createStore();
        store.set(keymapPresetAtom, "lichess");
        store.set(keyMapAtom, (prev) => ({ ...prev, SWAP_ORIENTATION: { name: "x", keys: "g" } }));
        expect(isSettingModified(store, "keybinds")).toBe(true);
        resetSetting(store, "keymap-preset");
        expect(store.get(keymapPresetAtom)).toBe("chessin");
        expect(store.get(keyMapAtom).SWAP_ORIENTATION.keys).toBe("f");
    });

    it("resets everything at once", () => {
        const store = createStore();
        store.set(fontSizeAtom, 140);
        store.set(autoPromoteAtom, false);
        expect(modifiedSettingIds(store).sort()).toEqual(["auto-promote", "font-size"]);
        resetAllSettings(store);
        expect(modifiedSettingIds(store)).toEqual([]);
    });

    it("validates imported values per entry", () => {
        expect(settingEntry("coordinates")?.accept("edge")).toBe(true);
        expect(settingEntry("coordinates")?.accept("sideways")).toBe(false);
        expect(settingEntry("volume")?.accept(0.5)).toBe(true);
        expect(settingEntry("volume")?.accept(7)).toBe(false);
        expect(settingEntry("auto-save")?.accept("true")).toBe(false);
        expect(settingEntry("keybinds")?.accept({ UNDO: { name: "Undo", keys: "ctrl+z" } })).toBe(
            true,
        );
        expect(settingEntry("keybinds")?.accept({ UNDO: "ctrl+z" })).toBe(false);
    });
});
