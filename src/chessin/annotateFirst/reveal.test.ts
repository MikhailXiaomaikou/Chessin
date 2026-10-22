import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import enUS from "../../translation/en-US.json";
import zhCN from "../../translation/zh-CN.json";
import { keybindLabel } from "@/chessin/keymap/labels";
import { findCollisions, KEYMAP_PRESET_NAMES, presetKeyMap } from "@/chessin/keymap/presets";
import { defaultKeyMap } from "@/state/keybinds";

// `keybinds.ts` asks the OS plugin for the platform at import time (vi.mock is hoisted).
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

const en: Record<string, string> = enUS.translation;
const zh: Record<string, string> = zhCN.translation;

// The S4-6 sources as text (Vite's raw import), so the test can list the keys they use.
const sources = import.meta.glob(
    ["../guess/*.ts", "../guess/*.tsx", "./*.ts", "./*.tsx", "!**/*.test.ts"],
    { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Every `Guess.*` / `AnnotateFirst.*` / `Keymap.REVEAL` key the S4-6 sources reference. */
function referencedKeys(): string[] {
    const keys = new Set<string>();
    for (const text of Object.values(sources)) {
        for (const m of text.matchAll(
            /\bt[r]?\("((?:Guess|AnnotateFirst|Keymap\.REVEAL)[^"]*)"/g,
        )) {
            keys.add(m[1]);
        }
    }
    return Array.from(keys).sort();
}

describe("REVEAL key (S4-6)", () => {
    it("is `r` in the defaults and in every preset, without collisions", () => {
        expect(defaultKeyMap.REVEAL.keys).toBe("r");
        for (const name of KEYMAP_PRESET_NAMES) {
            const map = presetKeyMap(name);
            expect({ name, keys: map.REVEAL.keys }).toEqual({ name, keys: "r" });
            expect({ name, collisions: findCollisions(map) }).toEqual({ name, collisions: [] });
        }
    });

    it("has a translated label", () => {
        const t = ((key: string) => `<${key}>`) as unknown as TFunction;
        expect(keybindLabel("REVEAL", t, "fallback")).toBe("<Keymap.REVEAL>");
        expect(zh["Keymap.REVEAL"]).toContain("揭晓");
        expect(en["Keymap.REVEAL"]).toContain("Reveal");
    });
});

describe("S4-6 translations", () => {
    it("exist in zh-CN and en-US for every key the code references", () => {
        const keys = referencedKeys();
        expect(keys.length).toBeGreaterThan(30);
        const missing = keys.filter((k) => !(k in zh) || !(k in en));
        expect(missing).toEqual([]);
        const empty = keys.filter((k) => !zh[k].trim() || !en[k].trim());
        expect(empty).toEqual([]);
    });

    it("spell the summary the way the contract shows it", () => {
        expect(zh["Guess.Summary"]).toBe("{{correct}}/{{total}} 着 · {{points}} 分");
        expect(zh["AnnotateFirst.KeyMoment"]).toBe("关键，在这里想一想");
    });
});
