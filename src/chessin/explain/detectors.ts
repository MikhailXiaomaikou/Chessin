/**
 * X-1 v0 detectors: pure functions over chessops positions that turn one key
 * moment (position, played move, best move, scores) into template-ready
 * explanations. No engine, no network, no LLM.
 *
 * Evidence levels (contract S2-4):
 * - "certain"   — mechanical facts: mate lines we replayed, absolute pins, clock.
 * - "likely"    — SEE / threat based: hanging pieces, forks, skewers, engine mate scores.
 * - "heuristic" — activity and structure: trades, king shelter, passed pawns,
 *                 development, tempo.
 */
import {
    attacks,
    type Chess,
    type Color,
    makeSquare,
    type NormalMove,
    opposite,
    type Role,
    type Square,
    squareRank,
} from "chessops";
import {
    absolutePins,
    attackersTo,
    capturedValue,
    developmentOf,
    fenOf,
    findForks,
    forcedMate,
    forkOf,
    type Fork,
    givesCheck,
    hasAttackingForce,
    isBackRankMate,
    isCapture,
    isCastling,
    isCentralSquare,
    isOpening,
    isRimSquare,
    kingShelter,
    legalCapturers,
    materialBalance,
    passedPawns,
    pawnAdvancement,
    pieceValue,
    pinsCreated,
    playMove,
    playUci,
    positionFrom,
    sanOf,
    see,
    skewerBy,
    squareInFront,
    uciOf,
    undevelopedMinors,
    winningCaptures,
} from "./board";
import type { DemoArrow, EvidenceLevel, Explanation, ExplainInput, Severity } from "./types";

/** Scores at or beyond this magnitude are treated as mate (S2-3 stores mate as ±10000). */
export const MATE_SCORE = 9000;

/** Lichess win-chance curve; same formula as `getWinChance` in `src/utils/score.ts`. */
export const winChance = (cp: number): number =>
    50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export type DetectorContext = {
    input: ExplainInput;
    before: Chess;
    mover: Color;
    them: Color;
    played: NormalMove;
    afterPlayed: Chess;
    playedSan: string;
    best: NormalMove | null;
    afterBest: Chess | null;
    bestSan: string;
    /** validated prefix of the PV (legal from `before`) */
    pv: NormalMove[];
    /** position at the end of the validated PV */
    pvEnd: Chess | null;
    /** cp from the mover's point of view */
    score: { before: number; afterPlayed: number; afterBest: number };
    /** expected-score drop 0..1 (best vs played) */
    drop: number;
};

export type Detector = (ctx: DetectorContext) => Explanation[];

export function buildContext(input: ExplainInput): DetectorContext | null {
    const before = positionFrom(input.fenBefore);
    if (!before) return null;
    const playedResult = playUci(before, input.playedUci);
    if (!playedResult) return null;
    const bestResult = input.bestUci ? playUci(before, input.bestUci) : null;

    const pvSource = input.bestPv.length > 0 ? input.bestPv : input.bestUci ? [input.bestUci] : [];
    const pv: NormalMove[] = [];
    let pos = before;
    for (const uci of pvSource) {
        const step = playUci(pos, uci);
        if (!step) break;
        pv.push(step.move);
        pos = step.pos;
    }

    const mover = before.turn;
    const sign = input.scoreView === "white" && mover === "black" ? -1 : 1;
    const score = {
        before: sign * input.scoreBefore,
        afterPlayed: sign * input.scoreAfterPlayed,
        afterBest: sign * input.scoreAfterBest,
    };
    const drop = Math.max(0, (winChance(score.afterBest) - winChance(score.afterPlayed)) / 100);

    return {
        input,
        before,
        mover,
        them: opposite(mover),
        played: playedResult.move,
        afterPlayed: playedResult.pos,
        playedSan: sanOf(before, playedResult.move),
        best: bestResult?.move ?? null,
        afterBest: bestResult?.pos ?? null,
        bestSan: bestResult ? sanOf(before, bestResult.move) : input.bestUci,
        pv,
        pvEnd: pv.length > 0 ? pos : null,
        score,
        drop,
    };
}

