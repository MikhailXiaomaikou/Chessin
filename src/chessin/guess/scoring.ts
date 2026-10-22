import { canonicalUci } from "@/chessin/board/uci";
import {
    expectedScore,
    type KeyMoment,
    type PlayerColor,
    type PlyEval,
} from "@/chessin/review/model";
import { positionFromFen } from "@/utils/chessops";

/**
 * Guess-the-move scoring (S4-6).
 *
 * Every guess is graded against the game's review when there is one:
 *
 * | points | rule                                                                     |
 * | ------ | ------------------------------------------------------------------------ |
 * | 3      | the guess is the engine's best move                                      |
 * | 2      | not the best, but its expected score is within `GUESS_TOLERANCE` (0.05)  |
 * |        | of the best — includes the played move when it was nearly best           |
 * | 1      | the guess is the move actually played, which the engine rates worse      |
 * | 0      | anything else, or "揭晓" without a guess                                  |
 *
 * Without a review there is no engine data: the played move is the only
 * answer and scores 3, everything else 0 (the panel suggests reviewing the
 * game first for finer grading).
 *
 * Expected scores are 0..1 from the mover's point of view (`expectedScore`
 * of the review model), comparisons of moves are castling-spelling agnostic.
 */

export const GUESS_TOLERANCE = 0.05;

export type GuessGrade = 0 | 1 | 2 | 3;

export const MAX_GRADE: GuessGrade = 3;

export type GuessCandidate = {
    /** Standard UCI. */
    uci: string;
    san: string;
    /** Expected score 0..1 for the mover after this move. */
    expected: number;
};

export type GuessScoringTarget = {
    fenBefore: string;
    /** Standard UCI of the move played in the game. */
    playedUci: string;
    /** The engine's best move when a review covers the ply, else null. */
    bestUci: string | null;
    /** Moves with a known expected score (best, played, alternatives); empty without a review. */
    candidates: GuessCandidate[];
};

/** Castling-agnostic comparison of two UCI moves in `fen`. */
export function sameMove(fen: string, a: string, b: string): boolean {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (x === y) return true;
    const [pos] = positionFromFen(fen);
    if (!pos) return false;
    const ca = canonicalUci(pos, x);
    return ca !== null && ca === canonicalUci(pos, y);
}

function findCandidate(target: GuessScoringTarget, uci: string): GuessCandidate | undefined {
    return target.candidates.find((c) => sameMove(target.fenBefore, c.uci, uci));
}

/** Expected score of the best move, when the review knows it. */
export function bestExpected(target: GuessScoringTarget): number | null {
    if (!target.bestUci) return null;
    return findCandidate(target, target.bestUci)?.expected ?? null;
}

/** True when `uci` is rated within `tolerance` of the best move (the best move itself included). */
export function isWithinTolerance(
    target: GuessScoringTarget,
    uci: string,
    tolerance = GUESS_TOLERANCE,
): boolean {
    const best = bestExpected(target);
    if (best === null) return false;
    const candidate = findCandidate(target, uci);
    if (!candidate) return false;
    return best - candidate.expected <= tolerance + 1e-9;
}

/**
 * Moves the board accepts as "correct": the played move first, then the best
 * move and every candidate within tolerance of it. De-duplicated
 * (castling-spelling agnostic), standard UCI as given by the candidates.
 */
export function acceptedMoves(target: GuessScoringTarget, tolerance = GUESS_TOLERANCE): string[] {
    const out: string[] = [target.playedUci];
    const push = (uci: string) => {
        if (!out.some((o) => sameMove(target.fenBefore, o, uci))) out.push(uci);
    };
    if (target.bestUci) push(target.bestUci);
    for (const c of target.candidates) {
        if (isWithinTolerance(target, c.uci, tolerance)) push(c.uci);
    }
    return out;
}

/** Grades one guess; see the module comment for the rules. */
export function gradeGuess(
    target: GuessScoringTarget,
    uci: string | null,
    tolerance = GUESS_TOLERANCE,
): GuessGrade {
    if (!uci) return 0;
    const played = sameMove(target.fenBefore, target.playedUci, uci);
    if (!target.bestUci) return played ? 3 : 0;
    if (sameMove(target.fenBefore, target.bestUci, uci)) return 3;
    if (isWithinTolerance(target, uci, tolerance)) return 2;
    return played ? 1 : 0;
}

/** Translation key of a grade's label. */
export function gradeLabelKey(grade: GuessGrade): string {
    // t("Guess.Grade.0") t("Guess.Grade.1") t("Guess.Grade.2") t("Guess.Grade.3")
    return `Guess.Grade.${grade}`;
}

/**
 * Candidates with known expected scores for a reviewed ply: the engine's
 * best move (`bestScore`), the played move (`score`) and, when the review
 * flagged the ply as a key moment, its alternatives. `sanOf` resolves SAN
 * for moves the review stores as UCI only.
 */
export function candidatesFromReview(
    ply: PlyEval,
    color: PlayerColor,
    moment: KeyMoment | null | undefined,
    sanOf: (uci: string) => string,
): GuessCandidate[] {
    const out: GuessCandidate[] = [];
    const add = (uci: string, san: string | null, cp: number) => {
        if (!uci) return;
        if (out.some((c) => sameMove(ply.fenBefore, c.uci, uci))) return;
        out.push({ uci, san: san ?? sanOf(uci), expected: expectedScore(cp, color) });
    };
    add(ply.bestUci, moment?.bestUci === ply.bestUci ? moment.bestSan : null, ply.bestScore);
    add(ply.uci, ply.san, ply.score);
    if (moment) {
        for (const alt of moment.alternatives) add(alt.uci, alt.san, alt.score);
    }
    return out;
}
