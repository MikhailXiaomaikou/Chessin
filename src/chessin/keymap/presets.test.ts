import { describe, expect, it, vi } from "vitest";
import { defaultKeyMap, type KeyMap } from "@/state/keybinds";
import {
    applyPreset,
    countCustomised,
    findCollisions,
    isKeymapPresetName,
    KEYMAP_PRESET_NAMES,
    presetKeyMap,
} from "./presets";

// `keybinds.ts` asks the OS plugin for the platform at import time (vi.mock is hoisted).
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

function withKeys(map: KeyMap, overrides: Record<string, string>): KeyMap {
    const next: KeyMap = { ...map };
    for (const [action, keys] of Object.entries(overrides)) {
        next[action] = { ...map[action], keys };
    }
    return next;
}

describe("keymap presets", () => {
    it("`chessin` is exactly the built-in defaults", () => {
        expect(presetKeyMap("chessin")).toEqual(defaultKeyMap);
        expect(defaultKeyMap.REOPEN_TAB.keys).toBe("ctrl+shift+t");
    });

    it("`chessbase` follows ChessBase muscle memory and keeps the palette on mod+k", () => {
        const map = presetKeyMap("chessbase");
        expect(map.TOGGLE_ALL_ENGINES.keys).toBe("alt+f2");
        expect(map.SWAP_ORIENTATION.keys).toBe("ctrl+f");
        expect(map.NEXT_GAME.keys).toBe("alt+arrowdown");
        expect(map.PREVIOUS_GAME.keys).toBe("alt+arrowup");
        expect(map.COMMAND_PALETTE.keys).toBe("ctrl+k");
        // Unrelated bindings and the display names are untouched.
        expect(map.NEW_TAB).toEqual(defaultKeyMap.NEW_TAB);
        expect(map.SWAP_ORIENTATION.name).toBe(defaultKeyMap.SWAP_ORIENTATION.name);
    });

    it("`lichess` uses f / l and ↑ / ↓ for start / end of game", () => {
        const map = presetKeyMap("lichess");
        expect(map.SWAP_ORIENTATION.keys).toBe("f");
        expect(map.TOGGLE_ALL_ENGINES.keys).toBe("l");
        expect(map.TOGGLE_EVAL_BAR.keys).toBe("z");
        expect(map.GO_TO_START.keys).toBe("arrowup");
        expect(map.GO_TO_END.keys).toBe("arrowdown");
        expect(map.GO_TO_BRANCH_START.keys).toBe("shift+arrowup");
        expect(map.GO_TO_BRANCH_END.keys).toBe("shift+arrowdown");
        expect(map.NEXT_BRANCHING.keys).toBe("shift+arrowright");
    });

    it("every preset binds each action exactly once", () => {
        for (const name of KEYMAP_PRESET_NAMES) {
            const map = presetKeyMap(name);
            expect(Object.keys(map).sort()).toEqual(Object.keys(defaultKeyMap).sort());
            expect({ name, collisions: findCollisions(map) }).toEqual({ name, collisions: [] });
        }
    });

    it("applyPreset rewrites the map and keeps non-colliding user overrides", () => {
        const current = withKeys(presetKeyMap("chessin"), {
            NEW_TAB: "ctrl+n", // user override, free in the ChessBase preset → kept
            SWAP_ORIENTATION: "y", // user override on an action the preset rebinds → kept (`r` is REVEAL since S4-6)
            DELETE_MOVE: "alt+f2", // user override colliding with the preset's engine toggle → dropped
        });
        const next = applyPreset("chessbase", current, "chessin");
        expect(next.NEW_TAB.keys).toBe("ctrl+n");
        expect(next.SWAP_ORIENTATION.keys).toBe("y");
        expect(next.DELETE_MOVE.keys).toBe(defaultKeyMap.DELETE_MOVE.keys);
        expect(next.TOGGLE_ALL_ENGINES.keys).toBe("alt+f2");
        expect(next.NEXT_GAME.keys).toBe("alt+arrowdown");
        expect(findCollisions(next)).toEqual([]);
    });

    it("applyPreset measures overrides against the previous preset, not the defaults", () => {
        // On ChessBase with no customisation: switching to Lichess must not carry
        // ChessBase's own bindings along as if the user had chosen them.
        const onChessBase = presetKeyMap("chessbase");
        const toLichess = applyPreset("lichess", onChessBase, "chessbase");
        expect(toLichess).toEqual(presetKeyMap("lichess"));

        // A genuine override made while on ChessBase survives the switch.
        const customised = withKeys(onChessBase, { COPY_PGN: "ctrl+shift+p" });
        expect(applyPreset("lichess", customised, "chessbase").COPY_PGN.keys).toBe("ctrl+shift+p");
        expect(applyPreset("chessin", customised, "chessbase").TOGGLE_ALL_ENGINES.keys).toBe(
            "ctrl+a",
        );
    });

    it("applyPreset keeps actions the preset does not know and tolerates bad entries", () => {
        const current: KeyMap = {
            ...presetKeyMap("chessin"),
            FUTURE_ACTION: { name: "Future", keys: "ctrl+9" },
            BROKEN: { name: "Broken" } as unknown as KeyMap[string],
        };
        const next = applyPreset("lichess", current);
        expect(next.FUTURE_ACTION).toEqual({ name: "Future", keys: "ctrl+9" });
        expect(next.BROKEN).toBeUndefined();
    });

    it("countCustomised counts bindings that differ from the preset", () => {
        expect(countCustomised(presetKeyMap("lichess"), "lichess")).toBe(0);
        const current = withKeys(presetKeyMap("lichess"), { NEW_TAB: "ctrl+n", UNDO: "ctrl+u" });
        expect(countCustomised(current, "lichess")).toBe(2);
        expect(countCustomised(current, "chessin")).toBe(2 + 5);
    });

    it("isKeymapPresetName validates stored values", () => {
        expect(isKeymapPresetName("chessbase")).toBe(true);
        expect(isKeymapPresetName("vim")).toBe(false);
        expect(isKeymapPresetName(null)).toBe(false);
    });
});