// ---------------------------------------------------------------------------
// helpers

const sq = makeSquare;

const severityOf = (role: Role): Severity =>
    role === "pawn" ? 1 : role === "queen" || role === "rook" || role === "king" ? 3 : 2;

const arrow = (orig: Square, dest: Square, brush: "green" | "red" | "blue"): DemoArrow => ({
    orig: sq(orig),
    dest: sq(dest),
    brush,
});

function make(
    ctx: DetectorContext,
    id: string,
    evidence: EvidenceLevel,
    severity: Severity,
    params: Record<string, string | number>,
    demo?: Explanation["demo"],
): Explanation {
    const base: Record<string, string | number> = { played: ctx.playedSan, best: ctx.bestSan };
    const merged = { ...base, ...params };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return { id, evidence, severity, params: merged, ...(demo ? { demo } : {}) };
}

const encodeTargets = (targets: Fork["targets"]): string =>
    targets.map((t) => `${t.piece.role}@${sq(t.square)}`).join(";");

/** An executed even trade of pieces (capture, SEE = 0, victim worth a minor or more). */
function tradedPiece(pos: Chess, move: NormalMove): Role | null {
    const victim = pos.board.getRole(move.to);
    if (victim && pieceValue(victim) >= 3 && see(pos, move.to, move.from) === 0) return victim;
    // an offer: the moved piece can be taken on even terms
    if (!victim) {
        const mover = pos.board.getRole(move.from);
        if (!mover || pieceValue(mover) < 3 || mover === "king") return null;
        const after = playMove(pos, move);
        if (legalCapturers(after, move.to).nonEmpty() && see(after, move.to) === 0) return mover;
    }
    return null;
}

const relativeRank = (square: Square, color: Color): number =>
    color === "white" ? squareRank(square) : 7 - squareRank(square);

const HOME_SQUARES: Record<Color, Partial<Record<Role, Square[]>>> = {
    white: { knight: [1, 6], bishop: [2, 5], queen: [3] },
    black: { knight: [57, 62], bishop: [58, 61], queen: [59] },
};

const isHomeSquare = (color: Color, role: Role, square: Square): boolean =>
    (HOME_SQUARES[color][role] ?? []).includes(square);

/** `move` captures, blocks or attacks the passed pawn on `pawn` (or the square in front of it). */
function dealsWithPasser(
    pos: Chess,
    move: NormalMove,
    pawn: Square,
    front: Square | undefined,
): boolean {
    if (move.to === pawn || (front !== undefined && move.to === front)) return true;
    const after = playMove(pos, move);
    const piece = after.board.get(move.to);
    if (!piece) return false;
    const reach = attacks(piece, move.to, after.board.occupied);
    return reach.has(pawn) || (front !== undefined && reach.has(front));
}

// ---------------------------------------------------------------------------
// detectors

/** The played move leaves one of our pieces en prise (SEE > 0 for the opponent). */
export const hangingPiece: Detector = (ctx) => {
    const { before, played, afterPlayed, afterBest } = ctx;
    if (afterPlayed.isEnd()) return [];
    const compensation = capturedValue(before, played);
    const bestWins = afterBest ? winningCaptures(afterBest) : [];
    for (const w of winningCaptures(afterPlayed)) {
        if (w.gain - compensation <= 0) continue;
        const alsoAfterBest = bestWins.some(
            (b) => b.square === w.square && b.piece.role === w.piece.role && b.gain >= w.gain,
        );
        if (alsoAfterBest) continue;
        const moved = w.square === played.to;
        const variant: Record<string, string> = w.undefended
            ? moved
                ? {}
                : { variant: "left" }
            : { variant: "weak" };
        return [
            make(
                ctx,
                "hanging_piece",
                "likely",
                severityOf(w.piece.role),
                { piece: w.piece.role, square: sq(w.square), value: w.gain, ...variant },
                {
                    fen: fenOf(afterPlayed),
                    line: [uciOf({ from: w.attacker, to: w.square })],
                    arrows: [arrow(w.attacker, w.square, "red")],
                },
            ),
        ];
    }
    return [];
};

