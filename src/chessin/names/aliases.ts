import { hasCjk, loadPinyin, pinyinIndex } from "@/chessin/commands/pinyin";
import { getKv, setKv } from "@/chessin/store/libraryStore";

/**
 * Player name aliases (S4-2, teardown W1-1).
 *
 * Database rows spell a player as "Ding, Liren", the FIDE API as
 * "Ding Liren", a Chinese user types 丁立人 or "dlr". This module turns a
 * spelling into a set of comparable variants (`nameVariants`) and scores a
 * query against candidate spellings (`matchPlayer`):
 *
 * - `normalizeName`: NFKD, diacritics stripped, lower case, "Last, First" ⇄
 *   "First Last" (the canonical form is "first last"), punctuation / hyphens
 *   → spaces, a leading FIDE title dropped;
 * - pinyin via `@/chessin/commands/pinyin` (`pinyin-pro`, lazily loaded):
 *   丁立人 → "ding liren", "liren ding", "dingliren", "dlr" …, order-free;
 * - a built-in alias table for well-known Chinese players plus user-added
 *   groups stored in kv `names.aliases` (`string[][]`, one group per person).
 *
 * Matching never links identities on its own: a score is a ranking hint for
 * the search list, and anything that binds an online account to a person
 * goes through the explicit confirmation in `@/chessin/prep` (W1).
 */

export const USER_ALIASES_KEY = "names.aliases";

/** Names of one person (any spelling, Chinese or Latin). */
export type AliasGroup = string[];

export type AliasEntry = {
    zh: string;
    /** FIDE spelling, "Last, First". */
    en: string;
    /** Further spellings seen in databases. */
    aliases?: string[];
};

/**
 * Built-in table (Chinese players a club player is likely to look up). The
 * FIDE spellings follow ratings.fide.com; no FIDE ids are stored so that a
 * wrong id can never bind the wrong person (W1: no silent identity matching).
 */
export const BUILTIN_ALIASES: readonly AliasEntry[] = [
    { zh: "丁立人", en: "Ding, Liren" },
    { zh: "韦奕", en: "Wei, Yi" },
    { zh: "王皓", en: "Wang, Hao" },
    { zh: "余泱漪", en: "Yu, Yangyi" },
    { zh: "卜祥志", en: "Bu, Xiangzhi" },
    { zh: "居文君", en: "Ju, Wenjun" },
    { zh: "侯逸凡", en: "Hou, Yifan" },
    { zh: "雷挺婕", en: "Lei, Tingjie" },
    { zh: "谭中怡", en: "Tan, Zhongyi" },
    { zh: "王玥", en: "Wang, Yue" },
    { zh: "倪华", en: "Ni, Hua" },
    { zh: "李超", en: "Li, Chao", aliases: ["Li, Chao b", "Li Chao B"] },
    { zh: "卢尚磊", en: "Lu, Shanglei" },
    { zh: "赵雪", en: "Zhao, Xue" },
    { zh: "朱锦尔", en: "Zhu, Jiner" },
    { zh: "沈阳", en: "Shen, Yang" },
    { zh: "许昱华", en: "Xu, Yuhua" },
    { zh: "诸宸", en: "Zhu, Chen" },
    { zh: "叶江川", en: "Ye, Jiangchuan" },
    { zh: "谢军", en: "Xie, Jun" },
];

const FIDE_TITLES = new Set(["gm", "im", "fm", "cm", "wgm", "wim", "wfm", "wcm"]);

/** Two-syllable Chinese surnames (so 欧阳 X → surname "ouyang"). */
const COMPOUND_SURNAMES = [
    "欧阳",
    "司马",
    "上官",
    "诸葛",
    "东方",
    "慕容",
    "公孙",
    "司徒",
    "夏侯",
    "皇甫",
    "尉迟",
    "令狐",
];

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]/;

