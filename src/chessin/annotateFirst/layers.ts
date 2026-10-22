/**
 * Comment layers (S4-6, W3-4). A node comment may carry up to three tagged
 * paragraphs, each introduced by a full-width bracket prefix:
 *
 *   【我的思考】 the player's own thoughts (written in 先自己注释 mode)
 *   【教练】     a coach's remarks
 *   【引擎】     engine-derived notes
 *
 * Text before the first prefix is the plain (untagged) comment. The prefix
 * is a reserved marker: wherever it appears, a new segment starts. Segments
 * are joined with blank lines so the upstream Markdown renderer shows them
 * as separate paragraphs; parsing tolerates any whitespace between them.
 *
 * Pure helpers, no React.
 */

export type CommentLayer = "mine" | "coach" | "engine";
export type SegmentLayer = CommentLayer | "plain";

export const LAYER_PREFIX: Readonly<Record<CommentLayer, string>> = {
    mine: "【我的思考】",
    coach: "【教练】",
    engine: "【引擎】",
};

export const LAYERS: readonly CommentLayer[] = ["mine", "coach", "engine"];
export const SEGMENT_LAYERS: readonly SegmentLayer[] = ["plain", ...LAYERS];

export type CommentSegment = {
    layer: SegmentLayer;
    /** Segment text without its prefix, trimmed. */
    text: string;
};

export type LayerVisibility = Record<SegmentLayer, boolean>;

export const ALL_LAYERS_VISIBLE: Readonly<LayerVisibility> = {
    plain: true,
    mine: true,
    coach: true,
    engine: true,
};

/** The layer a prefix stands for, or null when `text` does not start with one. */
export function layerOfPrefix(text: string): CommentLayer | null {
    for (const layer of LAYERS) {
        if (text.startsWith(LAYER_PREFIX[layer])) return layer;
    }
    return null;
}

type Mark = { index: number; layer: CommentLayer };

function findMarks(comment: string): Mark[] {
    const marks: Mark[] = [];
    for (const layer of LAYERS) {
        const prefix = LAYER_PREFIX[layer];
        let from = 0;
        for (;;) {
            const index = comment.indexOf(prefix, from);
            if (index === -1) break;
            marks.push({ index, layer });
            from = index + prefix.length;
        }
    }
    return marks.sort((a, b) => a.index - b.index);
}

/** Splits a comment into its plain text and tagged segments, in document order. Blank segments are dropped. */
export function parseLayers(comment: string): CommentSegment[] {
    const out: CommentSegment[] = [];
    if (!comment) return out;
    const marks = findMarks(comment);
    const head = (marks.length > 0 ? comment.slice(0, marks[0].index) : comment).trim();
    if (head) out.push({ layer: "plain", text: head });
    for (let i = 0; i < marks.length; i++) {
        const mark = marks[i];
        const start = mark.index + LAYER_PREFIX[mark.layer].length;
        const end = i + 1 < marks.length ? marks[i + 1].index : comment.length;
        const text = comment.slice(start, end).trim();
        if (text) out.push({ layer: mark.layer, text });
    }
    return out;
}

/** Serialises segments back into a comment (plain text first, as parsed). */
export function joinLayers(segments: readonly CommentSegment[]): string {
    return segments
        .filter((s) => s.text.trim())
        .map((s) => (s.layer === "plain" ? s.text.trim() : LAYER_PREFIX[s.layer] + s.text.trim()))
        .join("\n\n");
}

/** The comment with only the visible layers kept (used by the panel's own notation view). */
export function filterLayers(comment: string, visible: Partial<LayerVisibility>): string {
    return joinLayers(parseLayers(comment).filter((s) => visible[s.layer] !== false));
}

/** Text of a layer (segments of the same layer joined with blank lines), "" when absent. */
export function getLayerText(comment: string, layer: SegmentLayer): string {
    return parseLayers(comment)
        .filter((s) => s.layer === layer)
        .map((s) => s.text)
        .join("\n\n");
}

/**
 * Replaces the text of `layer` in `comment`, keeping every other segment in
 * place. An empty `text` removes the layer; a new layer is appended.
 */
export function setLayerText(comment: string, layer: SegmentLayer, text: string): string {
    const next = text.trim();
    const segments = parseLayers(comment);
    const out: CommentSegment[] = [];
    let placed = false;
    for (const s of segments) {
        if (s.layer !== layer) {
            out.push(s);
            continue;
        }
        if (!placed && next) {
            out.push({ layer, text: next });
            placed = true;
        }
    }
    if (!placed && next) {
        if (layer === "plain") out.unshift({ layer, text: next });
        else out.push({ layer, text: next });
    }
    return joinLayers(out);
}

/** True when the comment carries at least one tagged layer. */
export function hasLayers(comment: string): boolean {
    return findMarks(comment).length > 0;
}

/** Translation key of a layer's legend label. */
export function layerLabelKey(layer: SegmentLayer): string {
    // t("AnnotateFirst.Layer.plain") t("AnnotateFirst.Layer.mine") t("AnnotateFirst.Layer.coach") t("AnnotateFirst.Layer.engine")
    return `AnnotateFirst.Layer.${layer}`;
}
