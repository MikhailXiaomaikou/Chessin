/**
 * Chip query grammar (S3-3).
 *
 * A free-text query is a list of whitespace-separated tokens; each token
 * becomes one chip. Values with spaces are quoted: `player:"Magnus Carlsen"`.
 *
 *   key:value        exact / name search           player:Carlsen  结果:胜
 *   key>n  key<n     strictly above / below        elo>2600  年份<2000
 *   key>=n key<=n    inclusive (stored as > / <)   elo>=2600 → elo>2599
 *   key:a..b         inclusive range (also a-b)    year:2020..2024  等级分:2400..2600
 *   bare word        player name search            Carlsen  "Magnus Carlsen"
 *
 * Keys (English / Chinese): player 棋手, white 白方, black 黑方, elo 等级分,
 * year 年份, result 结果, eco 开局, event 赛事, tc 时限. Result values:
 * 胜 / 负 / 和 ⇄ whitewon / blackwon / draw (also 1-0, 0-1, 1/2-1/2, ½-½).
 * Full-width punctuation (：＞＜“”) is accepted. Unknown keys, non-numeric
 * values for elo/year, unknown results and a comparison on a text key are
 * reported as `ParseError`s rather than silently becoming name searches.
 */

export type ChipKey =
    | "player"
    | "white"
    | "black"
    | "elo"
    | "year"
    | "result"
    | "eco"
    | "event"
    | "tc"
    | "text";

export type ChipOp = ":" | ">" | "<" | "..";

export type Chip = {
    key: ChipKey;
    op: ChipOp;
    /** Normalised value: trimmed, quotes stripped, numbers canonical, results as PGN outcome. */
    value: string;
    /** The token as typed (for display and for re-editing). */
    raw: string;
};

export type ParseErrorReason =
    | "unknown_key"
    | "empty_value"
    | "bad_number"
    | "bad_range"
    | "bad_result"
    | "bad_op";

export type ParseError = { raw: string; reason: ParseErrorReason };

export type ParseResult = { chips: Chip[]; errors: ParseError[] };

/** Keys the user can pick from the completion dropdown (bare words are `text`). */
export const CHIP_KEYS: readonly Exclude<ChipKey, "text">[] = [
    "player",
    "white",
    "black",
    "elo",
    "year",
    "result",
    "eco",
    "event",
    "tc",
];

export const NUMERIC_KEYS: ReadonlySet<ChipKey> = new Set(["elo", "year"]);

/** Keys `getGames` cannot filter on today; their chips are shown dimmed and never sent. */
export const UNSUPPORTED_KEYS: ReadonlySet<ChipKey> = new Set(["eco", "event", "tc"]);

export function isSupportedKey(key: ChipKey): boolean {
    return !UNSUPPORTED_KEYS.has(key);
}

/** Chinese alias shown next to the English key in the completion dropdown. */
export const KEY_ZH: Record<Exclude<ChipKey, "text">, string> = {
    player: "棋手",
    white: "白方",
    black: "黑方",
    elo: "等级分",
    year: "年份",
    result: "结果",
    eco: "开局",
    event: "赛事",
    tc: "时限",
};

export const KEY_ALIASES: Readonly<Record<string, ChipKey>> = {
    player: "player",
    p: "player",
    棋手: "player",
    选手: "player",
    white: "white",
    w: "white",
    白方: "white",
    白: "white",
    black: "black",
    b: "black",
    黑方: "black",
    黑: "black",
    elo: "elo",
    rating: "elo",
    等级分: "elo",
    year: "year",
    y: "year",
    年份: "year",
    年: "year",
    result: "result",
    res: "result",
    结果: "result",
    eco: "eco",
    opening: "eco",
    开局: "eco",
    event: "event",
    tournament: "event",
    赛事: "event",
    tc: "tc",
    timecontrol: "tc",
    时限: "tc",
};

