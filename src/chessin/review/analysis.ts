import { type Chess, type Move, parseUci, type Square } from "chessops";
import { makeSan } from "chessops/san";
import type { BestMoves, MoveAnalysis } from "@/bindings";
import { isSameUci, toStandardUci } from "@/chessin/board/uci";
import { positionFromFen } from "@/utils/chessops";
import { getGamePhases } from "@/utils/phase";
import { getAccuracy, normalizeScore } from "@/utils/score";
import { describeMove, estimateDepthFound, scoreFindability } from "./findability";
import {
    type Alternative,
    BLUNDER_DROP,
    cpForColor,
    cpToScoreValue,
    expectedScore,
    fenToEpd,
    INACCURACY_DROP,
    isTimePressure,
    type KeyMoment,
    MATE_CP,
    MAX_MOMENTS,
    MAX_ONLY_MOVES,
    MISTAKE_DROP,
    type MomentKind,
    ONLY_MOVE_GAP,
    type Phase,
    type PhaseStats,
    type PlayerColor,
    type PlyEval,
    type Review,
    REVIEW_VERSION,
    type ReviewHeaders,
    type ReviewPreset,
    scoreToCp,
} from "./model";

/**
 * Pure part of the review: engine output + the main line → `Review`.
 * `reviewGame.ts` fetches the inputs (tree, engine, cache) and stores the result.
 */

export type ReviewPosition = {
    /** Position `i` of the main line; `positions[0]` is the root. */
    fen: string;
    /** Move that led to this position (`null` for the root). */
    san: string | null;
    uci: string | null;
    nodeId?: string;
    /** Seconds left for the mover after the move. */
    clock?: number;
};

export type BuildReviewInput = {
    gameKey: string;
    engine: string;
    depth: number;
    playerColor: PlayerColor | null;
    preset: ReviewPreset;
    positions: ReviewPosition[];
    /**
     * `analysis[i]` evaluates `positions[i]`. Like `analyzeGame`, entries for
     * terminal positions may be missing (empty `best`) or the array may be
     * shorter than `positions`.
     */
    analysis: (MoveAnalysis | undefined)[];
    createdAt?: number;
    headers?: ReviewHeaders;
};

type Eval = { cp: number; depth: number; best: BestMoves[] };

/** Evaluation of a position: engine lines when present, else the game result. */
function evalOf(
    pos: Chess | null,
    analysis: MoveAnalysis | undefined,
    previous: Eval | null,
): Eval {
    const best = analysis?.best ?? [];
    if (best.length > 0) {
        return { cp: scoreToCp(best[0].score.value), depth: best[0].depth, best };
    }
    if (pos) {
        if (pos.isCheckmate())
            return { cp: pos.turn === "white" ? -MATE_CP : MATE_CP, depth: 0, best };
        if (pos.isStalemate() || pos.isInsufficientMaterial()) return { cp: 0, depth: 0, best };
    }
    return { cp: previous?.cp ?? 0, depth: 0, best };
}

