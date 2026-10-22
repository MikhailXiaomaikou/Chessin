/**
 * Chessin X-1 v0 — deterministic, engine-free explanations of key moments
 * (contract S2-4). Consumers: the review panel (S2-3) and the Today card /
 * mistake notebook (S2-5).
 *
 * - `explainMoment(input)`: runs every detector over one key moment and
 *   returns up to four `Explanation`s, strongest first.
 * - `renderExplanation(e, t, lang)`: one localised sentence per explanation.
 * - `summarizeGame(plies, { playerColor })`: 2–3 sentences about a game.
 * - `ExplanationCard`: Mantine card with the evidence badge and a demo button.
 */
import { buildContext, DETECTORS, finalize } from "./detectors";
import type { Explanation, ExplainInput } from "./types";

export type {
    AnyTranslate,
    DemoArrow,
    EvidenceLevel,
    Explanation,
    ExplanationDemo,
    ExplainInput,
    Lang,
    Severity,
    SummaryOptions,
    SummaryPly,
    Translate,
} from "./types";
export { DETECTOR_IDS, type DetectorId, MATE_SCORE, winChance } from "./detectors";
export {
    EXPLAIN_TEMPLATE_KEYS,
    evidenceKey,
    formatTargets,
    langOf,
    pieceLetter,
    pieceName,
    renderExplanation,
    templateKeys,
    templateVars,
} from "./render";
export {
    BLUNDER_DROP,
    MISTAKE_DROP,
    playerDrops,
    summarizeGame,
    summarizeGameKeys,
} from "./summary";
export type { Phase, PlyDrop, SummarySentence } from "./summary";
export { ExplanationCard, type ExplanationCardProps } from "./ExplanationCard";

export function explainMoment(input: ExplainInput): Explanation[] {
    if (!input.playedUci || input.playedUci === input.bestUci) return [];
    const ctx = buildContext(input);
    if (!ctx) return [];
    const found: Explanation[] = [];
    for (const detector of DETECTORS) {
        try {
            found.push(...detector(ctx));
        } catch (error) {
            // a detector bug must never break a review; the others still run
            console.warn("[chessin/explain] detector failed", detector.name, error);
        }
    }
    return finalize(found);
}
