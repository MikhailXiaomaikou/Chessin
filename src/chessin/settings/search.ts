/**
 * Settings search (plan X-10): title / description / keywords / category in
 * the UI language, plus pinyin (full syllables and initials, through the
 * palette's lazily loaded `pinyin-pro` index) and the ChessBase → Chessin
 * synonym table.
 *
 * Substring matching, not fuzzy: the settings list is short and users search
 * for a word they know. Every word of the query must match some field; the
 * score prefers title > keywords > category > id > description, and a pinyin
 * match scores slightly below the same field matched directly. A synonym
 * expands the query into extra searches whose matches carry the `synonym`
 * hit, so the page can explain "“参考库”在 Chessin 里叫“默认来源”".
 */
import { hasCjk, pinyinIndex } from "@/chessin/commands/pinyin";
import { type SynonymHit, synonymsFor } from "./synonyms";

export type SearchableSetting = {
    id: string;
    title: string;
    description: string;
    keywords?: string[];
    categoryTitle: string;
};

export type SettingMatch<T extends SearchableSetting> = {
    item: T;
    score: number;
    /** Set when the item was found through a synonym rather than the query itself. */
    synonym?: SynonymHit;
};

const FIELD_SCORES = {
    title: 100,
    keywords: 80,
    categoryTitle: 60,
    id: 50,
    description: 40,
} as const;

const PINYIN_PENALTY = { initials: 8, full: 4 } as const;
const SYNONYM_FACTOR = 0.95;
const LATIN = /^[a-z0-9 .'+-]+$/;

export function normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export type SearchOptions = {
    /** `false` skips the pinyin columns (until `pinyin-pro` has loaded); default `true`. */
    pinyin?: boolean;
};

/** Best score of `word` against one field; 0 when it does not match. */
function matchField(field: string, word: string, base: number, pinyin: boolean): number {
    if (!field) return 0;
    if (field.toLowerCase().includes(word)) return base;
    if (pinyin && LATIN.test(word) && hasCjk(field)) {
        const idx = pinyinIndex(field);
        const compact = word.replace(/\s/g, "");
        if (idx.initials.includes(compact)) return base - PINYIN_PENALTY.initials;
        if (idx.full.replace(/\s/g, "").includes(compact)) return base - PINYIN_PENALTY.full;
    }
    return 0;
}

function matchItem(item: SearchableSetting, words: string[], pinyin: boolean): number {
    let total = 0;
    for (const word of words) {
        const best = Math.max(
            matchField(item.title, word, FIELD_SCORES.title, pinyin),
            ...(item.keywords ?? []).map((k) => matchField(k, word, FIELD_SCORES.keywords, pinyin)),
            matchField(item.categoryTitle, word, FIELD_SCORES.categoryTitle, pinyin),
            matchField(item.id, word, FIELD_SCORES.id, pinyin),
            matchField(item.description, word, FIELD_SCORES.description, pinyin),
        );
        if (best === 0) return 0;
        total += best;
    }
    return total / words.length;
}

function searchPlain<T extends SearchableSetting>(
    items: T[],
    query: string,
    pinyin: boolean,
): Map<string, SettingMatch<T>> {
    const words = normalizeQuery(query).split(" ").filter(Boolean);
    const out = new Map<string, SettingMatch<T>>();
    if (words.length === 0) return out;
    for (const item of items) {
        const score = matchItem(item, words, pinyin);
        if (score > 0) out.set(item.id, { item, score });
    }
    return out;
}

/** Matching settings, best first; stable in the original order for equal scores. */
export function searchSettings<T extends SearchableSetting>(
    items: T[],
    query: string,
    options: SearchOptions = {},
): SettingMatch<T>[] {
    const q = normalizeQuery(query);
    if (q.length === 0) return [];
    const pinyin = options.pinyin !== false;
    const matches = searchPlain(items, q, pinyin);
    // Synonyms only add rows the query itself did not find; among several
    // targets the best-scoring one explains the hit.
    const direct = new Set(matches.keys());
    for (const hit of synonymsFor(q)) {
        for (const [id, m] of searchPlain(items, hit.target, pinyin)) {
            if (direct.has(id)) continue;
            const score = m.score * SYNONYM_FACTOR;
            const existing = matches.get(id);
            if (!existing || score > existing.score) {
                matches.set(id, { item: m.item, score, synonym: hit });
            }
        }
    }
    const order = new Map(items.map((item, i) => [item.id, i]));
    return Array.from(matches.values()).sort(
        (a, b) => b.score - a.score || (order.get(a.item.id) ?? 0) - (order.get(b.item.id) ?? 0),
    );
}

/** Distinct synonym explanations among `matches`, in result order. */
export function synonymHints<T extends SearchableSetting>(
    matches: SettingMatch<T>[],
): SynonymHit[] {
    const seen = new Set<string>();
    const hints: SynonymHit[] = [];
    for (const m of matches) {
        if (!m.synonym) continue;
        const key = `${m.synonym.term}→${m.synonym.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push(m.synonym);
    }
    return hints;
}