/** The best move wins a piece that was hanging; the played move did not take it. */
export const missedHangingPiece: Detector = (ctx) => {
    const { before, best, played } = ctx;
    if (!best || !isCapture(before, best)) return [];
    const victim = before.board.get(best.to);
    if (!victim) return [];
    const gain = see(before, best.to, best.from);
    if (gain <= 0) return [];
    if (
        played.to === best.to &&
        isCapture(before, played) &&
        see(before, played.to, played.from) >= gain
    ) {
        return [];
    }
    const undefended = attackersTo(
        before.board,
        best.to,
        victim.color,
        before.board.occupied.without(best.from),
    ).isEmpty();
    const variant: Record<string, string> = undefended ? {} : { variant: "weak" };
    return [
        make(
            ctx,
            "missed_hanging_piece",
            "likely",
            severityOf(victim.role),
            { piece: victim.role, square: sq(best.to), value: gain, ...variant },
            {
                fen: fenOf(before),
                line: [uciOf(best)],
                arrows: [arrow(best.from, best.to, "green")],
            },
        ),
    ];
};

const forkMatters = (f: Fork): boolean =>
    f.targets.some((t) => t.piece.role === "king" || pieceValue(t.piece.role) >= 3);

const forkSeverity = (f: Fork): Severity =>
    f.targets.some((t) => t.piece.role === "king" || t.piece.role === "queen") ? 3 : 2;

const forkWorth = (f: Fork): number =>
    f.targets.reduce((s, t) => s + (t.piece.role === "king" ? 50 : pieceValue(t.piece.role)), 0);

/** The played move allows a fork, or the best move was one. */
export const fork: Detector = (ctx) => {
    const { before, played, best, afterPlayed, afterBest } = ctx;
    const out: Explanation[] = [];
    if (!afterPlayed.isEnd()) {
        const allowed = findForks(afterPlayed).find(forkMatters);
        if (allowed) {
            const worth = forkWorth(allowed);
            const alsoAfterBest = afterBest
                ? findForks(afterBest).some((f) => forkMatters(f) && forkWorth(f) >= worth)
                : false;
            if (!alsoAfterBest) {
                out.push(
                    make(
                        ctx,
                        "fork",
                        "likely",
                        forkSeverity(allowed),
                        {
                            variant: "allowed",
                            reply: sanOf(afterPlayed, allowed.move),
                            piece: allowed.forker.role,
                            square: sq(allowed.move.to),
                            targets: encodeTargets(allowed.targets),
                        },
                        {
                            fen: fenOf(afterPlayed),
                            line: [uciOf(allowed.move)],
                            arrows: allowed.targets.map((t) =>
                                arrow(allowed.move.to, t.square, "red"),
                            ),
                        },
                    ),
                );
            }
        }
    }
    if (best) {
        const missed = forkOf(before, best);
        if (missed && forkMatters(missed) && !forkOf(before, played)) {
            out.push(
                make(
                    ctx,
                    "fork",
                    "likely",
                    forkSeverity(missed),
                    {
                        variant: "missed",
                        piece: missed.forker.role,
                        square: sq(best.to),
                        targets: encodeTargets(missed.targets),
                    },
                    {
                        fen: fenOf(before),
                        line: [uciOf(best)],
                        arrows: [
                            arrow(best.from, best.to, "green"),
                            ...missed.targets.map((t) => arrow(best.to, t.square, "red")),
                        ],
                    },
                ),
            );
        }
    }
    return out;
};