export type ResultValue = "1-0" | "0-1" | "1/2-1/2";

const RESULT_ALIASES: Readonly<Record<string, ResultValue>> = {
    "1-0": "1-0",
    whitewon: "1-0",
    whitewins: "1-0",
    white: "1-0",
    w: "1-0",
    胜: "1-0",
    白胜: "1-0",
    白方胜: "1-0",
    "0-1": "0-1",
    blackwon: "0-1",
    blackwins: "0-1",
    black: "0-1",
    b: "0-1",
    负: "0-1",
    黑胜: "0-1",
    黑方胜: "0-1",
    "1/2-1/2": "1/2-1/2",
    "1/2": "1/2-1/2",
    "½-½": "1/2-1/2",
    "½": "1/2-1/2",
    draw: "1/2-1/2",
    drawn: "1/2-1/2",
    d: "1/2-1/2",
    和: "1/2-1/2",
    和棋: "1/2-1/2",
    平: "1/2-1/2",
};

export function normalizeResult(value: string): ResultValue | null {
    const key = value.trim().toLowerCase().replace(/\s+/g, "");
    return RESULT_ALIASES[key] ?? null;
}

/** Display form of a result value (zh / en handled by the caller through `Query.Result.*`). */
export function resultLabelKey(value: string): string {
    // t("Query.Result.WhiteWon") t("Query.Result.BlackWon") t("Query.Result.Draw")
    switch (value) {
        case "1-0":
            return "Query.Result.WhiteWon";
        case "0-1":
            return "Query.Result.BlackWon";
        default:
            return "Query.Result.Draw";
    }
}

// ---------------------------------------------------------------------------
// Tokenizer

