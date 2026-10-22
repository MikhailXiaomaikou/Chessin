import { describe, expect, it } from "vitest";
import {
    type Chip,
    formatChip,
    isChip,
    isParseError,
    normalizeInput,
    normalizeResult,
    parseQuery,
    parseToken,
    rangeOf,
    tokenize,
} from "./parse";

function chip(key: Chip["key"], op: Chip["op"], value: string, raw: string): Chip {
    return { key, op, value, raw };
}

describe("tokenize", () => {
    it("splits on whitespace and keeps quoted values together", () => {
        expect(tokenize("white:Carlsen  elo>2600\tyear:2020..2024")).toEqual([
            "white:Carlsen",
            "elo>2600",
            "year:2020..2024",
        ]);
        expect(tokenize('player:"Magnus Carlsen" "Hikaru Nakamura" x')).toEqual([
            'player:"Magnus Carlsen"',
            '"Hikaru Nakamura"',
            "x",
        ]);
    });

    it("runs an unterminated quote to the end and maps full-width punctuation", () => {
        expect(tokenize('event:"Tata Steel 2024')).toEqual(['event:"Tata Steel 2024']);
        expect(normalizeInput("棋手：卡尔森　等级分＞2600 “a b”")).toBe(
            '棋手:卡尔森 等级分>2600 "a b"',
        );
        expect(tokenize("棋手：卡尔森　等级分＞2600")).toEqual(["棋手:卡尔森", "等级分>2600"]);
    });
});

describe("parseToken — English keys", () => {
    it("parses player / white / black name chips", () => {
        expect(parseToken("player:Carlsen")).toEqual(
            chip("player", ":", "Carlsen", "player:Carlsen"),
        );
        expect(parseToken("white:Carlsen")).toEqual(chip("white", ":", "Carlsen", "white:Carlsen"));
        expect(parseToken("black:Nakamura")).toEqual(
            chip("black", ":", "Nakamura", "black:Nakamura"),
        );
    });

    it("strips quotes from values with spaces", () => {
        expect(parseToken('player:"Magnus Carlsen"')).toEqual(
            chip("player", ":", "Magnus Carlsen", 'player:"Magnus Carlsen"'),
        );
        expect(parseToken('event:"Tata Steel"')).toEqual(
            chip("event", ":", "Tata Steel", 'event:"Tata Steel"'),
        );
    });

    it("treats bare words as a player name search (key text)", () => {
        expect(parseToken("Carlsen")).toEqual(chip("text", ":", "Carlsen", "Carlsen"));
        expect(parseToken('"Magnus Carlsen"')).toEqual(
            chip("text", ":", "Magnus Carlsen", '"Magnus Carlsen"'),
        );
        // A fully quoted token is a name even if it contains a colon.
        expect(parseToken('"a:b"')).toEqual(chip("text", ":", "a:b", '"a:b"'));
    });

    it("parses > and < on elo and year as strict bounds", () => {
        expect(parseToken("elo>2600")).toEqual(chip("elo", ">", "2600", "elo>2600"));
        expect(parseToken("elo<2000")).toEqual(chip("elo", "<", "2000", "elo<2000"));
        expect(parseToken("year>2015")).toEqual(chip("year", ">", "2015", "year>2015"));
        expect(parseToken("year<2000")).toEqual(chip("year", "<", "2000", "year<2000"));
    });

    it("stores >= and <= as the equivalent strict bound", () => {
        expect(parseToken("elo>=2600")).toEqual(chip("elo", ">", "2599", "elo>=2600"));
        expect(parseToken("year<=2020")).toEqual(chip("year", "<", "2021", "year<=2020"));
    });

    it("accepts the comparison after the colon (elo:>2600) and spaces around it", () => {
        expect(parseToken("elo:>2600")).toEqual(chip("elo", ">", "2600", "elo:>2600"));
        expect(parseToken("elo: 2500")).toEqual(chip("elo", ":", "2500", "elo: 2500"));
    });

    it("parses a..b ranges (also a-b, a–b, a~b) and swaps a reversed range", () => {
        expect(parseToken("year:2020..2024")).toEqual(
            chip("year", "..", "2020..2024", "year:2020..2024"),
        );
        expect(parseToken("elo:2400-2600")).toEqual(
            chip("elo", "..", "2400..2600", "elo:2400-2600"),
        );
        expect(parseToken("elo:2400–2600")).toEqual(
            chip("elo", "..", "2400..2600", "elo:2400–2600"),
        );
        expect(parseToken("year:2024..2020")).toEqual(
            chip("year", "..", "2020..2024", "year:2024..2020"),
        );
        expect(rangeOf(chip("elo", "..", "2400..2600", ""))).toEqual([2400, 2600]);
        expect(rangeOf(chip("elo", ">", "2400", ""))).toBeNull();
    });

    it("canonicalises exact numbers", () => {
        expect(parseToken("elo:02400")).toEqual(chip("elo", ":", "2400", "elo:02400"));
        expect(parseToken("year:2021")).toEqual(chip("year", ":", "2021", "year:2021"));
    });

    it("normalises result values", () => {
        expect(parseToken("result:whitewon")).toEqual(
            chip("result", ":", "1-0", "result:whitewon"),
        );
        expect(parseToken("result:blackwon")).toEqual(
            chip("result", ":", "0-1", "result:blackwon"),
        );
        expect(parseToken("result:draw")).toEqual(chip("result", ":", "1/2-1/2", "result:draw"));
        expect(parseToken("result:1-0")).toEqual(chip("result", ":", "1-0", "result:1-0"));
        expect(parseToken("result:½-½")).toEqual(chip("result", ":", "1/2-1/2", "result:½-½"));
        expect(normalizeResult(" White Wins ")).toBe("1-0");
        expect(normalizeResult("nope")).toBeNull();
    });

    it("is case-insensitive on keys and accepts short aliases", () => {
        expect(parseToken("ELO>2600")).toEqual(chip("elo", ">", "2600", "ELO>2600"));
        expect(parseToken("w:Carlsen")).toEqual(chip("white", ":", "Carlsen", "w:Carlsen"));
        expect(parseToken("b:Nakamura")).toEqual(chip("black", ":", "Nakamura", "b:Nakamura"));
        expect(parseToken("rating>2700")).toEqual(chip("elo", ">", "2700", "rating>2700"));
        expect(parseToken("tournament:Olympiad")).toEqual(
            chip("event", ":", "Olympiad", "tournament:Olympiad"),
        );
    });
});