type PinFound = {
    pinned: Square;
    pinner: Square;
    pinnedRole: Role;
    pinnerRole: Role;
    move: NormalMove;
};

/** Pins created by `move` that tie down something worth more than the pinner, or win it. */
function usefulPins(pos: Chess, move: NormalMove): PinFound | null {
    for (const { pin, piece, after } of pinsCreated(pos, move)) {
        const pinnerRole = after.board.getRole(pin.pinner);
        if (!pinnerRole) continue;
        const attackersCount = attackersTo(
            after.board,
            pin.pinned,
            opposite(piece.color),
            after.board.occupied,
        ).size();
        const defendersCount = attackersTo(
            after.board,
            pin.pinned,
            piece.color,
            after.board.occupied,
        ).size();
        if (pieceValue(piece.role) > pieceValue(pinnerRole) || attackersCount > defendersCount) {
            return {
                pinned: pin.pinned,
                pinner: pin.pinner,
                pinnedRole: piece.role,
                pinnerRole,
                move,
            };
        }
    }
    return null;
}

function bestPinFor(pos: Chess): PinFound | null {
    let found: PinFound | null = null;
    for (const [from, dests] of pos.allDests()) {
        for (const to of dests) {
            const pin = usefulPins(pos, { from, to });
            if (pin && (!found || pieceValue(pin.pinnedRole) > pieceValue(found.pinnedRole)))
                found = pin;
        }
    }
    return found;
}

/** Absolute pins: created by the best move, or allowed to the opponent by the played move. */
export const pin: Detector = (ctx) => {
    const { before, played, best, afterPlayed, afterBest } = ctx;
    const out: Explanation[] = [];
    if (best) {
        const missed = usefulPins(before, best);
        if (missed && !usefulPins(before, played)) {
            out.push(
                make(
                    ctx,
                    "pin",
                    "certain",
                    missed.pinnedRole === "queen" ? 3 : 2,
                    {
                        variant: "missed",
                        pinned: missed.pinnedRole,
                        pinner: missed.pinnerRole,
                        square: sq(missed.pinned),
                    },
                    {
                        fen: fenOf(before),
                        line: [uciOf(best)],
                        arrows: [
                            arrow(best.from, best.to, "green"),
                            arrow(missed.pinner, missed.pinned, "red"),
                        ],
                    },
                ),
            );
        }
    }
    if (!afterPlayed.isEnd()) {
        const allowed = bestPinFor(afterPlayed);
        if (allowed) {
            const alsoAfterBest = afterBest ? bestPinFor(afterBest) : null;
            if (!alsoAfterBest || alsoAfterBest.pinned !== allowed.pinned) {
                out.push(
                    make(
                        ctx,
                        "pin",
                        "certain",
                        allowed.pinnedRole === "queen" ? 3 : 2,
                        {
                            variant: "allowed",
                            reply: sanOf(afterPlayed, allowed.move),
                            pinned: allowed.pinnedRole,
                            pinner: allowed.pinnerRole,
                            square: sq(allowed.pinned),
                        },
                        {
                            fen: fenOf(afterPlayed),
                            line: [uciOf(allowed.move)],
                            arrows: [arrow(allowed.pinner, allowed.pinned, "red")],
                        },
                    ),
                );
            }
        }
    }
    return out;
};

