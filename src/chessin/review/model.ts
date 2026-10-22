import type { ScoreValue } from "@/bindings";
import type { Explanation } from "@/chessin/explain";
import { originToString } from "@/chessin/save/saveModel";
import type { GameOrigin } from "@/utils/tabs";
import { getWinChance } from "@/utils/score";

/**
 * Review document model (S2-3).
 *
 * One review per game, stored as a library document
 * (`kind: "review"`, id `"review:" + gameKey`). The game key is
 * `originToString(origin)` for files / databases and `"library:<docId>"` for
 * library documents, so a review can be found again from any tab that shows
 * the same game.
 *
 * Scores: centipawns from white's point of view everywhere in this model;
 * a mate is `±MATE_CP`. Expected scores (win chances) are `0..1` from the
 * mover's point of view.
 */

export const REVIEW_VERSION = 1 as const;
export const REVIEW_DOC_KIND = "review";
export const REVIEW_DOC_PREFIX = "review:";

/** Centipawn value used for a forced mate. */
export const MATE_CP = 10_000;

export type ReviewPreset = "full" | "blunder_check";
export type PlayerColor = "white" | "black";
export type Phase = "opening" | "middlegame" | "endgame";

export type MomentKind =
    | "blunder"
    | "mistake"
    | "missed_win"
    | "missed_draw"
    | "only_move"
    | "time_pressure";

export type PlyEval = {
    /** 1-based half-move index in the main line. */
    ply: number;
    san: string;
    /** Standard UCI (castling as `e1g1`). */
    uci: string;
    fenBefore: string;
    /** `fenBefore` without the move counters (eval-cache key). */
    epd: string;
    /** Side that played the move. */
    color: PlayerColor;
    /** Evaluation after the move, cp from white's view (mate → ±MATE_CP). */
    score: number;
    /** Engine's best move in `fenBefore` (standard UCI). */
    bestUci: string;
    /** Evaluation of `fenBefore` (= after the best move), cp from white's view. */
    bestScore: number;
    /** Expected-score drop for the mover, 0..1 (0 when the engine's best move was played). */
    winChanceDrop: number;
    /** Centipawn loss for the mover (clamped like `getCPLoss`; 0 when the best move was played). */
    cpLoss: number;
    /** Seconds left for the mover after the move, when the PGN had clocks. */
    clock?: number;
    /** Search depth behind `bestScore` (0 when derived from a terminal position). */
    depth: number;
};

export type Alternative = {
    uci: string;
    san: string;
    /** cp from white's view. */
    score: number;
};

export type KeyMoment = {
    id: string;
    ply: number;
    /** Id of the main-line node *after* the played move, when the review was built from a tree. */
    nodeId?: string;
    fenBefore: string;
    playedUci: string;
    playedSan: string;
    bestUci: string;
    bestSan: string;
    /** Engine principal variation from `fenBefore` (standard UCI). */
    bestPv: string[];
    alternatives: Alternative[];
    /** Expected-score drop 0..1 (what the played move cost). */
    drop: number;
    /** 0..1, see `findability.ts`. */
    findability: number;
    /** `drop × findability` (only-move moments: `½ × gap × findability`). */
    priority: number;
    phase: Phase;
    kind: MomentKind;
    color: PlayerColor;
    clock?: number;
    /** From S2-4's `explainMoment`. */
    explanations?: Explanation[];
};

export type PhaseStats = {
    /** Ply (half-move count) at which the phase ends; `plies.length` when it lasts to the end. */
    endPly: number;
    /** Total centipawn loss of the reviewed player in the phase, in pawns (both sides when `playerColor` is null). */
    loss: number;
};

export type ReviewSummary = {
    accuracy: { white: number; black: number };
    cpl: { white: number; black: number };
    /** Counts for the reviewed player (both sides when `playerColor` is null). */
    blunders: number;
    mistakes: number;
    inaccuracies: number;
    /** Plies of inaccurate-or-worse moves played under time pressure. */
    timePressureMoves: number[];
};