const FULLWIDTH: ReadonlyArray<[RegExp, string]> = [
    [/：/g, ":"],
    [/＞/g, ">"],
    [/＜/g, "<"],
    [/[“”„"]/g, '"'],
    [/＝/g, "="],
    [/　/g, " "],
];

/** Maps full-width punctuation to ASCII so Chinese IMEs need no mode switch. */
export function normalizeInput(text: string): string {
    let out = text;
    for (const [re, to] of FULLWIDTH) out = out.replace(re, to);
    return out;
}

/**
 * Splits on whitespace outside double quotes. Quotes are kept in the token so
 * `parseToken` can tell `"a:b"` (a name) from `a:b` (a key). An unterminated
 * quote runs to the end of the text.
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuote = false;
    for (const ch of normalizeInput(text)) {
        if (ch === '"') {
            inQuote = !inQuote;
            current += ch;
        } else if (!inQuote && /\s/.test(ch)) {
            if (current) tokens.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).trim();
    }
    if (trimmed.startsWith('"')) return trimmed.slice(1).trim();
    return trimmed;
}

function lookupKey(name: string): ChipKey | undefined {
    const ascii = name.trim().toLowerCase();
    return KEY_ALIASES[ascii] ?? KEY_ALIASES[name.trim()];
}

const RANGE_RE = /^(\d+)\s*(?:\.\.|–|—|~|-)\s*(\d+)$/;
const INT_RE = /^\d+$/;

function error(raw: string, reason: ParseErrorReason): ParseError {
    return { raw, reason };
}

export function isParseError(value: Chip | ParseError): value is ParseError {
    return "reason" in value;
}

/** Parses one token (as produced by `tokenize`). */
export function parseToken(token: string): Chip | ParseError {
    const raw = normalizeInput(token).trim();
    if (!raw) return error(raw, "empty_value");

    // A fully quoted token is always a name search, even if it contains ':'.
    if (raw.startsWith('"')) {
        const value = unquote(raw);
        return value ? { key: "text", op: ":", value, raw } : error(raw, "empty_value");
    }

    const m = /^([^\s:<>=]+?)\s*(>=|<=|>|<|:)\s*([\s\S]*)$/.exec(raw);
    if (!m) {
        return { key: "text", op: ":", value: raw, raw };
    }

    const key = lookupKey(m[1]);
    if (!key) return error(raw, "unknown_key");

    let op: ">=" | "<=" | ">" | "<" | ":" = m[2] as typeof op;
    let rest = m[3].trim();

    // `elo:>2600` is the same as `elo>2600`.
    if (op === ":") {
        const nested = /^(>=|<=|>|<)\s*([\s\S]*)$/.exec(rest);
        if (nested) {
            op = nested[1] as typeof op;
            rest = nested[2].trim();
        }
    }

    const value = unquote(rest);
    if (!value) return error(raw, "empty_value");

    if (NUMERIC_KEYS.has(key)) return parseNumeric(key, op, value, raw);

    if (op !== ":") return error(raw, "bad_op");

    if (key === "result") {
        const result = normalizeResult(value);
        return result ? { key, op: ":", value: result, raw } : error(raw, "bad_result");
    }

    return { key, op: ":", value, raw };
}

function parseNumeric(
    key: ChipKey,
    op: ">=" | "<=" | ">" | "<" | ":",
    value: string,
    raw: string,
): Chip | ParseError {
    const compact = value.replace(/\s+/g, "");
    if (op === ":") {
        const range = RANGE_RE.exec(compact);
        if (range) {
            let lo = Number.parseInt(range[1], 10);
            let hi = Number.parseInt(range[2], 10);
            if (lo > hi) [lo, hi] = [hi, lo];
            return { key, op: "..", value: `${lo}..${hi}`, raw };
        }
        if (/\.\.|[–—~-]/.test(compact)) return error(raw, "bad_range");
        if (!INT_RE.test(compact)) return error(raw, "bad_number");
        return { key, op: ":", value: String(Number.parseInt(compact, 10)), raw };
    }

    if (!INT_RE.test(compact)) return error(raw, "bad_number");
    const n = Number.parseInt(compact, 10);
    switch (op) {
        case ">":
            return { key, op: ">", value: String(n), raw };
        case "<":
            return { key, op: "<", value: String(n), raw };
        case ">=":
            return { key, op: ">", value: String(n - 1), raw };
        default:
            return { key, op: "<", value: String(n + 1), raw };
    }
}

/** Parses a whole query string. Chips and errors keep their input order. */
export function parseQuery(text: string): ParseResult {
    const chips: Chip[] = [];
    const errors: ParseError[] = [];
    for (const token of tokenize(text)) {
        const parsed = parseToken(token);
        if (isParseError(parsed)) errors.push(parsed);
        else chips.push(parsed);
    }
    return { chips, errors };
}

/** Splits a `a..b` chip value. */
export function rangeOf(chip: Chip): [number, number] | null {
    if (chip.op !== "..") return null;
    const m = /^(\d+)\.\.(\d+)$/.exec(chip.value);
    return m ? [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)] : null;
}

/** Canonical English spelling of a chip (what the chip shows after loading). */
export function formatChip(chip: Chip): string {
    const value = /\s/.test(chip.value) ? `"${chip.value}"` : chip.value;
    if (chip.key === "text") return value;
    if (chip.op === "..") return `${chip.key}:${chip.value}`;
    return `${chip.key}${chip.op}${value}`;
}

export function sameChip(a: Chip, b: Chip): boolean {
    return a.key === b.key && a.op === b.op && a.value === b.value;
}

/** Runtime guard for chips read back from storage. */
export function isChip(value: unknown): value is Chip {
    if (!value || typeof value !== "object") return false;
    const c = value as Record<string, unknown>;
    return (
        typeof c.key === "string" &&
        (CHIP_KEYS as readonly string[]).concat("text").includes(c.key) &&
        typeof c.op === "string" &&
        [":", ">", "<", ".."].includes(c.op) &&
        typeof c.value === "string" &&
        typeof c.raw === "string"
    );
}