/** Skewers: the best move was one, or the played move allows one. */
export const skewer: Detector = (ctx) => {
    const { before, played, best, afterPlayed, afterBest } = ctx;
    const out: Explanation[] = [];
    if (best) {
        const missed = skewerBy(before, best);
        if (missed && !skewerBy(before, played)) {
            out.push(
                make(
                    ctx,
                    "skewer",
                    "likely",
                    severityOf(missed.piece.role),
                    { variant: "missed", target: missed.piece.role, square: sq(missed.target) },
                    {
                        fen: fenOf(before),
                        line: [uciOf(best)],
                        arrows: [
                            arrow(best.from, best.to, "green"),
                            arrow(missed.checker, missed.target, "red"),
                        ],
                    },
                ),
            );
        }
    }
    if (!afterPlayed.isEnd()) {
        let allowed: { move: NormalMove; target: Square; role: Role; checker: Square } | null =
            null;
        for (const [from, dests] of afterPlayed.allDests()) {
            for (const to of dests) {
                const s = skewerBy(afterPlayed, { from, to });
                if (s && (!allowed || pieceValue(s.piece.role) > pieceValue(allowed.role))) {
                    allowed = {
                        move: { from, to },
                        target: s.target,
                        role: s.piece.role,
                        checker: s.checker,
                    };
                }
            }
        }
        if (allowed) {
            let alsoAfterBest = false;
            if (afterBest) {
                outer: for (const [from, dests] of afterBest.allDests()) {
                    for (const to of dests) {
                        if (skewerBy(afterBest, { from, to })) {
                            alsoAfterBest = true;
                            break outer;
                        }
                    }
                }
            }
            if (!alsoAfterBest) {
                out.push(
                    make(
                        ctx,
                        "skewer",
                        "likely",
                        severityOf(allowed.role),
                        {
                            variant: "allowed",
                            reply: sanOf(afterPlayed, allowed.move),
                            target: allowed.role,
                            square: sq(allowed.target),
                        },
                        {
                            fen: fenOf(afterPlayed),
                            line: [uciOf(allowed.move)],
                            arrows: [arrow(allowed.checker, allowed.target, "red")],
                        },
                    ),
                );
            }
        }
    }
    return out;
};

/**
 * After the played move the opponent has a forced mate: a back-rank mate is
 * reported as `back_rank`, anything else as `allowed_mate`. Mates we replay
 * (in one or two) are certain; an engine mate score alone is "likely".
 */
export const allowedMate: Detector = (ctx) => {
    const { afterPlayed, afterBest, score } = ctx;
    if (afterPlayed.isEnd()) return [];
    const mate = forcedMate(afterPlayed);
    if (mate) {
        if (afterBest && forcedMate(afterBest)) return [];
        let pos = afterPlayed;
        for (const m of mate.moves.slice(0, -1)) pos = playMove(pos, m);
        const last = mate.moves[mate.moves.length - 1];
        const backRank = isBackRankMate(pos, last);
        const reply = sanOf(afterPlayed, mate.moves[0]);
        const variant: Record<string, string> = mate.length === 2 ? { variant: "in2" } : {};
        return [
            make(
                ctx,
                backRank ? "back_rank" : "allowed_mate",
                "certain",
                3,
                { reply, n: mate.length, ...variant },
                {
                    fen: fenOf(afterPlayed),
                    line: mate.moves.map(uciOf),
                    arrows: [arrow(mate.moves[0].from, mate.moves[0].to, "red")],
                },
            ),
        ];
    }
    if (score.afterPlayed <= -MATE_SCORE && score.afterBest > -MATE_SCORE) {
        return [
            make(
                ctx,
                "allowed_mate",
                "likely",
                3,
                { variant: "likely" },
                { fen: fenOf(afterPlayed), line: [] },
            ),
        ];
    }
    return [];
};

