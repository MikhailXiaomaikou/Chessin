import { expect, test } from "vitest";
import enUS from "../../translation/en-US.json";
import zhCN from "../../translation/zh-CN.json";
import zhTW from "../../translation/zh-TW.json";

const en: Record<string, string> = enUS.translation;
const zh: Record<string, string> = zhCN.translation;
const tw: Record<string, string> = zhTW.translation;

// Chinese has a single CLDR plural category, so "Key_one" / "Key_zero" in
// en-US are satisfied by "Key_other" in zh-CN.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function chineseKeyFor(key: string, locale: Record<string, string>): string | undefined {
    if (key in locale) return key;
    if (PLURAL_SUFFIX.test(key)) {
        const other = key.replace(PLURAL_SUFFIX, "_other");
        if (other in locale) return other;
    }
    return undefined;
}

test("every en-US key has a non-empty zh-CN translation", () => {
    const missing: string[] = [];
    const empty: string[] = [];
    for (const key of Object.keys(en)) {
        const zhKey = chineseKeyFor(key, zh);
        if (zhKey === undefined) {
            missing.push(key);
        } else if (zh[zhKey].trim() === "") {
            empty.push(zhKey);
        }
    }
    expect(missing).toEqual([]);
    expect(empty).toEqual([]);
});

test("zh-CN has no keys that en-US lacks", () => {
    const extra = Object.keys(zh).filter((key) => chineseKeyFor(key, en) === undefined);
    expect(extra).toEqual([]);
});

test("zh-CN never uses 开局库 (repertoire vs. opening book collision)", () => {
    const offenders = Object.entries(zh)
        .filter(([, value]) => value.includes("开局库"))
        .map(([key]) => key);
    expect(offenders).toEqual([]);
});

test("zh-TW never uses 開局庫 (repertoire vs. opening book collision)", () => {
    const offenders = Object.entries(tw)
        .filter(([, value]) => value.includes("開局庫"))
        .map(([key]) => key);
    expect(offenders).toEqual([]);
});

test("move classification labels follow Lichess zh-CN", () => {
    // "?!" is keyed Annotate.Dubious in En Croissant but is the inaccuracy label.
    expect(zh["Annotate.Dubious"]).toBe("失准");
    expect(zh["Annotate.Mistake"]).toBe("错着");
    expect(zh["Annotate.Blunder"]).toBe("败着");
});

test("repertoire and opening book use distinct zh-CN terms", () => {
    expect(zh["Files.FileType.Repertoire"]).toBe("开局体系");
    expect(zh["Settings.Repertoire"]).toBe("开局体系");
    expect(zh["Board.Opponent.EnableOpeningBook"]).toContain("开局书");
});
