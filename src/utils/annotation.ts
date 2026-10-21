import type { MantineColor } from "@mantine/core";

const pieceChars = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };

export function addPieceSymbol(move: string): string {
    const pieceChar = pieceChars[move[0] as keyof typeof pieceChars];

    if (typeof pieceChar === "undefined") return move;
    return pieceChar + move.slice(1);
}

/** Annotations with a dedicated glyph and UI entry. */
export type KnownAnnotation =
    | ""
    | "!"
    | "!!"
    | "?"
    | "??"
    | "!?"
    | "?!"
    | "+-"
    | "±"
    | "⩲"
    | "="
    | "∞"
    | "⩱"
    | "∓"
    | "-+"
    | "N"
    | "↑↑"
    | "↑"
    | "→"
    | "⇆"
    | "=∞"
    | "⊕"
    | "∆"
    | "□"
    | "⨀"
    | "⊗";

/**
 * A numeric annotation glyph without a dedicated symbol (e.g. `$33`,
 * black's counterpart of `$32`). It is stored verbatim so that every NAG of
 * an imported PGN re-serialises unchanged.
 */
export type NagAnnotation = `$${number}`;

export type Annotation = KnownAnnotation | NagAnnotation;

/**
 * Canonical NAG -> glyph mapping. Only the NAG an annotation serialises to is
 * listed (see `ANNOTATION_INFO[x].nag`); every other NAG, including the
 * "black" counterparts such as `$33`, stays a `NagAnnotation`.
 */
export const NAG_INFO = new Map<string, Annotation>([
    ["$1", "!"],
    ["$2", "?"],
    ["$3", "!!"],
    ["$4", "??"],
    ["$5", "!?"],
    ["$6", "?!"],
    ["$7", "□"],
    ["$9", "⊗"],
    ["$10", "="],
    ["$13", "∞"],
    ["$14", "⩲"],
    ["$15", "⩱"],
    ["$16", "±"],
    ["$17", "∓"],
    ["$18", "+-"],
    ["$19", "-+"],
    ["$22", "⨀"],
    ["$32", "↑↑"],
    ["$36", "↑"],
    ["$40", "→"],
    ["$44", "=∞"],
    ["$132", "⇆"],
    ["$138", "⊕"],
    ["$140", "∆"],
    ["$146", "N"],
]);

type AnnotationInfo = {
    group?: string;
    name: string;
    translationKey?: string;
    color?: MantineColor;
    nag: number;
};

