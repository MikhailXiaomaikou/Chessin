import { beforeAll, expect, test } from "vitest";
import { hasCjk, loadPinyin, pinyinIndex } from "./pinyin";
import type { Command } from "./registry";
import { buildFuse, indexCommands, searchCommands } from "./search";

const noop = () => {};

const commands: Command[] = [
    { id: "palette", title: () => "命令面板", section: "app", run: noop },
    {
        id: "file.newTab",
        title: () => "新建标签页",
        section: "file",
        aliases: ["new tab"],
        run: noop,
    },
    {
        id: "board.copyPgn",
        title: () => "复制 PGN",
        section: "board",
        aliases: ["copy pgn"],
        run: noop,
    },
    {
        id: "board.flip",
        title: () => "翻转棋盘",
        section: "board",
        aliases: ["flip board"],
        run: noop,
    },
    {
        id: "sources.default",
        title: () => "默认来源",
        section: "sources",
        aliases: ["参考数据库"],
        run: noop,
    },
];

beforeAll(async () => {
    await loadPinyin();
});

test("pinyin index gives full syllables and initials for Chinese titles only", () => {
    expect(hasCjk("命令面板")).toBe(true);
    expect(hasCjk("copy pgn")).toBe(false);
    const idx = pinyinIndex("命令面板");
    expect(idx.initials).toBe("mlmb");
    expect(idx.full).toContain("ming ling mian ban");
    expect(idx.full).toContain("minglingmianban");
    expect(pinyinIndex("copy pgn")).toEqual({ full: "", initials: "" });
});

function ids(query: string): string[] {
    const entries = indexCommands(commands);
    const fuse = buildFuse(entries);
    return searchCommands(entries, fuse, query).map((e) => e.id);
}

test("empty query returns everything in registration order", () => {
    expect(ids("")).toEqual(commands.map((c) => c.id));
});

test("initials and full pinyin find Chinese titles", () => {
    expect(ids("mlmb")[0]).toBe("palette");
    expect(ids("mingling")[0]).toBe("palette");
    expect(ids("fzqp")[0]).toBe("board.flip");
    expect(ids("xinjian")[0]).toBe("file.newTab");
});

test("Chinese, English aliases and ChessBase terminology all match", () => {
    expect(ids("面板")[0]).toBe("palette");
    expect(ids("new tab")[0]).toBe("file.newTab");
    expect(ids("copy")[0]).toBe("board.copyPgn");
    expect(ids("参考数据库")[0]).toBe("sources.default");
    expect(ids("ckSJK")[0]).toBe("sources.default");
});