export type ReviewHeaders = {
    white: string;
    black: string;
    result: string;
    date?: string;
};

export type Review = {
    version: typeof REVIEW_VERSION;
    gameKey: string;
    /** Engine name + version the evaluations came from. */
    engine: string;
    depth: number;
    createdAt: number;
    playerColor: PlayerColor | null;
    preset: ReviewPreset;
    headers?: ReviewHeaders;
    plies: PlyEval[];
    /** Sorted by `priority`, highest first. */
    moments: KeyMoment[];
    phases: { opening: PhaseStats; middlegame: PhaseStats; endgame: PhaseStats };
    summary: ReviewSummary;
};

// ---------------------------------------------------------------------------
// Thresholds (expected-score units, 0..1)

export const BLUNDER_DROP = 0.2;
export const MISTAKE_DROP = 0.1;
export const INACCURACY_DROP = 0.05;
/** Gap between best and second best for the best move to count as an only move. */
export const ONLY_MOVE_GAP = 0.25;
/** Seconds on the clock at or below which a move counts as played under time pressure. */
export const TIME_PRESSURE_SECONDS = 20;
/** …or less than this share of the first clock seen for that colour. */
export const TIME_PRESSURE_RATIO = 0.1;
/** Key moments kept per review (highest priority first). */
export const MAX_MOMENTS = 12;
/** Found only-moves kept per review. */
export const MAX_ONLY_MOVES = 3;

// ---------------------------------------------------------------------------
// Keys and ids

export function reviewDocId(gameKey: string): string {
    return REVIEW_DOC_PREFIX + gameKey;
}

export function gameKeyFromDocId(docId: string): string | null {
    return docId.startsWith(REVIEW_DOC_PREFIX) ? docId.slice(REVIEW_DOC_PREFIX.length) : null;
}

/**
 * Stable key of a game: `originToString` for files / databases, `library:<docId>`
 * for library documents, `null` for scratch tabs (nothing to attach a review to).
 */
export function gameKeyForOrigin(origin: GameOrigin | null | undefined): string | null {
    if (!origin) return null;
    if (origin.kind === "library") return `library:${origin.docId}`;
    return originToString(origin);
}

// ---------------------------------------------------------------------------
// Score helpers

export function scoreToCp(score: ScoreValue): number {
    if (score.type === "mate") return score.value > 0 ? MATE_CP : score.value < 0 ? -MATE_CP : 0;
    if (score.type === "cp") return score.value;
    return 0;
}

export function cpToScoreValue(cp: number): ScoreValue {
    if (Math.abs(cp) >= MATE_CP) return { type: "mate", value: Math.sign(cp) };
    return { type: "cp", value: cp };
}

/** cp from `color`'s point of view. */
export function cpForColor(cp: number, color: PlayerColor): number {
    return color === "white" ? cp : -cp;
}

/** Expected score (0..1) for `color` from a white-view centipawn value. */
export function expectedScore(cp: number, color: PlayerColor): number {
    return getWinChance(cpForColor(cp, color)) / 100;
}

/** First four FEN fields (board, turn, castling, en passant). */
export function fenToEpd(fen: string): string {
    return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

export function isTimePressure(clock: number | undefined, firstClock: number | undefined): boolean {
    if (clock === undefined || !Number.isFinite(clock)) return false;
    if (clock <= TIME_PRESSURE_SECONDS) return true;
    return firstClock !== undefined && firstClock > 0 && clock <= firstClock * TIME_PRESSURE_RATIO;
}

/** Structural check for a stored document payload. */
export function isReview(value: unknown): value is Review {
    if (!value || typeof value !== "object") return false;
    const r = value as Partial<Review>;
    return (
        r.version === REVIEW_VERSION &&
        typeof r.gameKey === "string" &&
        Array.isArray(r.plies) &&
        Array.isArray(r.moments) &&
        !!r.summary &&
        !!r.phases
    );
}
