/**
 * Shared types of the X-1 v0 explanation layer (contract S2-4).
 */
import type { TFunction } from "i18next";

export type EvidenceLevel = "certain" | "likely" | "heuristic";
export type Severity = 1 | 2 | 3;
export type Lang = "zh" | "en";

export type DemoArrow = { orig: string; dest: string; brush: string };

export type ExplanationDemo = {
    fen: string;
    /** UCI moves to play from `fen` */
    line: string[];
    arrows?: DemoArrow[];
};

export type Explanation = {
    /** detector id; the template key is `Explain.<id>` (plus `.<params.variant>` when set) */
    id: string;
    evidence: EvidenceLevel;
    severity: Severity;
    /**
     * Language-neutral template parameters. Role-valued keys (`piece`,
     * `pinned`, `pinner`, `target`, `captured`) hold chessops role names and
     * are localised by `renderExplanation`; `targets` holds `role@square`
     * pairs separated by `;`; SAN strings and squares are passed through.
     */
    params: Record<string, string | number>;
    demo?: ExplanationDemo;
};

export type ExplainInput = {
    fenBefore: string;
    playedUci: string;
    bestUci: string;
    /** principal variation of the best move, UCI, starting with `bestUci` */
    bestPv: string[];
    /** Evaluation before the move; mate → ±10000. See `scoreView`. */
    scoreBefore: number;
    scoreAfterPlayed: number;
    scoreAfterBest: number;
    playerColor: "white" | "black" | null;
    /**
     * Whose point of view the three scores use. `"mover"` (default): positive
     * is good for the side that played `playedUci`. `"white"`: positive is
     * good for White, as stored in S2-3's `PlyEval.score`.
     */
    scoreView?: "mover" | "white";
    /** seconds on the mover's clock before / after the move, when known */
    clockBefore?: number;
    clockAfter?: number;
};

/** Structural subset of S2-3's `PlyEval` that `summarizeGame` reads. */
export type SummaryPly = {
    ply: number;
    san?: string;
    uci?: string;
    fenBefore?: string;
    /** cp from White's view after the move (mate → ±10000) */
    score: number;
    bestUci?: string;
    /** cp from White's view after the best move, when known */
    bestScore?: number;
    /** expected-score drop of the mover, 0..1, when already computed */
    winChanceDrop?: number;
    /** seconds left on the mover's clock after the move */
    clock?: number;
};

export type Translate = (key: string, options?: Record<string, unknown>) => string;
export type AnyTranslate = TFunction | Translate;

export type SummaryOptions = {
    /** whose moves the sentences talk about; defaults to White */
    playerColor?: "white" | "black" | null;
    /** translator; defaults to the global i18next instance */
    t?: AnyTranslate;
};
