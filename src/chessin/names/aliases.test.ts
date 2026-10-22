import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasCjk } from "@/chessin/commands/pinyin";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import {
    addUserAlias,
    BUILTIN_ALIASES,
    chineseNameFor,
    displayName,
    ensureNamesReady,
    getUserAliases,
    loadUserAliases,
    MATCH_EXACT,
    MATCH_INITIALS,
    MATCH_SUBSTRING,
    MATCH_TOKEN,
    matchPlayer,
    nameVariants,
    normalizeName,
    parseAliasGroups,
    pinyinForms,
    pinyinInitials,
    sameEntity,
    setUserAliases,
    tokenKey,
    USER_ALIASES_KEY,
} from "./aliases";

beforeAll(async () => {
    await ensureNamesReady();
});

beforeEach(() => {
    __setLibraryBackendForTests(createMemoryBackend());
    setUserAliases([]);
});

describe("normalizeName", () => {
    it("puts 'Last, First' and 'First Last' on the same canonical form", () => {
        expect(normalizeName("Ding, Liren")).toBe("liren ding");
        expect(normalizeName("Liren Ding")).toBe("liren ding");
        expect(normalizeName("  ding ,  liren ")).toBe("liren ding");
        expect(tokenKey(normalizeName("Ding, Liren"))).toBe("ding liren");
    });

    it("strips diacritics, full-width forms, punctuation and a leading FIDE title", () => {
        expect(normalizeName("Müller, Jörg")).toBe("jorg muller");
        expect(normalizeName("Ｄｉｎｇ Ｌｉｒｅｎ")).toBe("ding liren");
        expect(normalizeName("Vachier-Lagrave, Maxime")).toBe("maxime vachier lagrave");
        expect(normalizeName("GM Ding, Liren")).toBe("liren ding");
        expect(normalizeName("J. Smith")).toBe("j smith");
        expect(normalizeName("")).toBe("");
        expect(normalizeName("   ")).toBe("");
    });

    it("keeps Chinese characters and removes the spaces between them", () => {
        expect(normalizeName("丁立人")).toBe("丁立人");
        expect(normalizeName("丁 立人")).toBe("丁立人");
        expect(hasCjk(normalizeName("丁立人"))).toBe(true);
    });
});

describe("pinyin", () => {
    it("spells a Chinese name in both orders, joined, spaced and by initials", () => {
        const forms = pinyinForms("丁立人");
        expect(forms).toEqual(
            expect.arrayContaining([
                "ding li ren",
                "dingliren",
                "ding liren",
                "liren ding",
                "lirending",
            ]),
        );
        expect(forms).not.toContain("dlr");
        expect(pinyinInitials("丁立人")).toEqual(["dlr", "lrd"]);
        expect(pinyinForms("Ding, Liren")).toEqual([]);
        expect(pinyinInitials("Ding, Liren")).toEqual([]);
    });

    it("treats a compound surname as one unit", () => {
        expect(pinyinForms("欧阳修")).toEqual(expect.arrayContaining(["ouyang xiu", "xiu ouyang"]));
    });
});

describe("nameVariants", () => {
    it("joins the alias table and the pinyin forms for a Chinese name", () => {
        const variants = nameVariants("丁立人");
        expect(variants).toContain("丁立人");
        expect(variants).toContain("liren ding");
        expect(variants).toContain("dingliren");
        expect(variants).not.toContain("dlr");
    });

    it("finds the Chinese spelling and the swapped order for a Latin name", () => {
        const variants = nameVariants("Ding, Liren");
        expect(variants).toContain("liren ding");
        expect(variants).toContain("ding liren");
        expect(variants).toContain("丁立人");
        expect(nameVariants("")).toEqual([]);
    });
});

