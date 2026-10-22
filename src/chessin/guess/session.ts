import { makeUci, parseUci } from "chessops";
import { makeSan } from "chessops/san";
import { toStandardUci } from "@/chessin/board/uci";
import type { Explanation } from "@/chessin/explain";
import { fenToEpd, type KeyMoment, type PlayerColor, type Review } from "@/chessin/review/model";
import { putDoc } from "@/chessin/store/libraryStore";
import { positionFromFen } from "@/utils/chessops";
import { type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import {
    acceptedMoves,
    candidatesFromReview,
    type GuessCandidate,
    type GuessGrade,
    gradeGuess,
    MAX_GRADE,
} from "./scoring";

/**
 * Guess-the-move session (S4-6): a pure state machine over the main line of
 * a game tree. The player's plies (from `from` on) become targets; each is
 * answered once on a `FindMoveBoard`, graded (see `scoring.ts`), revealed and
 * stepped past. Results are stored as library documents of kind
 * `guess_result`, id `"guess:" + gameKey + ":" + finishedAt`.
 *
 * The session object is immutable: every transition returns a new one, so it
 * can live in a jotai atom and be driven from React and from palette commands.
 */

export const GUESS_SESSION_VERSION = 1 as const;
export const GUESS_RESULT_KIND = "guess_result";
export const GUESS_RESULT_PREFIX = "guess:";

export type GuessTarget = {
    /** 1-based half-move index of the played move in the main line. */
    ply: number;
    /** Side that played the move (= the session's player colour). */
    color: PlayerColor;
    fenBefore: string;
    /** Standard UCI of the played move. */
    playedUci: string;
    playedSan: string;
    /** Tree path of the main-line node after the played move; `parentPath` is the position before it. */
    path: number[];
    parentPath: number[];
    nodeId: string;
    /** Engine data when the review covers this ply (and its position still matches the tree). */
    bestUci: string | null;
    bestSan: string | null;
    bestPv: string[];
    /** White-view cp: evaluation of `fenBefore` (= after the best move) and after the played move. */
    scores: { afterBest: number; afterPlayed: number } | null;
    candidates: GuessCandidate[];
    /** Moves the board accepts (played + within tolerance of best). */
    answers: string[];
    moment: KeyMoment | null;
    /** Explanations from the review's key moment, when it has them. */
    explanations: Explanation[];
};

export type GuessStep = {
    ply: number;
    /** The player's guess (standard UCI), null when revealed without guessing. */
    guess: string | null;
    grade: GuessGrade;
    revealed: boolean;
};

export type GuessSession = {
    version: typeof GUESS_SESSION_VERSION;
    gameKey: string | null;
    playerColor: PlayerColor;
    /** True when a review supplied engine data for at least one target. */
    hasReview: boolean;
    from: number;
    targets: GuessTarget[];
    /** One entry per answered-or-revealed target, in order. */
    steps: GuessStep[];
    /** Index of the current target; `targets.length` once every target is done. */
    index: number;
    startedAt: number;
    finishedAt: number | null;
};

export type GuessTotals = {
    /** Targets answered or revealed so far. */
    answered: number;
    /** Guesses the board accepted (grade ≥ 1). */
    correct: number;
    points: number;
    /** Points available for the targets answered so far. */
    maxSoFar: number;
    /** Points available for the whole session. */
    max: number;
    total: number;
};

export type GuessResult = {
    version: typeof GUESS_SESSION_VERSION;
    gameKey: string;
    playerColor: PlayerColor;
    hasReview: boolean;
    from: number;
    startedAt: number;
    finishedAt: number;
    total: number;
    answered: number;
    correct: number;
    points: number;
    max: number;
    steps: (GuessStep & { playedUci: string; bestUci: string | null })[];
};

export type CreateGuessSessionInput = {
    review?: Review | null;
    tree: { root: TreeNode };
    playerColor: PlayerColor;
    /** First ply to ask about (1-based half-move); earlier plies are skipped. Defaults to 1. */
    from?: number;
    gameKey?: string | null;
    now?: number;
};

export function colorOfPly(ply: number): PlayerColor {
    return ply % 2 === 1 ? "white" : "black";
}

function sanOf(fen: string, uci: string): string {
    const [pos] = positionFromFen(fen);
    const move = parseUci(uci);
    if (!pos || !move || !("from" in move) || !pos.isLegal(move)) return uci;
    try {
        return makeSan(pos, move);
    } catch {
        return uci;
    }
}

/** Builds the targets from the tree's main line, enriched with the review where its positions still match. */
export function createGuessSession(input: CreateGuessSessionInput): GuessSession {
    const { review, tree, playerColor } = input;
    const from = Math.max(1, Math.floor(input.from ?? 1));
    const now = input.now ?? Date.now();
    const plyByIndex = new Map(review?.plies.map((p) => [p.ply, p] as const) ?? []);
    const momentsByPly = new Map<number, KeyMoment>();
    for (const m of review?.moments ?? []) {
        if (!momentsByPly.has(m.ply)) momentsByPly.set(m.ply, m);
    }

    const targets: GuessTarget[] = [];
    let hasReview = false;
    let previous: { fen: string; path: number[] } | null = null;
    let ply = 0;
    for (const { node, position } of treeIteratorMainLine(tree.root)) {
        if (node.move && previous) {
            ply += 1;
            const color = colorOfPly(ply);
            if (color === playerColor && ply >= from) {
                const fenBefore = previous.fen;
                const [pos] = positionFromFen(fenBefore);
                const rawUci = makeUci(node.move);
                const playedUci = pos ? toStandardUci(pos, rawUci) : rawUci;
                const playedSan = node.san ?? sanOf(fenBefore, playedUci);

                const evalPly = plyByIndex.get(ply);
                const matches = !!evalPly && fenToEpd(evalPly.fenBefore) === fenToEpd(fenBefore);
                const moment = matches ? (momentsByPly.get(ply) ?? null) : null;
                const momentMatches =
                    moment !== null && fenToEpd(moment.fenBefore) === fenToEpd(fenBefore);
                const usedMoment = momentMatches ? moment : null;
                const candidates =
                    matches && evalPly
                        ? candidatesFromReview(evalPly, color, usedMoment, (u) =>
                              sanOf(fenBefore, u),
                          )
                        : [];
                const bestUci = matches && evalPly ? evalPly.bestUci || null : null;
                if (bestUci) hasReview = true;
                const target: GuessTarget = {
                    ply,
                    color,
                    fenBefore,
                    playedUci,
                    playedSan,
                    path: position,
                    parentPath: previous.path,
                    nodeId: node.id,
                    bestUci,
                    bestSan: bestUci
                        ? ((usedMoment?.bestUci === bestUci ? usedMoment.bestSan : null) ??
                          candidates.find((c) => c.uci === bestUci)?.san ??
                          sanOf(fenBefore, bestUci))
                        : null,
                    bestPv: usedMoment?.bestPv.length
                        ? usedMoment.bestPv
                        : bestUci
                          ? [bestUci]
                          : [],
                    scores:
                        matches && evalPly
                            ? { afterBest: evalPly.bestScore, afterPlayed: evalPly.score }
                            : null,
                    candidates,
                    answers: [],
                    moment: usedMoment,
                    explanations: usedMoment?.explanations ?? [],
                };
                target.answers = acceptedMoves(target);
                targets.push(target);
            }
        }
        previous = { fen: node.fen, path: position };
    }

    return {
        version: GUESS_SESSION_VERSION,
        gameKey: input.gameKey ?? review?.gameKey ?? null,
        playerColor,
        hasReview,
        from,
        targets,
        steps: [],
        index: 0,
        startedAt: now,
        finishedAt: targets.length === 0 ? now : null,
    };
}

export function isFinished(session: GuessSession): boolean {
    return session.index >= session.targets.length;
}

/** The target being asked about, or null when the session is over. */
export function currentTarget(session: GuessSession): GuessTarget | null {
    return session.targets[session.index] ?? null;
}

/** The step recorded for the current target (answered or revealed), or null while still guessing. */
export function currentStep(session: GuessSession): GuessStep | null {
    const target = currentTarget(session);
    if (!target) return null;
    const step = session.steps[session.index];
    return step && step.ply === target.ply ? step : null;
}

function record(session: GuessSession, step: GuessStep): GuessSession {
    const steps = session.steps.slice(0, session.index);
    steps.push(step);
    return { ...session, steps };
}

/** Grades and records the guess for the current target (one guess per target; later guesses are ignored). */
export function answerGuess(session: GuessSession, uci: string): GuessSession {
    const target = currentTarget(session);
    if (!target || currentStep(session)) return session;
    const grade = gradeGuess(target, uci);
    return record(session, { ply: target.ply, guess: uci, grade, revealed: true });
}

/** "揭晓" without a guess: scores 0 and shows the answer. No-op when already answered. */
export function revealCurrent(session: GuessSession): GuessSession {
    const target = currentTarget(session);
    if (!target || currentStep(session)) return session;
    return record(session, { ply: target.ply, guess: null, grade: 0, revealed: true });
}

/** Moves to the next target once the current one is revealed; marks the session finished after the last. */
export function nextTarget(session: GuessSession, now = Date.now()): GuessSession {
    if (isFinished(session)) return session;
    if (!currentStep(session)?.revealed) return session;
    const index = session.index + 1;
    const finished = index >= session.targets.length;
    return { ...session, index, finishedAt: finished ? (session.finishedAt ?? now) : null };
}

/** Reveals the current target when it is still open, otherwise steps to the next one. */
export function revealOrNext(session: GuessSession, now = Date.now()): GuessSession {
    if (isFinished(session)) return session;
    return currentStep(session) ? nextTarget(session, now) : revealCurrent(session);
}

/** Stops early: what was answered stays, the remaining targets are dropped from the totals. */
export function finishSession(session: GuessSession, now = Date.now()): GuessSession {
    if (session.finishedAt !== null) return session;
    const answered = session.steps.length;
    return {
        ...session,
        targets: session.targets.slice(0, answered),
        index: answered,
        finishedAt: now,
    };
}

export function guessTotals(session: GuessSession): GuessTotals {
    let correct = 0;
    let points = 0;
    for (const step of session.steps) {
        if (step.grade >= 1) correct += 1;
        points += step.grade;
    }
    return {
        answered: session.steps.length,
        correct,
        points,
        maxSoFar: session.steps.length * MAX_GRADE,
        max: session.targets.length * MAX_GRADE,
        total: session.targets.length,
    };
}

export function guessResultDocId(gameKey: string, finishedAt: number): string {
    return `${GUESS_RESULT_PREFIX}${gameKey}:${finishedAt}`;
}

/** The stored shape of a finished session; null when nothing was answered or the game has no key. */
export function toGuessResult(session: GuessSession, now = Date.now()): GuessResult | null {
    if (!session.gameKey || session.steps.length === 0) return null;
    const totals = guessTotals(session);
    const byPly = new Map(session.targets.map((t) => [t.ply, t] as const));
    return {
        version: GUESS_SESSION_VERSION,
        gameKey: session.gameKey,
        playerColor: session.playerColor,
        hasReview: session.hasReview,
        from: session.from,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt ?? now,
        total: totals.total,
        answered: totals.answered,
        correct: totals.correct,
        points: totals.points,
        max: totals.max,
        steps: session.steps.map((s) => ({
            ...s,
            playedUci: byPly.get(s.ply)?.playedUci ?? "",
            bestUci: byPly.get(s.ply)?.bestUci ?? null,
        })),
    };
}

/** Writes the `guess_result` document. Returns the stored result, or null when there was nothing to store. */
export async function saveGuessResult(
    session: GuessSession,
    title: string,
    now = Date.now(),
): Promise<GuessResult | null> {
    const result = toGuessResult(session, now);
    if (!result) return null;
    await putDoc({
        id: guessResultDocId(result.gameKey, result.finishedAt),
        kind: GUESS_RESULT_KIND,
        title,
        origin: result.gameKey,
        data: JSON.stringify(result),
    });
    return result;
}

/** Structural check for a stored `guess_result` payload. */
export function isGuessResult(value: unknown): value is GuessResult {
    if (!value || typeof value !== "object") return false;
    const r = value as Partial<GuessResult>;
    return (
        r.version === GUESS_SESSION_VERSION &&
        typeof r.gameKey === "string" &&
        typeof r.points === "number" &&
        Array.isArray(r.steps)
    );
}
