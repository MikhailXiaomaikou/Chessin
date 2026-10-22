import { type Chess, type Color, type Move, parseUci, type Role, type Square } from "chessops";

/**
 * Findability of the best move in a key moment (S2-3).
 *
 * A moment is worth training when the mistake was costly *and* the right
 * move was within reach. "Within reach" is this heuristic, a pure function
 * of three signals, each 0..1:
 *
 * 1. `obviousness` — what the move *is*: a recapture (1.0), a mate in one or
 *    a promotion (0.95), a capture with check (0.9), a capture (0.7), a check
 *    (0.6), a quiet move (0). Captures of a hanging piece score as recaptures.
 * 2. `shallowness` — how deep one has to look. `depthFound` is the ply depth
 *    at which the move becomes visible: 1 for a one-move tactic, `maxDepth`
 *    for something only the full search sees. `shallowness = 1 −
 *    (depthFound − 1) / (maxDepth − 1)`. Unknown → `UNKNOWN_SHALLOWNESS`.
 *    `analyzeGame` only reports the final search, so `estimateDepthFound`
 *    derives it from the move type and the PV (mate in n → 2n − 1).
 * 3. `gapTerm` — the expected-score gap between the best and the second-best
 *    move. A big gap makes an *obvious* move easier (the only capture that
 *    works), but a big gap behind a *quiet* move means a unique idea nobody
 *    sees at the board: `gapTerm = obviousness × gap + (1 − obviousness) ×
 *    (1 − gap) × 0.6`. Unknown gap → 0.5.
 *
 * `findability = 0.4 × obviousness + 0.35 × shallowness + 0.25 × gapTerm`,
 * clamped to 0..1. Priority of a moment is `drop × findability`.
 */

export const FINDABILITY_WEIGHTS = { obvious: 0.4, depth: 0.35, gap: 0.25 } as const;
export const UNKNOWN_SHALLOWNESS = 0.4;
export const UNKNOWN_GAP_TERM = 0.5;

export type MoveFeatures = {
    isCapture: boolean;
    isCheck: boolean;
    /** Captures on the square the opponent just captured on. */
    isRecapture: boolean;
    /** Captures a piece that is not defended at all. */
    capturesHanging: boolean;
    isMateInOne: boolean;
    isPromotion: boolean;
};

export type FindabilityInput = Partial<MoveFeatures> & {
    /** Expected-score gap (0..1) between the best and the second-best move; `null` when unknown. */
    gap: number | null;
    /** Ply depth at which the best move becomes visible (1 = one-move tactic); `null` when unknown. */
    depthFound: number | null;
    /** Search depth of the evaluation (normalises `depthFound`). */
    maxDepth: number;
};

function clamp01(x: number): number {
    return Math.min(1, Math.max(0, x));
}

export function obviousness(f: Partial<MoveFeatures>): number {
    if (f.isRecapture || (f.isCapture && f.capturesHanging)) return 1;
    if (f.isMateInOne || f.isPromotion) return 0.95;
    if (f.isCapture && f.isCheck) return 0.9;
    if (f.isCapture) return 0.7;
    if (f.isCheck) return 0.6;
    return 0;
}

export function shallowness(depthFound: number | null, maxDepth: number): number {
    if (depthFound === null || !Number.isFinite(depthFound)) return UNKNOWN_SHALLOWNESS;
    const span = Math.max(1, maxDepth - 1);
    return clamp01(1 - (Math.max(1, depthFound) - 1) / span);
}

export function gapTerm(gap: number | null, obvious: number): number {
    if (gap === null || !Number.isFinite(gap)) return UNKNOWN_GAP_TERM;
    const g = clamp01(gap);
    return obvious * g + (1 - obvious) * (1 - g) * 0.6;
}

/** 0..1 — how likely a club player is to find the best move at the board. */
export function scoreFindability(input: FindabilityInput): number {
    const obvious = obviousness(input);
    const shallow = shallowness(input.depthFound, input.maxDepth);
    const gap = gapTerm(input.gap, obvious);
    const w = FINDABILITY_WEIGHTS;
    return clamp01(w.obvious * obvious + w.depth * shallow + w.gap * gap);
}

// ---------------------------------------------------------------------------
// Move features (chessops only)

const PIECE_VALUE: Record<Role, number> = {
    pawn: 1,
    knight: 3,
    bishop: 3,
    rook: 5,
    queen: 9,
    king: 0,
};

export function pieceValue(role: Role | undefined): number {
    return role ? PIECE_VALUE[role] : 0;
}

function opposite(color: Color): Color {
    return color === "white" ? "black" : "white";
}

/**
 * Features of `uci` played in `pos`. `lastMove` is the opponent's previous
 * move (for recaptures). Returns `null` when the move is not legal.
 */
export function describeMove(
    pos: Chess,
    uci: string,
    lastMove?: { to: Square; capture: boolean } | null,
): MoveFeatures | null {
    const move = parseUci(uci.trim().toLowerCase());
    if (!move || !("from" in move) || !pos.isLegal(move)) return null;
    const mover = pos.turn;
    const movingPiece = pos.board.get(move.from);
    const target = pos.board.get(move.to);
    const isEnPassant =
        movingPiece?.role === "pawn" && pos.epSquare === move.to && target === undefined;
    // Castling is encoded as king-takes-own-rook; that is not a capture.
    const isCapture =
        isEnPassant || (target !== undefined && target.color === opposite(mover) && !!movingPiece);

    const after = pos.clone();
    after.play(move as Move);
    const isCheck = after.isCheck();
    const isMateInOne = after.isCheckmate();

    let capturesHanging = false;
    if (isCapture && !isEnPassant) {
        const defenders = pos.kingAttackers(move.to, opposite(mover), pos.board.occupied);
        capturesHanging = defenders.isEmpty();
    }
    const isRecapture = isCapture && !!lastMove && lastMove.capture && lastMove.to === move.to;

    return {
        isCapture,
        isCheck,
        isRecapture,
        capturesHanging,
        isMateInOne,
        isPromotion: move.promotion !== undefined,
    };
}

/**
 * Depth estimate for the final-search-only data `analyzeGame` gives us:
 * a forced mate in n is visible at 2n − 1 plies, a recapture / a capture of
 * a hanging piece / a promotion at 1, a capture or check at 2–3, a quiet
 * move is unknown (`null`).
 */
export function estimateDepthFound(
    f: Partial<MoveFeatures> | null,
    mateIn: number | null,
): number | null {
    if (mateIn !== null && mateIn > 0) return Math.max(1, 2 * mateIn - 1);
    if (!f) return null;
    if (f.isMateInOne) return 1;
    if (f.isRecapture || f.capturesHanging || f.isPromotion) return 1;
    if (f.isCapture && f.isCheck) return 2;
    if (f.isCapture) return 3;
    if (f.isCheck) return 3;
    return null;
}
