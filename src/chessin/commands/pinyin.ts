/**
 * Pinyin index for palette search.
 *
 * `pinyin-pro` ships a sizeable dictionary, so it is loaded lazily the first
 * time the palette opens. Until it is loaded, `pinyinIndex` returns empty
 * strings and search works on titles / aliases only.
 */

type PinyinFn = (
    text: string,
    options: { toneType: "none"; type: "array"; nonZh: "removed"; pattern?: "first" },
) => string[];

let pinyinFn: PinyinFn | null = null;
let loading: Promise<void> | null = null;

const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const cache = new Map<string, PinyinIndex>();

export type PinyinIndex = {
    /** Full syllables, both spaced and joined: "ming ling mian ban minglingmianban". */
    full: string;
    /** First letters: "mlmb". */
    initials: string;
};

const EMPTY: PinyinIndex = { full: "", initials: "" };

export function hasCjk(text: string): boolean {
    return CJK.test(text);
}

export function isPinyinLoaded(): boolean {
    return pinyinFn !== null;
}

export function loadPinyin(): Promise<void> {
    if (pinyinFn) return Promise.resolve();
    if (!loading) {
        loading = import("pinyin-pro")
            .then((mod) => {
                pinyinFn = mod.pinyin as unknown as PinyinFn;
            })
            .catch((e) => {
                loading = null;
                throw e;
            });
    }
    return loading;
}

/** Builds (and caches) the pinyin index for `text`; empty for non-Chinese text. */
export function pinyinIndex(text: string): PinyinIndex {
    if (!pinyinFn || !hasCjk(text)) return EMPTY;
    const cached = cache.get(text);
    if (cached) return cached;
    const syllables = pinyinFn(text, { toneType: "none", type: "array", nonZh: "removed" });
    const initials = pinyinFn(text, {
        toneType: "none",
        type: "array",
        nonZh: "removed",
        pattern: "first",
    });
    const index: PinyinIndex = {
        full: `${syllables.join(" ")} ${syllables.join("")}`.trim(),
        initials: initials.join(""),
    };
    cache.set(text, index);
    return index;
}
