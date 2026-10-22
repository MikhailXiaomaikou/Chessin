import { beforeEach, describe, expect, it } from "vitest";
import { __setLibraryBackendForTests, createMemoryBackend, getKv } from "./libraryStore";
import { classifyLocalKey, clearSavedData, collectEntries } from "./clearData";
import {
    __resetWorkspaceForTests,
    WORKSPACE_ACTIVE_TAB_KEY,
    WORKSPACE_TABS_KEY,
} from "./workspace";

function fakeStorage(init: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(init));
    return {
        get length() {
            return map.size;
        },
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
            map.set(k, String(v));
        },
        removeItem: (k: string) => {
            map.delete(k);
        },
        clear: () => map.clear(),
    } as Storage;
}

beforeEach(() => {
    __resetWorkspaceForTests();
    __setLibraryBackendForTests(createMemoryBackend());
});

describe("clearSavedData", () => {
    it("classifies localStorage keys", () => {
        expect(classifyLocalKey("sessions")).toBe("login");
        expect(classifyLocalKey("show-sidebar")).toBe("layout");
        expect(classifyLocalKey("windowsState")).toBe("layout");
        expect(classifyLocalKey("deck-/x.pgn-0")).toBe("training");
        expect(classifyLocalKey("keybinds")).toBe("settings");
        expect(classifyLocalKey("mantine-color-scheme")).toBe("settings");
        expect(classifyLocalKey("chessin.offline")).toBe("settings");
    });

    it("backs up localStorage and removes only the selected buckets", async () => {
        const local = fakeStorage({
            keybinds: "{}",
            "show-sidebar": "true",
            "deck-a-0": "{}",
            sessions: "[]",
        });
        const session = fakeStorage({ tabs: "[]", "tab-1": "{}" });
        const backend = createMemoryBackend();
        __setLibraryBackendForTests(backend);
        await backend.storeSet(WORKSPACE_TABS_KEY, "[]");
        await backend.storeSet(WORKSPACE_ACTIVE_TAB_KEY, "x");

        const result = await clearSavedData(
            { settings: true, layout: false, training: false, login: false },
            { local, session, now: () => 42 },
        );
        expect(result.backupKey).toBe("backup.localStorage.42");
        expect(JSON.parse((await getKv(result.backupKey))!)).toEqual(
            collectEntries(
                fakeStorage({
                    keybinds: "{}",
                    "show-sidebar": "true",
                    "deck-a-0": "{}",
                    sessions: "[]",
                }),
            ),
        );
        expect(result.removed).toEqual(["keybinds"]);
        expect(local.getItem("keybinds")).toBeNull();
        expect(local.getItem("show-sidebar")).toBe("true");
        expect(session.length).toBe(2);
        expect(await getKv(WORKSPACE_TABS_KEY)).toBe("[]");

        await clearSavedData(
            { settings: false, layout: true, training: true, login: true },
            { local, session, now: () => 43 },
        );
        expect(local.length).toBe(0);
        expect(session.length).toBe(0);
        expect(await getKv(WORKSPACE_TABS_KEY)).toBeNull();
        expect(await getKv(WORKSPACE_ACTIVE_TAB_KEY)).toBeNull();
        expect(await getKv("backup.localStorage.43")).not.toBeNull();
    });

    it("aborts before removing anything when the backup cannot be written", async () => {
        __setLibraryBackendForTests({
            ...createMemoryBackend(),
            async storeSet() {
                throw new Error("read-only");
            },
        });
        const local = fakeStorage({ keybinds: "{}" });
        await expect(
            clearSavedData(
                { settings: true, layout: false, training: false, login: false },
                { local, session: fakeStorage() },
            ),
        ).rejects.toThrow("read-only");
        expect(local.getItem("keybinds")).toBe("{}");
    });
});
