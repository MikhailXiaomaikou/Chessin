import { beforeAll, describe, expect, it } from "vitest";
import { loadPinyin } from "@/chessin/commands/pinyin";
import { normalizeQuery, type SearchableSetting, searchSettings, synonymHints } from "./search";
import { SETTING_SYNONYMS, synonymsFor } from "./synonyms";

// A slice of the zh-CN settings rows as SettingsPage builds them.
const rows: SearchableSetting[] = [
    {
        id: "piece-dest",
        title: "可走格提示",
        description: "显示棋子可以走到的格子",
        keywords: ["destination", "moves", "highlight"],
        categoryTitle: "棋盘",
    },
    {
        id: "auto-promote",
        title: "自动升变",
        description: "当兵到达底线时，自动升变为后",
        keywords: ["promote", "queen", "pawn"],
        categoryTitle: "棋盘",
    },
    {
        id: "keymap-preset",
        title: "键位方案",
        description: "按 Chessin、ChessBase 或 Lichess 的习惯设置快捷键",
        keywords: [
            "keymap",
            "preset",
            "shortcuts",
            "chessbase",
            "lichess",
            "键位",
            "方案",
            "快捷键",
        ],
        categoryTitle: "快捷键",
    },
    {
        id: "font-size",
        title: "字体大小",
        description: "整体字体大小",
        keywords: ["font", "size", "text"],
        categoryTitle: "外观",
    },
    {
        id: "annotation-palette",
        title: "注释配色",
        description: "箭头与注释的配色。Okabe–Ito 色板对色觉障碍友好",
        keywords: ["palette", "okabe", "colorblind", "色盲", "箭头"],
        categoryTitle: "外观",
    },
    {
        id: "engines-directory",
        title: "引擎目录",
        description: "这是“引擎”页面中引擎二进制文件及配置存储的位置",
        keywords: ["engines", "directory", "folder", "path"],
        categoryTitle: "目录",
    },
    {
        id: "default-source",
        title: "默认来源",
        description: "开局探索器默认使用的来源",
        keywords: ["source", "explorer"],
        categoryTitle: "棋盘",
    },
];

const ids = (query: string) => searchSettings(rows, query).map((m) => m.item.id);

beforeAll(async () => {
    await loadPinyin();
});

describe("searchSettings", () => {
    it("matches Chinese titles and English keywords, title first", () => {
        expect(ids("升变")).toEqual(["auto-promote"]);
        expect(ids("promote")[0]).toBe("auto-promote");
        expect(ids("字体")).toEqual(["font-size"]);
    });

    it("matches full pinyin and initials of Chinese text", () => {
        expect(ids("zidongshengbian")).toEqual(["auto-promote"]);
        expect(ids("zdsb")).toEqual(["auto-promote"]);
        expect(ids("ztdx")[0]).toBe("font-size");
        expect(ids("jianwei")[0]).toBe("keymap-preset");
    });

    it("searches descriptions and categories with a lower score than titles", () => {
        const byDescription = searchSettings(rows, "底线");
        expect(byDescription.map((m) => m.item.id)).toEqual(["auto-promote"]);
        const byTitle = searchSettings(rows, "自动升变");
        expect(byTitle[0].score).toBeGreaterThan(byDescription[0].score);
        expect(ids("外观")).toEqual(["font-size", "annotation-palette"]);
    });

    it("requires every word of a multi-word query", () => {
        expect(ids("font size")).toEqual(["font-size"]);
        expect(ids("font 升变")).toEqual([]);
    });

    it("returns nothing for an empty query and ignores case and spacing", () => {
        expect(ids("")).toEqual([]);
        expect(ids("   ")).toEqual([]);
        expect(ids("  PROMOTE ")).toEqual(["auto-promote"]);
        expect(normalizeQuery("  Font   Size ")).toBe("font size");
    });

    it("finds 默认来源 through the ChessBase term 参考库 and explains the synonym", () => {
        const matches = searchSettings(rows, "参考库");
        expect(matches.map((m) => m.item.id)).toEqual(["default-source"]);
        expect(matches[0].synonym).toEqual({ term: "参考库", target: "默认来源" });
        expect(synonymHints(matches)).toEqual([{ term: "参考库", target: "默认来源" }]);
        expect(ids("参考数据库")).toEqual(["default-source"]);
        expect(ids("reference database")).toEqual(["default-source"]);
    });

    it("maps 引擎管理 → 引擎, 热键 → 键位方案 and 色盲 → 注释配色", () => {
        expect(ids("引擎管理")).toEqual(["engines-directory"]);
        expect(ids("热键")).toEqual(["keymap-preset"]);
        expect(ids("colour blind")).toEqual(["annotation-palette"]);
    });

    it("prefers a direct match over the same row found through a synonym", () => {
        // "快捷键" is both a keyword of the row and a synonym term; the direct hit wins and carries no hint.
        const matches = searchSettings(rows, "快捷键");
        expect(matches[0].item.id).toBe("keymap-preset");
        expect(matches[0].synonym).toBeUndefined();
    });
});

describe("synonymsFor", () => {
    it("matches a term in either direction but never on a single letter", () => {
        expect(synonymsFor("medals").map((h) => h.target)).toEqual(["亮点", "highlight"]);
        expect(synonymsFor("Reference").map((h) => h.target)).toContain("默认来源");
        expect(synonymsFor("a")).toEqual([]);
        expect(synonymsFor("")).toEqual([]);
    });

    it("has no empty terms or targets", () => {
        for (const entry of SETTING_SYNONYMS) {
            expect(entry.terms.length).toBeGreaterThan(0);
            expect(entry.targets.length).toBeGreaterThan(0);
            for (const s of [...entry.terms, ...entry.targets]) expect(s.trim()).not.toBe("");
        }
    });
});
