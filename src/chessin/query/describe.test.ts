import { describe, expect, it } from "vitest";
import { describeChips, selectivity, suggestRemoval, type Translate } from "./describe";
import { parseQuery } from "./parse";

const ZH: Record<string, string> = {
    "Query.Describe.player": "棋手 {{value}}",
    "Query.Describe.white": "白方 {{value}}",
    "Query.Describe.black": "黑方 {{value}}",
    "Query.Describe.elo": "等级分 {{value}}",
    "Query.Describe.elo.Above": "等级分高于 {{value}}",
    "Query.Describe.elo.Below": "等级分低于 {{value}}",
    "Query.Describe.elo.Range": "等级分 {{lo}}–{{hi}}",
    "Query.Describe.year": "{{value}} 年",
    "Query.Describe.year.Above": "{{value}} 年之后",
    "Query.Describe.year.Below": "{{value}} 年之前",
    "Query.Describe.year.Range": "{{lo}}–{{hi}} 年",
    "Query.Describe.eco": "开局 {{value}}",
    "Query.Describe.event": "赛事 {{value}}",
    "Query.Describe.tc": "时限 {{value}}",
    "Query.Describe.Empty": "全部对局",
    "Query.Describe.Separator": "，",
    "Query.Result.WhiteWon": "白胜",
    "Query.Result.BlackWon": "黑胜",
    "Query.Result.Draw": "和棋",
};

const t: Translate = (key, options) => {
    const template = ZH[key] ?? key;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ""));
};

function chips(text: string) {
    return parseQuery(text).chips;
}

describe("describeChips", () => {
    it("reads as one sentence in chip order", () => {
        expect(
            describeChips(
                chips("white:Carlsen black:Nakamura elo>2600 year:2020..2024 result:胜"),
                t,
            ),
        ).toBe("白方 Carlsen，黑方 Nakamura，等级分高于 2600，2020–2024 年，白胜");
    });

    it("covers every operator and the unsupported keys", () => {
        expect(
            describeChips(chips("Carlsen elo:2500 elo<2000 year:2021 year>2015 year<2000"), t),
        ).toBe("棋手 Carlsen，等级分 2500，等级分低于 2000，2021 年，2015 年之后，2000 年之前");
        expect(
            describeChips(chips("elo:2400..2600 eco:B90 event:Tata tc:blitz result:和"), t),
        ).toBe("等级分 2400–2600，开局 B90，赛事 Tata，时限 blitz，和棋");
    });

    it("says 'all games' for no chips", () => {
        expect(describeChips([], t)).toBe("全部对局");
    });
});

describe("suggestRemoval", () => {
    it("drops the most selective chip first", () => {
        expect(suggestRemoval(chips("result:1-0 elo>2600 year:2020 white:Carlsen"))?.raw).toBe(
            "white:Carlsen",
        );
        expect(suggestRemoval(chips("result:1-0 elo>2600 year:2020"))?.raw).toBe("year:2020");
        expect(suggestRemoval(chips("result:1-0 elo>2600 year>2000"))?.raw).toBe("elo>2600");
        expect(suggestRemoval(chips("result:1-0 year>2000"))?.raw).toBe("year>2000");
        expect(suggestRemoval(chips("result:1-0"))?.raw).toBe("result:1-0");
    });

    it("prefers an unresolved player name, and ignores chips that are not applied", () => {
        const all = chips("white:Carlsen black:Nobody elo>2600");
        expect(suggestRemoval(all, [all[1]])?.raw).toBe("black:Nobody");
        expect(suggestRemoval(chips("eco:B90 event:Tata"))).toBeNull();
        expect(suggestRemoval([])).toBeNull();
        expect(selectivity(chips("eco:B90")[0])).toBe(0);
    });
});