describe("parseToken — Chinese aliases", () => {
    it("maps 棋手 白方 黑方 to player keys", () => {
        expect(parseToken("棋手:卡尔森")).toEqual(chip("player", ":", "卡尔森", "棋手:卡尔森"));
        expect(parseToken("白方:Carlsen")).toEqual(chip("white", ":", "Carlsen", "白方:Carlsen"));
        expect(parseToken("黑方:Nakamura")).toEqual(
            chip("black", ":", "Nakamura", "黑方:Nakamura"),
        );
    });

    it("maps 等级分 年份 with comparisons and ranges", () => {
        expect(parseToken("等级分>2600")).toEqual(chip("elo", ">", "2600", "等级分>2600"));
        expect(parseToken("等级分：2400..2600")).toEqual(
            chip("elo", "..", "2400..2600", "等级分:2400..2600"),
        );
        expect(parseToken("年份:2020..2024")).toEqual(
            chip("year", "..", "2020..2024", "年份:2020..2024"),
        );
        expect(parseToken("年份<2000")).toEqual(chip("year", "<", "2000", "年份<2000"));
    });

    it("maps 结果 values 胜 / 负 / 和", () => {
        expect(parseToken("结果:胜")).toEqual(chip("result", ":", "1-0", "结果:胜"));
        expect(parseToken("结果:负")).toEqual(chip("result", ":", "0-1", "结果:负"));
        expect(parseToken("结果:和")).toEqual(chip("result", ":", "1/2-1/2", "结果:和"));
        expect(parseToken("result:白胜")).toEqual(chip("result", ":", "1-0", "result:白胜"));
        expect(parseToken("result:和棋")).toEqual(chip("result", ":", "1/2-1/2", "result:和棋"));
    });

    it("maps 开局 赛事 时限 (unsupported keys still parse)", () => {
        expect(parseToken("开局:B90")).toEqual(chip("eco", ":", "B90", "开局:B90"));
        expect(parseToken("赛事:Tata")).toEqual(chip("event", ":", "Tata", "赛事:Tata"));
        expect(parseToken("时限:classical")).toEqual(
            chip("tc", ":", "classical", "时限:classical"),
        );
    });

    it("accepts a full-width colon on a Chinese key", () => {
        expect(parseToken("棋手：卡尔森")).toEqual(chip("player", ":", "卡尔森", "棋手:卡尔森"));
    });
});