function harmonicMean(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, v) => acc + 1 / Math.max(v, 1e-6), 0);
    return values.length / sum;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(x: number, digits = 4): number {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

function safeSan(pos: Chess, uci: string): string {
    const move = parseUci(uci);
    if (!move) return uci;
    try {
        return makeSan(pos, move as Move);
    } catch {
        return uci;
    }
}

/** Mate distance of the best line in `best` (plies / 2, rounded up), or null. */
function mateIn(best: BestMoves | undefined): number | null {
    const value = best?.score.value;
    if (!value || value.type !== "mate" || value.value === 0) return null;
    return Math.abs(value.value);
}

export function phaseAt(
    ply: number,
    middlegamePly: number | null,
    endgamePly: number | null,
): Phase {
    if (middlegamePly === null || ply < middlegamePly) return "opening";
    if (endgamePly === null || ply < endgamePly) return "middlegame";
    return "endgame";
}

function kindFor(
    drop: number,
    before: number,
    after: number,
    gap: number | null,
    playedBest: boolean,
    timePressure: boolean,
): MomentKind | null {
    if (drop >= BLUNDER_DROP) {
        if (before >= 0.75 && after <= 0.55) return "missed_win";
        if (before >= 0.25 && before < 0.45 && after <= 0.15) return "missed_draw";
        return "blunder";
    }
    if (drop >= MISTAKE_DROP) return timePressure ? "time_pressure" : "mistake";
    if (playedBest && gap !== null && gap >= ONLY_MOVE_GAP) return "only_move";
    return null;
}

export function buildReview(input: BuildReviewInput): Review {
    const { positions, analysis, playerColor } = input;
    const boards: (Chess | null)[] = positions.map((p) => positionFromFen(p.fen)[0]);
    const evals: Eval[] = [];
    for (let i = 0; i < positions.length; i++) {
        evals.push(evalOf(boards[i], analysis[i], evals[i - 1] ?? null));
    }

    const validBoards = boards.filter((b): b is Chess => b !== null);
    const { middlegamePly, endgamePly } = getGamePhases(validBoards);

    const reviewed = (color: PlayerColor) => playerColor === null || color === playerColor;
    const firstClock: Partial<Record<PlayerColor, number>> = {};

    const plies: PlyEval[] = [];
    const candidates: KeyMoment[] = [];
    const cpLosses: Record<PlayerColor, number[]> = { white: [], black: [] };
    const accuracies: Record<PlayerColor, number[]> = { white: [], black: [] };
    const phaseLoss: Record<Phase, number> = { opening: 0, middlegame: 0, endgame: 0 };
    let blunders = 0;
    let mistakes = 0;
    let inaccuracies = 0;
    const timePressureMoves: number[] = [];

    for (let ply = 1; ply < positions.length; ply++) {
        const position = positions[ply];
        const before = boards[ply - 1];
        const uciRaw = position.uci;
        if (!before || !uciRaw) continue;
        const color: PlayerColor = before.turn;
        const uci = toStandardUci(before, uciRaw);
        const san = position.san ?? safeSan(before, uci);
        const evalBefore = evals[ply - 1];
        const evalAfter = evals[ply];
        const best0 = evalBefore.best[0];
        const bestUci = best0 ? toStandardUci(before, best0.uciMoves[0] ?? uci) : uci;
        const bestPv = best0 ? best0.uciMoves.map((m) => toStandardUci(before, m)) : [];

        const expBefore = expectedScore(evalBefore.cp, color);
        const expAfter = expectedScore(evalAfter.cp, color);
        // The engine's own best move is never a mistake, whatever the next
        // search says (horizon effects, depth differences between positions).
        const playedBest = best0 ? isSameUci(before, uci, bestUci) : false;
        const drop = playedBest ? 0 : round(Math.max(0, expBefore - expAfter));
        const cpLoss = playedBest
            ? 0
            : Math.max(
                  0,
                  normalizeScore(cpToScoreValue(evalBefore.cp), color) -
                      normalizeScore(cpToScoreValue(evalAfter.cp), color),
              );

        if (position.clock !== undefined && firstClock[color] === undefined) {
            firstClock[color] = position.clock;
        }
        const timePressure = isTimePressure(position.clock, firstClock[color]);
        const phase = phaseAt(ply - 1, middlegamePly, endgamePly);

        plies.push({
            ply,
            san,
            uci,
            fenBefore: positions[ply - 1].fen,
            epd: fenToEpd(positions[ply - 1].fen),
            color,
            score: evalAfter.cp,
            bestUci,
            bestScore: evalBefore.cp,
            winChanceDrop: drop,
            cpLoss,
            clock: position.clock,
            depth: evalBefore.depth,
        });

        cpLosses[color].push(cpLoss);
        accuracies[color].push(
            getAccuracy(cpToScoreValue(evalBefore.cp), cpToScoreValue(evalAfter.cp), color),
        );

        if (!reviewed(color)) continue;
        phaseLoss[phase] += cpLoss / 100;
        if (drop >= BLUNDER_DROP) blunders++;
        else if (drop >= MISTAKE_DROP) mistakes++;
        else if (drop >= INACCURACY_DROP) inaccuracies++;
        if (timePressure && drop >= INACCURACY_DROP) timePressureMoves.push(ply);

        // --- key moment candidate -------------------------------------------
        const alternatives: Alternative[] = evalBefore.best.slice(1).map((line) => ({
            uci: toStandardUci(before, line.uciMoves[0] ?? ""),
            san: line.sanMoves[0] ?? safeSan(before, line.uciMoves[0] ?? ""),
            score: scoreToCp(line.score.value),
        }));
        const gap =
            alternatives.length > 0
                ? round(Math.max(0, expBefore - expectedScore(alternatives[0].score, color)))
                : null;
        const kind = kindFor(drop, expBefore, expAfter, gap, playedBest, timePressure);
        if (!kind) continue;
        if (input.preset === "blunder_check" && drop < BLUNDER_DROP) continue;

        const lastMove = plies.length >= 2 ? plies[plies.length - 2] : null;
        const lastMoveInfo =
            lastMove && lastMove.ply === ply - 1
                ? {
                      to: (parseUci(lastMove.uci) as { to: Square } | undefined)?.to ?? 0,
                      capture: lastMove.san.includes("x"),
                  }
                : null;
        const features = describeMove(before, bestUci, lastMoveInfo);
        const findability = round(
            scoreFindability({
                ...(features ?? {}),
                gap,
                depthFound: estimateDepthFound(features, mateIn(best0)),
                maxDepth: Math.max(1, evalBefore.depth || input.depth),
            }),
        );
        const priority =
            kind === "only_move"
                ? round(0.5 * (gap ?? 0) * findability)
                : round(drop * findability);

        candidates.push({
            id: `${input.gameKey}#${ply}`,
            ply,
            nodeId: position.nodeId,
            fenBefore: positions[ply - 1].fen,
            playedUci: uci,
            playedSan: san,
            bestUci,
            bestSan: best0?.sanMoves[0] ?? safeSan(before, bestUci),
            bestPv,
            alternatives,
            drop,
            findability,
            priority,
            phase,
            kind,
            color,
            clock: position.clock,
        });
    }

    candidates.sort((a, b) => b.priority - a.priority || a.ply - b.ply);
    const moments: KeyMoment[] = [];
    let onlyMoves = 0;
    for (const m of candidates) {
        if (m.kind === "only_move") {
            if (onlyMoves >= MAX_ONLY_MOVES) continue;
            onlyMoves++;
        }
        moments.push(m);
        if (moments.length >= MAX_MOMENTS) break;
    }

    const lastPly = Math.max(0, positions.length - 1);
    const phases: Record<Phase, PhaseStats> = {
        opening: { endPly: middlegamePly ?? lastPly, loss: round(phaseLoss.opening, 2) },
        middlegame: {
            endPly: middlegamePly === null ? lastPly : (endgamePly ?? lastPly),
            loss: round(phaseLoss.middlegame, 2),
        },
        endgame: { endPly: lastPly, loss: round(phaseLoss.endgame, 2) },
    };

    return {
        version: REVIEW_VERSION,
        gameKey: input.gameKey,
        engine: input.engine,
        depth: input.depth,
        createdAt: input.createdAt ?? Date.now(),
        playerColor,
        preset: input.preset,
        headers: input.headers,
        plies,
        moments,
        phases,
        summary: {
            accuracy: {
                white: round(harmonicMean(accuracies.white), 1),
                black: round(harmonicMean(accuracies.black), 1),
            },
            cpl: { white: round(mean(cpLosses.white), 1), black: round(mean(cpLosses.black), 1) },
            blunders,
            mistakes,
            inaccuracies,
            timePressureMoves,
        },
    };
}

/** Inputs for S2-4's `explainMoment` (scores from the mover's point of view). */
export function explainInputFor(moment: KeyMoment, plies: PlyEval[]) {
    const ply = plies.find((p) => p.ply === moment.ply);
    const color = moment.color;
    const scoreBefore = ply ? cpForColor(ply.bestScore, color) : 0;
    const scoreAfterPlayed = ply ? cpForColor(ply.score, color) : 0;
    const previous = plies.find((p) => p.ply === moment.ply - 2);
    return {
        fenBefore: moment.fenBefore,
        playedUci: moment.playedUci,
        bestUci: moment.bestUci,
        bestPv: moment.bestPv,
        scoreBefore,
        scoreAfterPlayed,
        scoreAfterBest: scoreBefore,
        playerColor: color,
        clockBefore: previous?.clock,
        clockAfter: moment.clock,
    };
}