const KNOWN_ANNOTATION_INFO: Record<KnownAnnotation, AnnotationInfo> = {
    "": { name: "None", translationKey: "None", color: "gray", nag: 0 },
    "!!": {
        group: "basic",
        name: "Brilliant",
        translationKey: "Brilliant",
        color: "cyan",
        nag: 3,
    },
    "!": {
        group: "basic",
        name: "Good",
        translationKey: "Good",
        color: "teal",
        nag: 1,
    },
    "!?": {
        group: "basic",
        name: "Interesting",
        translationKey: "Interesting",
        color: "lime",
        nag: 5,
    },
    "?!": {
        group: "basic",
        name: "Dubious",
        translationKey: "Dubious",
        color: "yellow",
        nag: 6,
    },
    "?": {
        group: "basic",
        name: "Mistake",
        translationKey: "Mistake",
        color: "orange",
        nag: 2,
    },
    "??": {
        group: "basic",
        name: "Blunder",
        translationKey: "Blunder",
        color: "red",
        nag: 4,
    },
    "+-": {
        group: "advantage",
        name: "White is winning",
        translationKey: "WhiteWinning",
        nag: 18,
    },
    "±": {
        group: "advantage",
        name: "White has a clear advantage",
        translationKey: "WhiteAdvantage",
        nag: 16,
    },
    "⩲": {
        group: "advantage",
        name: "White has a slight advantage",
        translationKey: "WhiteEdge",
        nag: 14,
    },
    "=": {
        group: "advantage",
        name: "Equal position",
        translationKey: "Equal",
        nag: 10,
    },
    "∞": {
        group: "advantage",
        name: "Unclear position",
        translationKey: "Unclear",
        nag: 13,
    },
    "⩱": {
        group: "advantage",
        name: "Black has a slight advantage",
        translationKey: "BlackEdge",
        nag: 15,
    },
    "∓": {
        group: "advantage",
        name: "Black has a clear advantage",
        translationKey: "BlackAdvantage",
        nag: 17,
    },
    "-+": {
        group: "advantage",
        name: "Black is winning",
        translationKey: "BlackWinning",
        nag: 19,
    },
    N: { name: "Novelty", translationKey: "Novelty", nag: 146 },
    "↑↑": { name: "Development", translationKey: "Development", nag: 32 },
    "↑": { name: "Initiative", translationKey: "Initiative", nag: 36 },
    "→": { name: "Attack", translationKey: "Attack", nag: 40 },
    "⇆": { name: "Counterplay", translationKey: "Counterplay", nag: 132 },
    "=∞": {
        name: "With compensation",
        translationKey: "WithCompensation",
        nag: 44,
    },
    "⊕": { name: "Time Trouble", translationKey: "TimeTrouble", nag: 138 },
    "∆": { name: "With the idea", translationKey: "WithIdea", nag: 140 },
    "□": { name: "Only move", translationKey: "OnlyMove", nag: 7 },
    "⨀": { name: "Zugzwang", translationKey: "Zugzwang", nag: 22 },
    "⊗": { name: "Miss", translationKey: "Miss", color: "red", nag: 9 },
};

const nagAnnotationInfo = new Map<NagAnnotation, AnnotationInfo>();

/**
 * Annotation metadata. Unknown NAGs (`$n`) are synthesised on access so that
 * `ANNOTATION_INFO[a].nag` / `.group` is always safe; `Object.keys` still
 * lists only the known glyphs.
 */
export const ANNOTATION_INFO: Record<Annotation, AnnotationInfo> = new Proxy(
    KNOWN_ANNOTATION_INFO,
    {
        get(target, prop, receiver) {
            if (typeof prop === "string" && isNagAnnotation(prop) && !(prop in target)) {
                let info = nagAnnotationInfo.get(prop);
                if (!info) {
                    info = { name: prop, nag: Number.parseInt(prop.slice(1), 10) };
                    nagAnnotationInfo.set(prop, info);
                }
                return info;
            }
            return Reflect.get(target, prop, receiver);
        },
    },
) as Record<Annotation, AnnotationInfo>;

export function isNagAnnotation(annotation: string): annotation is NagAnnotation {
    return /^\$\d+$/.test(annotation);
}

/** The NAG number an annotation serialises to (`0` for the empty annotation). */
export function annotationToNag(annotation: Annotation): number {
    if (isNagAnnotation(annotation)) {
        return Number.parseInt(annotation.slice(1), 10);
    }
    return KNOWN_ANNOTATION_INFO[annotation]?.nag ?? 0;
}

/**
 * Converts a NAG token (`"$14"`, `"14"` or `14`) to an annotation. Known NAGs
 * become their glyph, `$0` the empty annotation and everything else a
 * `NagAnnotation` so it round-trips unchanged.
 */
export function nagToAnnotation(nag: string | number): Annotation {
    const n = typeof nag === "number" ? nag : Number.parseInt(nag.replace(/^\$/, ""), 10);
    if (!Number.isInteger(n) || n <= 0) {
        return "";
    }
    return NAG_INFO.get(`$${n}`) ?? `$${n}`;
}

/** Deterministic ordering by NAG number. */
export function compareAnnotations(a: Annotation, b: Annotation): number {
    return annotationToNag(a) - annotationToNag(b);
}

export function isBasicAnnotation(
    annotation: string,
): annotation is "!" | "!!" | "?" | "??" | "!?" | "?!" {
    return ["!", "!!", "?", "??", "!?", "?!"].includes(annotation);
}