/** The mover had a forced mate (PV replayed to checkmate, or engine mate score) and let it go. */
export const missedMate: Detector = (ctx) => {
    const { before, pv, pvEnd, afterPlayed, score, best } = ctx;
    if (afterPlayed.isCheckmate()) return [];
    if (score.afterPlayed >= MATE_SCORE) return [];
    if (pvEnd?.isCheckmate() && pvEnd.turn === ctx.them) {
        const n = Math.ceil(pv.length / 2);
        return [
            make(
                ctx,
                "missed_mate",
                "certain",
                3,
                { n },
                {
                    fen: fenOf(before),
                    line: pv.map(uciOf),
                    arrows: [arrow(pv[0].from, pv[0].to, "green")],
                },
            ),
        ];
    }
    const mechanical = forcedMate(before);
    if (
        mechanical &&
        best &&
        mechanical.moves[0].from === best.from &&
        mechanical.moves[0].to === best.to
    ) {
        return [
            make(
                ctx,
                "missed_mate",
                "certain",
                3,
                { n: mechanical.length },
                {
                    fen: fenOf(before),
                    line: mechanical.moves.map(uciOf),
                    arrows: [arrow(best.from, best.to, "green")],
                },
            ),
        ];
    }
    if (score.afterBest >= MATE_SCORE) {
        return [
            make(
                ctx,
                "missed_mate",
                "likely",
                3,
                { variant: "likely" },
                {
                    fen: fenOf(before),
                    line: pv.map(uciOf),
                },
            ),
        ];
    }
    return [];
};

/** Trading pieces while behind in material (played), or declining to while ahead (best). */
export const trades: Detector = (ctx) => {
    const { before, played, best, mover } = ctx;
    const balance = materialBalance(before.board, mover);
    const playedTrade = tradedPiece(before, played);
    const bestTrade = best ? tradedPiece(before, best) : null;
    if (balance <= -2 && playedTrade && !bestTrade) {
        return [
            make(
                ctx,
                "trade_when_behind",
                "heuristic",
                1,
                { piece: playedTrade, diff: -balance },
                {
                    fen: fenOf(before),
                    line: [uciOf(played)],
                },
            ),
        ];
    }
    if (balance >= 3 && best && bestTrade && !playedTrade && !isCapture(before, played)) {
        return [
            make(
                ctx,
                "avoid_trade_when_ahead",
                "heuristic",
                1,
                { piece: bestTrade, diff: balance },
                {
                    fen: fenOf(before),
                    line: [uciOf(best)],
                    arrows: [arrow(best.from, best.to, "green")],
                },
            ),
        ];
    }
    return [];
};

/** A shelter pawn pushed in front of the king, or a king walk, with the enemy queen still on. */
export const kingExposure: Detector = (ctx) => {
    const { before, played, best, mover, them, afterPlayed } = ctx;
    if (!hasAttackingForce(before.board, them)) return [];
    const role = before.board.getRole(played.from);
    const shelter = kingShelter(before.board, mover);
    if (
        role === "pawn" &&
        shelter &&
        shelter.pawns.has(played.from) &&
        !isCapture(before, played)
    ) {
        const bestAlso =
            best && before.board.getRole(best.from) === "pawn" && shelter.pawns.has(best.from);
        if (!bestAlso) {
            return [
                make(
                    ctx,
                    "king_exposure",
                    "heuristic",
                    2,
                    { variant: "shield", square: sq(played.from) },
                    {
                        fen: fenOf(afterPlayed),
                        line: [],
                        arrows: [arrow(played.from, played.to, "red")],
                    },
                ),
            ];
        }
    }
    if (role === "king" && !isCastling(before, played) && !before.isCheck()) {
        const fromRank = relativeRank(played.from, mover);
        const toRank = relativeRank(played.to, mover);
        const bestIsKingMove = best !== null && before.board.getRole(best.from) === "king";
        if (toRank >= 2 && toRank > fromRank && !bestIsKingMove) {
            return [
                make(
                    ctx,
                    "king_exposure",
                    "heuristic",
                    2,
                    { variant: "walk", square: sq(played.to) },
                    {
                        fen: fenOf(afterPlayed),
                        line: [],
                        arrows: [arrow(played.from, played.to, "red")],
                    },
                ),
            ];
        }
    }
    return [];
};