describe("matchPlayer", () => {
    const names = ["Ding, Liren", "Ding, Yixin", "Carlsen, Magnus", "Wei, Yi"];

    it("matches a Chinese query against the database spelling through the alias table", () => {
        const matches = matchPlayer("丁立人", names);
        expect(matches[0]).toEqual({ name: "Ding, Liren", score: MATCH_EXACT, reason: "alias" });
        expect(matches.map((m) => m.name)).not.toContain("Carlsen, Magnus");
    });

    it("is order-free for Latin and pinyin spellings", () => {
        expect(matchPlayer("liren ding", names)[0]).toMatchObject({
            name: "Ding, Liren",
            score: MATCH_EXACT,
        });
        expect(matchPlayer("dingliren", names)[0]).toMatchObject({
            name: "Ding, Liren",
            score: MATCH_EXACT,
        });
        expect(matchPlayer("ding liren", ["丁立人"])[0]).toMatchObject({
            name: "丁立人",
            score: MATCH_EXACT,
        });
        expect(sameEntity("Wei Yi", "韦奕")).toBe(true);
        expect(sameEntity("Wei Yi", "Ding, Liren")).toBe(false);
    });

    it("ranks pinyin initials below a full match", () => {
        expect(matchPlayer("dlr", names)).toEqual([
            { name: "Ding, Liren", score: MATCH_INITIALS, reason: "initials" },
        ]);
        expect(matchPlayer("dlr", ["丁立人"])).toEqual([
            { name: "丁立人", score: MATCH_INITIALS, reason: "initials" },
        ]);
        expect(matchPlayer("mc", names)).toEqual([
            { name: "Carlsen, Magnus", score: MATCH_INITIALS, reason: "initials" },
        ]);
    });

    it("ranks a surname-only query as a token match for every player with that surname", () => {
        const matches = matchPlayer("Ding", names);
        expect(matches.map((m) => m.name)).toEqual(["Ding, Liren", "Ding, Yixin"]);
        expect(matches.every((m) => m.score === MATCH_TOKEN && m.reason === "token")).toBe(true);
    });

    it("falls back to a substring match and drops unrelated candidates", () => {
        expect(matchPlayer("carls", names)).toEqual([
            { name: "Carlsen, Magnus", score: MATCH_SUBSTRING, reason: "substring" },
        ]);
        expect(matchPlayer("kasparov", names)).toEqual([]);
        expect(matchPlayer("", names)).toEqual([]);
        expect(matchPlayer("carls", names, { minScore: MATCH_TOKEN })).toEqual([]);
    });

    it("de-duplicates candidates that normalize to the same spelling", () => {
        const matches = matchPlayer("Ding, Liren", ["Ding, Liren", "Liren Ding", "DING, LIREN"]);
        expect(matches).toHaveLength(1);
        expect(matches[0].reason).toBe("exact");
    });
});

describe("alias table", () => {
    it("links every built-in entry's Chinese and FIDE spellings", () => {
        for (const entry of BUILTIN_ALIASES) {
            expect(hasCjk(entry.zh)).toBe(true);
            expect(entry.en).toMatch(/^[A-Z][a-z]+, [A-Z][a-z]+$/);
            const match = matchPlayer(entry.zh, [entry.en]);
            expect(match[0], `${entry.zh} ↔ ${entry.en}`).toMatchObject({ score: MATCH_EXACT });
            expect(chineseNameFor(entry.en)).toBe(entry.zh);
        }
    });

    it("shows the Chinese name next to a Latin spelling it knows", () => {
        expect(displayName("Hou, Yifan")).toBe("Hou, Yifan（侯逸凡）");
        expect(displayName("Carlsen, Magnus")).toBe("Carlsen, Magnus");
        expect(displayName("侯逸凡")).toBe("侯逸凡");
        expect(chineseNameFor("Carlsen, Magnus")).toBeNull();
    });
});

describe("user aliases", () => {
    it("parses only string groups of at least two names", () => {
        expect(parseAliasGroups(null)).toEqual([]);
        expect(parseAliasGroups("not json")).toEqual([]);
        expect(parseAliasGroups('{"a":1}')).toEqual([]);
        expect(parseAliasGroups('[["Xiao Ming", "小明"], ["solo"], [1, 2], "x"]')).toEqual([
            ["Xiao Ming", "小明"],
        ]);
    });

    it("lets a user-added group match like a built-in one", () => {
        // Pinyin already links 小明 ↔ "Xiao Ming"; a nickname needs the user table.
        expect(matchPlayer("小明", ["Xiao Ming"])[0]).toMatchObject({ score: MATCH_EXACT });
        expect(matchPlayer("小明", ["xm2024", "Ding, Liren"])).toEqual([]);
        setUserAliases([["xm2024", "小明"]]);
        expect(matchPlayer("小明", ["xm2024", "Ding, Liren"])).toEqual([
            { name: "xm2024", score: MATCH_EXACT, reason: "alias" },
        ]);
        expect(chineseNameFor("xm2024")).toBe("小明");
    });

    it("persists added aliases in kv names.aliases and merges touching groups", async () => {
        await addUserAlias("Xiao Ming", "小明");
        await addUserAlias("小明", "xm2024");
        expect(getUserAliases()).toEqual([["Xiao Ming", "小明", "xm2024"]]);
        expect(JSON.parse((await getKv(USER_ALIASES_KEY)) ?? "[]")).toEqual([
            ["Xiao Ming", "小明", "xm2024"],
        ]);
        setUserAliases([]);
        expect(matchPlayer("xm2024", ["Xiao Ming"])).toEqual([]);
        await loadUserAliases();
        expect(matchPlayer("xm2024", ["Xiao Ming"])[0]).toMatchObject({ score: MATCH_EXACT });
        // Blank input is ignored.
        await addUserAlias("", "小明");
        expect(getUserAliases()).toHaveLength(1);
    });
});