export function stripDiacritics(s: string): string {
    return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Canonical spelling for comparisons: lower case, no diacritics, "first last"
 * order, single spaces, no punctuation. Chinese names keep their characters
 * (inner spaces removed). Empty for blank input.
 */
export function normalizeName(raw: string): string {
    if (!raw) return "";
    let s = stripDiacritics(raw).toLowerCase();
    // Keep the comma (name order), turn the rest of the punctuation into spaces.
    s = s.replace(/[.'’`"_()[\]{}/\\|;:!?*+=<>~^#@%&$-]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (!s) return "";
    // A leading FIDE title ("GM Ding, Liren").
    const firstSpace = s.indexOf(" ");
    if (firstSpace !== -1 && FIDE_TITLES.has(s.slice(0, firstSpace))) {
        s = s.slice(firstSpace + 1).trim();
    }
    const comma = s.indexOf(",");
    if (comma !== -1) {
        const last = s.slice(0, comma).trim();
        const first = s
            .slice(comma + 1)
            .replace(/,/g, " ")
            .trim();
        s = `${first} ${last}`.trim();
    }
    s = s.replace(/\s+/g, " ").trim();
    if (CJK_RUN.test(s)) {
        // "丁 立人" → "丁立人"
        s = s.replace(/([㐀-䶿一-鿿豈-﫿])\s+(?=[㐀-䶿一-鿿豈-﫿])/g, "$1");
    }
    return s;
}

/** Order-free key: the tokens of a normalized name, sorted. */
export function tokenKey(normalized: string): string {
    return normalized.split(" ").filter(Boolean).sort().join(" ");
}

function compact(normalized: string): string {
    return normalized.replace(/\s+/g, "");
}

function isLatinOnly(s: string): boolean {
    return /^[a-z]+$/.test(s);
}

function initialsOf(tokens: string[]): string {
    return tokens.map((t) => t[0] ?? "").join("");
}

// ---------------------------------------------------------------------------
// Pinyin

type PinyinParts = { syllables: string[]; surname: string[]; given: string[] };

function pinyinParts(zhName: string): PinyinParts | null {
    const name = normalizeName(zhName);
    if (!name || !hasCjk(name)) return null;
    const index = pinyinIndex(name);
    if (!index.full) return null;
    const parts = index.full.split(" ").filter(Boolean);
    // `full` is "<spaced syllables> <joined>": drop the joined tail.
    const syllables = parts.length > 1 ? parts.slice(0, -1) : parts;
    if (syllables.length === 0) return null;
    const surnameSyllables = COMPOUND_SURNAMES.some((c) => name.startsWith(c)) ? 2 : 1;
    return {
        syllables,
        surname: syllables.slice(0, surnameSyllables),
        given: syllables.slice(surnameSyllables),
    };
}

/**
 * Pinyin spellings of a Chinese name (empty until `pinyin-pro` is loaded —
 * call `ensureNamesReady()` first): surname-first and given-first, joined and
 * spaced, plus the bare syllables. Initials are kept apart
 * (`pinyinInitials`) because they are a weaker kind of match.
 */
export function pinyinForms(zhName: string): string[] {
    const parts = pinyinParts(zhName);
    if (!parts) return [];
    const surname = parts.surname.join("");
    const given = parts.given.join("");
    const out = new Set<string>();
    out.add(parts.syllables.join(" "));
    out.add(parts.syllables.join(""));
    if (given) {
        out.add(`${surname} ${given}`);
        out.add(`${given} ${surname}`);
        out.add(`${surname}${given}`);
        out.add(`${given}${surname}`);
    }
    return Array.from(out).filter(Boolean);
}

/** "dlr" / "lrd" for 丁立人 (surname-first and given-first); empty without pinyin. */
export function pinyinInitials(zhName: string): string[] {
    const parts = pinyinParts(zhName);
    if (!parts || parts.syllables.length < 2) return [];
    const surname = initialsOf(parts.surname);
    const given = initialsOf(parts.given);
    return Array.from(new Set([`${surname}${given}`, `${given}${surname}`]));
}

/** Loads `pinyin-pro` so Chinese names get their pinyin variants. */
export function ensureNamesReady(): Promise<void> {
    return loadPinyin().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Alias groups

let userGroups: AliasGroup[] = [];

export function builtinAliasGroups(): AliasGroup[] {
    return BUILTIN_ALIASES.map((e) => [e.zh, e.en, ...(e.aliases ?? [])]);
}

export function getUserAliases(): AliasGroup[] {
    return userGroups;
}

/** Replaces the in-memory user groups (tests; `loadUserAliases` for the stored ones). */
export function setUserAliases(groups: AliasGroup[]): void {
    userGroups = groups.map((g) => g.filter((n) => typeof n === "string" && n.trim()));
}

export function allAliasGroups(): AliasGroup[] {
    return [...builtinAliasGroups(), ...userGroups];
}

/** `string[][]` from kv; anything else is ignored. */
export function parseAliasGroups(raw: string | null | undefined): AliasGroup[] {
    if (!raw) return [];
    try {
        const json: unknown = JSON.parse(raw);
        if (!Array.isArray(json)) return [];
        const groups: AliasGroup[] = [];
        for (const item of json) {
            if (!Array.isArray(item)) continue;
            const names = item.filter((n): n is string => typeof n === "string" && n.trim() !== "");
            if (names.length >= 2) groups.push(names);
        }
        return groups;
    } catch {
        return [];
    }
}

export async function loadUserAliases(): Promise<AliasGroup[]> {
    let raw: string | null = null;
    try {
        raw = await getKv(USER_ALIASES_KEY);
    } catch {
        raw = null;
    }
    userGroups = parseAliasGroups(raw);
    return userGroups;
}

export async function saveUserAliases(groups: AliasGroup[]): Promise<void> {
    setUserAliases(groups);
    await setKv(USER_ALIASES_KEY, JSON.stringify(userGroups));
}

/** Records that `a` and `b` are the same person (groups touching either are merged). */
export async function addUserAlias(a: string, b: string): Promise<AliasGroup[]> {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (!na || !nb) return userGroups;
    const touches = (g: AliasGroup) =>
        g.some((n) => normalizeName(n) === na || normalizeName(n) === nb);
    const merged: string[] = [];
    const rest: AliasGroup[] = [];
    for (const g of userGroups) {
        if (touches(g)) merged.push(...g);
        else rest.push(g);
    }
    const names = new Set<string>();
    const out: AliasGroup = [];
    for (const n of [...merged, a.trim(), b.trim()]) {
        const key = normalizeName(n);
        if (!key || names.has(key)) continue;
        names.add(key);
        out.push(n);
    }
    const groups = [...rest.filter((g) => g.length >= 2), out];
    await saveUserAliases(groups);
    return userGroups;
}

type GroupForms = { exact: Set<string>; keys: Set<string>; compact: Set<string> };

function groupForms(group: AliasGroup): GroupForms {
    const exact = new Set<string>();
    const keys = new Set<string>();
    const compacts = new Set<string>();
    const add = (s: string) => {
        const n = normalizeName(s);
        if (!n) return;
        exact.add(n);
        keys.add(tokenKey(n));
        compacts.add(compact(n));
    };
    for (const name of group) {
        add(name);
        for (const form of pinyinForms(name)) add(form);
    }
    return { exact, keys, compact: compacts };
}

function groupContains(forms: GroupForms, normalized: string): boolean {
    return (
        forms.exact.has(normalized) ||
        forms.keys.has(tokenKey(normalized)) ||
        forms.compact.has(compact(normalized))
    );
}

/** The Chinese spelling the alias table knows for `name`, if any. */
export function chineseNameFor(
    name: string,
    groups: AliasGroup[] = allAliasGroups(),
): string | null {
    const n = normalizeName(name);
    if (!n) return null;
    if (hasCjk(n)) return n;
    for (const group of groups) {
        if (!groupContains(groupForms(group), n)) continue;
        const zh = group.find((g) => hasCjk(g));
        if (zh) return normalizeName(zh);
    }
    return null;
}

/** "Ding, Liren（丁立人）" when the table knows the Chinese name, else the name itself. */
export function displayName(name: string, groups: AliasGroup[] = allAliasGroups()): string {
    const zh = chineseNameFor(name, groups);
    if (!zh || zh === normalizeName(name)) return name;
    return `${name}（${zh}）`;
}

/**
 * Every comparable spelling of `raw`: the normalized form, its alias group
 * (built-in + user), pinyin forms of the Chinese spellings, and the
 * "last first" order of Latin names.
 */
export function nameVariants(raw: string, groups: AliasGroup[] = allAliasGroups()): string[] {
    const base = normalizeName(raw);
    if (!base) return [];
    const out = new Set<string>([base]);
    const add = (s: string) => {
        const n = normalizeName(s);
        if (n) out.add(n);
    };
    for (const group of groups) {
        if (groupContains(groupForms(group), base)) for (const name of group) add(name);
    }
    for (const name of Array.from(out)) {
        if (hasCjk(name)) for (const form of pinyinForms(name)) add(form);
    }
    for (const name of Array.from(out)) {
        const tokens = name.split(" ");
        if (tokens.length === 2 && !hasCjk(name)) add(`${tokens[1]} ${tokens[0]}`);
    }
    return Array.from(out);
}

// ---------------------------------------------------------------------------
// Matching

export type MatchReason = "exact" | "alias" | "order" | "initials" | "token" | "substring";

export type PlayerMatch = {
    name: string;
    /** 1 same person by spelling/alias; 0.7 every query token present; 0.6 initials; 0.5 substring. */
    score: number;
    reason: MatchReason;
};

export const MATCH_EXACT = 1;
export const MATCH_TOKEN = 0.7;
export const MATCH_INITIALS = 0.6;
export const MATCH_SUBSTRING = 0.5;

/** Scores one candidate spelling against a query; `null` when unrelated. */
export function scoreName(
    query: string,
    candidate: string,
    groups: AliasGroup[] = allAliasGroups(),
): PlayerMatch | null {
    const q = normalizeName(query);
    const c = normalizeName(candidate);
    if (!q || !c) return null;
    if (q === c) return { name: candidate, score: MATCH_EXACT, reason: "exact" };
    const qv = nameVariants(query, groups);
    const cv = nameVariants(candidate, groups);
    const qExact = new Set(qv);
    const qKeys = new Set(qv.map(tokenKey));
    const qCompact = new Set(qv.map(compact));
    for (const v of cv) {
        if (qExact.has(v)) return { name: candidate, score: MATCH_EXACT, reason: "alias" };
    }
    for (const v of cv) {
        if (qKeys.has(tokenKey(v)) || qCompact.has(compact(v))) {
            return { name: candidate, score: MATCH_EXACT, reason: "order" };
        }
    }
    const qTokens = q.split(" ").filter(Boolean);
    if (qTokens.length === 1 && isLatinOnly(q) && q.length >= 2 && q.length <= 4) {
        for (const v of cv) {
            if (hasCjk(v)) {
                if (pinyinInitials(v).includes(q)) {
                    return { name: candidate, score: MATCH_INITIALS, reason: "initials" };
                }
                continue;
            }
            const tokens = v.split(" ").filter(Boolean);
            if (tokens.length < 2) continue;
            const forward = initialsOf(tokens);
            const backward = initialsOf([...tokens].reverse());
            if (q === forward || q === backward) {
                return { name: candidate, score: MATCH_INITIALS, reason: "initials" };
            }
        }
    }
    if (qTokens.length > 0 && qTokens.every((t) => t.length >= 2)) {
        for (const v of cv) {
            const tokens = new Set(v.split(" ").filter(Boolean));
            if (qTokens.every((t) => tokens.has(t))) {
                return { name: candidate, score: MATCH_TOKEN, reason: "token" };
            }
        }
    }
    const needle = compact(q);
    if (needle.length >= 3) {
        for (const v of cv) {
            if (compact(v).includes(needle)) {
                return { name: candidate, score: MATCH_SUBSTRING, reason: "substring" };
            }
        }
    }
    return null;
}

/**
 * Candidates that could be the player named by `query`, best first (ties keep
 * the input order). Empty for a blank query. `minScore` defaults to
 * `MATCH_SUBSTRING`.
 */
export function matchPlayer(
    query: string,
    candidates: readonly string[],
    options: { groups?: AliasGroup[]; minScore?: number } = {},
): PlayerMatch[] {
    const groups = options.groups ?? allAliasGroups();
    const minScore = options.minScore ?? MATCH_SUBSTRING;
    const scored: { match: PlayerMatch; index: number }[] = [];
    const seen = new Set<string>();
    candidates.forEach((candidate, index) => {
        const key = normalizeName(candidate);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const match = scoreName(query, candidate, groups);
        if (match && match.score >= minScore) scored.push({ match, index });
    });
    return scored
        .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
        .map((s) => s.match);
}

/** True when the two spellings name the same person (score 1). */
export function sameEntity(a: string, b: string, groups: AliasGroup[] = allAliasGroups()): boolean {
    const match = scoreName(a, b, groups);
    return match !== null && match.score >= MATCH_EXACT;
}