/** Creating a passed pawn (best did, played did not) or ignoring an advanced enemy passer. */
export const passedPawn: Detector = (ctx) => {
    const { before, played, best, afterPlayed, afterBest, mover, them } = ctx;
    const out: Explanation[] = [];
    if (best && afterBest) {
        const own = passedPawns(before.board, mover);
        const newAfter = (after: Chess, move: NormalMove): Square | undefined => {
            const created = passedPawns(after.board, mover).diff(own);
            for (const s of created) {
                if (own.has(move.from) && s === move.to) continue; // an old passer that just advanced
                return s;
            }
            return undefined;
        };
        const created = newAfter(afterBest, best);
        if (created !== undefined && newAfter(afterPlayed, played) === undefined) {
            out.push(
                make(
                    ctx,
                    "passed_pawn",
                    "heuristic",
                    pawnAdvancement(created, mover) >= 3 ? 2 : 1,
                    { variant: "missed", square: sq(created) },
                    {
                        fen: fenOf(before),
                        line: [uciOf(best)],
                        arrows: [arrow(best.from, best.to, "green")],
                    },
                ),
            );
        }
    }
    if (best) {
        for (const pawn of passedPawns(before.board, them)) {
            if (pawnAdvancement(pawn, them) < 3) continue;
            const front = squareInFront(pawn, them);
            if (
                dealsWithPasser(before, best, pawn, front) &&
                !dealsWithPasser(before, played, pawn, front)
            ) {
                out.push(
                    make(
                        ctx,
                        "passed_pawn",
                        "heuristic",
                        2,
                        { variant: "ignored", square: sq(pawn) },
                        {
                            fen: fenOf(before),
                            line: [uciOf(best)],
                            arrows: [arrow(best.from, best.to, "green")],
                        },
                    ),
                );
                break;
            }
        }
    }
    return out;
};

/** Best develops a piece or castles (opening), or centralises a rim knight; played does neither. */
export const pieceActivity: Detector = (ctx) => {
    const { before, played, best, mover } = ctx;
    if (!best) return [];
    const playedBusy = isCapture(before, played) || givesCheck(before, played);
    if (isOpening(before)) {
        const bestDev = developmentOf(before, best);
        const playedDev = developmentOf(before, played);
        if (
            bestDev &&
            !playedDev &&
            !playedBusy &&
            undevelopedMinors(before.board, mover).nonEmpty()
        ) {
            return [
                make(
                    ctx,
                    "piece_activity",
                    "heuristic",
                    1,
                    { variant: bestDev === "castle" ? "castle" : "develop" },
                    {
                        fen: fenOf(before),
                        line: [uciOf(best)],
                        arrows: [arrow(best.from, best.to, "green")],
                    },
                ),
            ];
        }
    }
    const bestRole = before.board.getRole(best.from);
    const playedRole = before.board.getRole(played.from);
    const centralises = (from: Square, to: Square, role: Role | undefined) =>
        role === "knight" && isRimSquare(from) && isCentralSquare(to);
    if (
        centralises(best.from, best.to, bestRole) &&
        !isCapture(before, best) &&
        !playedBusy &&
        !centralises(played.from, played.to, playedRole)
    ) {
        return [
            make(
                ctx,
                "piece_activity",
                "heuristic",
                1,
                { variant: "centralize", piece: "knight", square: sq(best.to) },
                {
                    fen: fenOf(before),
                    line: [uciOf(best)],
                    arrows: [arrow(best.from, best.to, "green")],
                },
            ),
        ];
    }
    return [];
};

/** The same minor piece (or queen) moved again in the opening while others are still at home. */
export const tempoLoss: Detector = (ctx) => {
    const { before, played, best, mover } = ctx;
    if (!isOpening(before) || !best) return [];
    const piece = before.board.get(played.from);
    if (!piece || (piece.role !== "knight" && piece.role !== "bishop" && piece.role !== "queen"))
        return [];
    if (isHomeSquare(mover, piece.role, played.from)) return [];
    if (isCapture(before, played) || givesCheck(before, played)) return [];
    if (undevelopedMinors(before.board, mover).isEmpty()) return [];
    if (!developmentOf(before, best)) return [];
    // a piece that is attacked has to move; that is not a wasted tempo
    if (attackersTo(before.board, played.from, ctx.them, before.board.occupied).nonEmpty())
        return [];
    return [
        make(
            ctx,
            "tempo_loss",
            "heuristic",
            1,
            { piece: piece.role, square: sq(played.from) },
            {
                fen: fenOf(before),
                line: [uciOf(best)],
                arrows: [arrow(best.from, best.to, "green")],
            },
        ),
    ];
};