describe("parseToken — errors", () => {
    it("reports an unknown key", () => {
        expect(parseToken("foo:bar")).toEqual({ raw: "foo:bar", reason: "unknown_key" });
    });

    it("reports a missing value", () => {
        expect(parseToken("player:")).toEqual({ raw: "player:", reason: "empty_value" });
        expect(parseToken('white:""')).toEqual({ raw: 'white:""', reason: "empty_value" });
        expect(parseToken("elo>")).toEqual({ raw: "elo>", reason: "empty_value" });
    });

    it("reports a non-numeric elo / year", () => {
        expect(parseToken("elo>high")).toEqual({ raw: "elo>high", reason: "bad_number" });
        expect(parseToken("year:abc")).toEqual({ raw: "year:abc", reason: "bad_number" });
        expect(parseToken("elo:25.5")).toEqual({ raw: "elo:25.5", reason: "bad_number" });
    });

    it("reports a malformed range", () => {
        expect(parseToken("elo:2400..")).toEqual({ raw: "elo:2400..", reason: "bad_range" });
        expect(parseToken("year:a..b")).toEqual({ raw: "year:a..b", reason: "bad_range" });
    });

    it("reports an unknown result", () => {
        expect(parseToken("result:maybe")).toEqual({ raw: "result:maybe", reason: "bad_result" });
    });

    it("rejects comparisons on text keys and results", () => {
        expect(parseToken("player>Carlsen")).toEqual({ raw: "player>Carlsen", reason: "bad_op" });
        expect(parseToken("result<1-0")).toEqual({ raw: "result<1-0", reason: "bad_op" });
        expect(isParseError(parseToken("player>Carlsen"))).toBe(true);
        expect(isParseError(parseToken("player:Carlsen"))).toBe(false);
    });
});

describe("parseQuery", () => {
    it("parses a mixed English / Chinese query in order and collects errors separately", () => {
        const { chips, errors } = parseQuery(
            'white:Carlsen 黑方:"Hikaru Nakamura" elo>2600 年份:2020..2024 结果:胜 foo:bar eco:B90',
        );
        expect(chips.map((c) => [c.key, c.op, c.value])).toEqual([
            ["white", ":", "Carlsen"],
            ["black", ":", "Hikaru Nakamura"],
            ["elo", ">", "2600"],
            ["year", "..", "2020..2024"],
            ["result", ":", "1-0"],
            ["eco", ":", "B90"],
        ]);
        expect(errors).toEqual([{ raw: "foo:bar", reason: "unknown_key" }]);
    });

    it("returns nothing for blank input", () => {
        expect(parseQuery("   ")).toEqual({ chips: [], errors: [] });
    });
});

describe("formatChip / isChip", () => {
    it("prints the canonical English spelling", () => {
        expect(formatChip(chip("white", ":", "Carlsen", "白方:Carlsen"))).toBe("white:Carlsen");
        expect(formatChip(chip("player", ":", "Magnus Carlsen", ""))).toBe(
            'player:"Magnus Carlsen"',
        );
        expect(formatChip(chip("elo", ">", "2600", ""))).toBe("elo>2600");
        expect(formatChip(chip("year", "..", "2020..2024", ""))).toBe("year:2020..2024");
        expect(formatChip(chip("text", ":", "Carlsen", ""))).toBe("Carlsen");
    });

    it("validates chips read back from storage", () => {
        expect(isChip(chip("elo", ">", "2600", "elo>2600"))).toBe(true);
        expect(isChip({ key: "elo", op: ">=", value: "2600", raw: "" })).toBe(false);
        expect(isChip({ key: "nope", op: ":", value: "x", raw: "" })).toBe(false);
        expect(isChip(null)).toBe(false);
        expect(isChip("elo>2600")).toBe(false);
    });
});
