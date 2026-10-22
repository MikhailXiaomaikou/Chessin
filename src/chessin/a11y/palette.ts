/**
 * Annotation colour palettes (plan X-9).
 *
 * "default" keeps En Croissant's Mantine colours and chessground's built-in
 * brushes. "okabe-ito" swaps every arrow brush and the six basic annotation
 * colours for the Okabe–Ito colour-blind-safe set, and the CSS that keys off
 * `data-annotation-palette="okabe-ito"` (boardA11y.css) adds a second channel
 * besides hue: good moves are solid, bad ones dashed (engine alternatives and
 * threats dashed, the best line solid; a `?`/`??`/`?!` last-move square gets a
 * dashed outline, `!`/`!!`/`!?` a solid one).
 */
import type { DrawBrush } from "@lichess-org/chessground/draw";
import type { Annotation } from "@/utils/annotation";

export type AnnotationPalette = "default" | "okabe-ito";

/** Okabe & Ito (2008), the eight-colour palette safe for all common colour-vision deficiencies. */
export const OKABE_ITO = {
    orange: "#E69F00",
    skyBlue: "#56B4E9",
    bluishGreen: "#009E73",
    yellow: "#F0E442",
    blue: "#0072B2",
    vermillion: "#D55E00",
    reddishPurple: "#CC79A7",
    black: "#000000",
} as const;

/**
 * Brush overrides for chessground, spread after the board's own brushes. The
 * keys are chessground's (`blue`, `paleBlue`, …) and the board's (`variation`,
 * `threat`, `threatPale`), and the `key`s (marker ids) stay the same so the
 * dashed-line CSS can target `arrowhead-pb` / `arrowhead-threat`.
 */
export function paletteBrushes(palette: AnnotationPalette): Record<string, DrawBrush> {
    if (palette !== "okabe-ito") return {};
    const strong = (key: string, color: string): DrawBrush => ({
        key,
        color,
        opacity: 1,
        lineWidth: 10,
    });
    const pale = (key: string, color: string): DrawBrush => ({
        key,
        color,
        opacity: 0.45,
        lineWidth: 15,
    });
    return {
        blue: strong("b", OKABE_ITO.blue),
        green: strong("g", OKABE_ITO.bluishGreen),
        red: strong("r", OKABE_ITO.vermillion),
        yellow: strong("y", OKABE_ITO.orange),
        paleBlue: pale("pb", OKABE_ITO.blue),
        paleGreen: pale("pg", OKABE_ITO.bluishGreen),
        paleRed: pale("pr", OKABE_ITO.vermillion),
        paleGrey: pale("pgr", OKABE_ITO.black),
        variation: { key: "v", color: OKABE_ITO.reddishPurple, opacity: 0.8, lineWidth: 10 },
        threat: { key: "threat", color: OKABE_ITO.vermillion, opacity: 0.9, lineWidth: 10 },
        threatPale: {
            key: "threatPale",
            color: OKABE_ITO.vermillion,
            opacity: 0.45,
            lineWidth: 10,
        },
    };
}

const OKABE_ITO_ANNOTATIONS: Partial<Record<Annotation, string>> = {
    "!!": OKABE_ITO.skyBlue,
    "!": OKABE_ITO.bluishGreen,
    "!?": OKABE_ITO.blue,
    "?!": OKABE_ITO.yellow,
    "?": OKABE_ITO.orange,
    "??": OKABE_ITO.vermillion,
};

/**
 * Hex colour of a basic annotation under `palette`, or `null` to keep the
 * Mantine colour (`ANNOTATION_INFO[a].color`) the board already uses.
 */
export function annotationColor(
    annotation: Annotation | undefined,
    palette: AnnotationPalette,
): string | null {
    if (palette !== "okabe-ito" || !annotation) return null;
    return OKABE_ITO_ANNOTATIONS[annotation] ?? null;
}

/** Whether a basic annotation praises or criticises the move; `undefined` for the rest. */
export function annotationQuality(annotation: string | undefined): "good" | "bad" | undefined {
    switch (annotation) {
        case "!":
        case "!!":
        case "!?":
            return "good";
        case "?":
        case "??":
        case "?!":
            return "bad";
        default:
            return undefined;
    }
}