/** Clock facts: little time left, or a snap move at a critical moment. */
export const timePressure: Detector = (ctx) => {
    const { clockBefore, clockAfter } = ctx.input;
    if (clockBefore === undefined || !Number.isFinite(clockBefore)) return [];
    if (clockBefore <= 60) {
        return [
            make(ctx, "time_pressure", "certain", clockBefore <= 20 ? 3 : 2, {
                seconds: Math.max(0, Math.round(clockBefore)),
            }),
        ];
    }
    if (clockAfter !== undefined && Number.isFinite(clockAfter)) {
        const used = clockBefore - clockAfter;
        if (used >= 0 && used <= 2 && ctx.drop >= 0.1) {
            return [
                make(ctx, "time_pressure", "likely", 1, {
                    variant: "rushed",
                    used: Math.round(used * 10) / 10,
                }),
            ];
        }
    }
    return [];
};

/** Detectors in evaluation order. */
export const DETECTORS: Detector[] = [
    missedMate,
    allowedMate,
    hangingPiece,
    missedHangingPiece,
    fork,
    pin,
    skewer,
    trades,
    kingExposure,
    passedPawn,
    pieceActivity,
    tempoLoss,
    timePressure,
];

export const DETECTOR_IDS = [
    "hanging_piece",
    "missed_hanging_piece",
    "fork",
    "pin",
    "skewer",
    "back_rank",
    "missed_mate",
    "allowed_mate",
    "trade_when_behind",
    "avoid_trade_when_ahead",
    "king_exposure",
    "passed_pawn",
    "piece_activity",
    "tempo_loss",
    "time_pressure",
] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];

const EVIDENCE_RANK: Record<EvidenceLevel, number> = { certain: 0, likely: 1, heuristic: 2 };
const DECISIVE = new Set<string>(["missed_mate", "allowed_mate", "back_rank"]);
const KEEP_WITH_DECISIVE = new Set<string>(["king_exposure", "time_pressure"]);

/** Removes explanations made redundant by stronger ones, sorts and caps the list. */
export function finalize(list: Explanation[], max = 4): Explanation[] {
    const ids = new Set(list.map((e) => e.id));
    const decisive = [...ids].some((id) => DECISIVE.has(id));
    const skewers = list.filter((e) => e.id === "skewer");
    const kept = list.filter((e) => {
        if (decisive && e.evidence === "heuristic" && !KEEP_WITH_DECISIVE.has(e.id)) return false;
        if (e.id === "allowed_mate" && ids.has("back_rank")) return false;
        if (e.id === "piece_activity" && ids.has("tempo_loss")) return false;
        // a skewer is also a double attack along a line; keep the more specific one
        if (
            e.id === "fork" &&
            skewers.some(
                (s) =>
                    s.params.variant === e.params.variant &&
                    (e.params.variant === "missed" || s.params.reply === e.params.reply),
            )
        ) {
            return false;
        }
        return true;
    });
    return kept
        .map((e, i) => ({ e, i }))
        .sort(
            (a, b) =>
                b.e.severity - a.e.severity ||
                EVIDENCE_RANK[a.e.evidence] - EVIDENCE_RANK[b.e.evidence] ||
                a.i - b.i,
        )
        .slice(0, max)
        .map((x) => x.e);
}

// keep the pin helper reachable for tests of "ignored" pins
export { absolutePins };
