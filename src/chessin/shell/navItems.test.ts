import { describe, expect, it } from "vitest";
import {
    ALL_NAV_ITEMS,
    isNavActive,
    NAV_ITEMS,
    NAV_PINNED,
    navIdForPath,
    navItemById,
} from "./navItems";

describe("nav items", () => {
    it("has the six IA-1 positions (棋谱库 as a group with 文件) and 引擎 / 设置 pinned last", () => {
        expect(NAV_ITEMS.map((i) => i.id)).toEqual([
            "home",
            "library",
            "files",
            "board",
            "repertoire",
            "train",
            "players",
            "prep",
            "events",
        ]);
        expect(NAV_ITEMS.find((i) => i.id === "files")?.child).toBe(true);
        // S4-2 / S4-3: 备战 and 赛事复盘 are indented under 棋手.
        expect(NAV_ITEMS.find((i) => i.id === "prep")?.child).toBe(true);
        expect(NAV_ITEMS.find((i) => i.id === "events")?.child).toBe(true);
        expect(NAV_PINNED.map((i) => i.id)).toEqual(["engines", "settings"]);
        expect(navItemById("settings").labelKey).toBe("SideBar.Settings");
        expect(() => navItemById("nope" as never)).toThrow("unknown nav item nope");
    });

    it("keeps the accessible names of the rows that existed before S3-6", () => {
        const keys = Object.fromEntries(ALL_NAV_ITEMS.map((i) => [i.id, i.labelKey]));
        expect(keys).toMatchObject({
            board: "SideBar.Board",
            files: "SideBar.Files",
            engines: "SideBar.Engines",
            settings: "SideBar.Settings",
        });
    });

    it("maps a pathname to its nav position, longest route first", () => {
        expect(navIdForPath("/databases", false)).toBe("library");
        expect(navIdForPath("/databases/My%20games", false)).toBe("library");
        expect(navIdForPath("/files", false)).toBe("files");
        expect(navIdForPath("/repertoire", false)).toBe("repertoire");
        expect(navIdForPath("/notebook", false)).toBe("train");
        expect(navIdForPath("/accounts", false)).toBe("players");
        expect(navIdForPath("/prep", false)).toBe("prep");
        expect(navIdForPath("/events", false)).toBe("events");
        expect(navIdForPath("/engines", false)).toBe("engines");
        expect(navIdForPath("/settings", false)).toBe("settings");
        expect(navIdForPath("/unknown", false)).toBeNull();
        expect(navIdForPath("/filesystem", false)).toBeNull();
    });

    it("treats the board page as 主页 while the new-tab home is active", () => {
        expect(navIdForPath("/", true)).toBe("home");
        expect(navIdForPath("/", false)).toBe("board");
        expect(navIdForPath("", true)).toBe("home");
        expect(isNavActive(navItemById("home"), "/", true)).toBe(true);
        expect(isNavActive(navItemById("board"), "/", true)).toBe(false);
        expect(isNavActive(navItemById("board"), "/", false)).toBe(true);
        expect(isNavActive(navItemById("library"), "/", false)).toBe(false);
    });
});
