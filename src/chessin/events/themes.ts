import type { DeviationDoc } from "@/chessin/deviation/detect";
import type { PlayerColor } from "@/chessin/repertoire/model";
import { cpForColor, type KeyMoment, type Review } from "@/chessin/review/model";
import { outcomeFor } from "./group";

/**
 * Cross-game theme cards (S4-3, teardown W3-3). A theme is shown only when
 * at least `THEME_MIN_GAMES` games of the event support it — one bad game is
 * noise, three is a pattern. Deliberately no "accuracy %" headline.
 *
 * Templates (keys in `Events.Theme.*`):
 * - EarlyRepertoireExit — per colour: "{{total}} 盘{{color}}里有 {{count}} 盘在第
 *   {{move}} 着前就离开了开局体系" (deviation of either kind before move 8);
 * - MidgameLoss — "{{count}} 盘在第 30–40 着之间丢掉了 1.5 兵以上" (the
 *   player's summed centipawn loss over moves 30–40 ≥ 150);
 * - UnconvertedWins — "{{count}} 个 +2.0 以上的局面没有赢下来" (a position at
 *   ≥ +200 cp for the player, game not won);
 * - TimePressure — "{{count}} 盘在时间紧张时出现失误" (the review found
 *   inaccurate-or-worse moves under time pressure).
 */

export type GameEvidence = {
    key: string;
    playerColor: PlayerColor;
    result: string;
    review: Review | null;
    deviation: DeviationDoc | null;
};

export const THEME_MIN_GAMES = 3;
/** "Before move 8": a deviation on a move number below this counts as early. */
export const EARLY_EXIT_MOVE = 8;
/** Full-move window of the midgame-loss theme (inclusive). */
export const MIDGAME_WINDOW: readonly [number, number] = [30, 40];
/** Centipawns lost over the window for the midgame-loss theme (1.5 pawns). */
export const MIDGAME_LOSS_CP = 150;
/** Player-view centipawns that count as a winning position (+2.0). */
export const UNCONVERTED_CP = 200;
/** Key moments listed per game on the events page. */
export const MOMENTS_PER_GAME = 3;

export type ThemeId = "EarlyRepertoireExit" | "MidgameLoss" | "UnconvertedWins" | "TimePressure";

export type ThemeCard = {
    theme: ThemeId;
    /** Unique per card (the early-exit theme is per colour). */
    id: string;
    key: `Events.Theme.${ThemeId}`;
    params: Record<string, string | number>;
    /** Keys of the supporting games. */
    games: string[];
};

/** The `limit` highest-priority moments of a review, in move order. */
export function keyMoments(
    review: Pick<Review, "moments"> | null | undefined,
    limit = MOMENTS_PER_GAME,
): KeyMoment[] {
    if (!review) return [];
    return [...review.moments]
        .sort((a, b) => b.priority - a.priority)
        .slice(0, Math.max(0, limit))
        .sort((a, b) => a.ply - b.ply);
}

/** Full-move number of the deviation (either kind); null without one. */
export function exitMoveNumber(doc: DeviationDoc | null | undefined): number | null {
    const d = doc?.deviation;
    return d ? Math.max(1, Math.ceil(d.ply / 2)) : null;
}

export function isEarlyExit(
    doc: DeviationDoc | null | undefined,
    beforeMove = EARLY_EXIT_MOVE,
): boolean {
    const move = exitMoveNumber(doc);
    return move !== null && move < beforeMove;
}

/** The colour a review's per-player numbers refer to: the review's, else the game's. */
function colorFor(review: Review, fallback: PlayerColor): PlayerColor {
    return review.playerColor ?? fallback;
}

/** Summed centipawn loss of `color`'s moves inside the full-move window. */
export function midgameLossCp(
    review: Pick<Review, "plies">,
    color: PlayerColor,
    window: readonly [number, number] = MIDGAME_WINDOW,
): number {
    let loss = 0;
    for (const ply of review.plies) {
        if (ply.color !== color) continue;
        const move = Math.ceil(ply.ply / 2);
        if (move < window[0] || move > window[1]) continue;
        if (Number.isFinite(ply.cpLoss)) loss += Math.max(0, ply.cpLoss);
    }
    return loss;
}

export function hasMidgameLoss(
    review: Pick<Review, "plies">,
    color: PlayerColor,
    threshold = MIDGAME_LOSS_CP,
): boolean {
    return midgameLossCp(review, color) >= threshold;
}

/** Best evaluation (player view, cp) reached after any move of the game. */
export function peakScoreFor(review: Pick<Review, "plies">, color: PlayerColor): number {
    let peak = Number.NEGATIVE_INFINITY;
    for (const ply of review.plies) {
        const cp = cpForColor(ply.score, color);
        if (cp > peak) peak = cp;
    }
    return peak;
}

export function isUnconvertedWin(
    review: Pick<Review, "plies">,
    color: PlayerColor,
    result: string,
    threshold = UNCONVERTED_CP,
): boolean {
    if (outcomeFor(result, color) === "win") return false;
    return peakScoreFor(review, color) >= threshold;
}

export function hasTimePressureMistake(review: Pick<Review, "summary">): boolean {
    return review.summary.timePressureMoves.length > 0;
}

export type DetectThemesOptions = {
    minGames?: number;
    earlyExitMove?: number;
};

/** The theme cards an event's games support (each by at least `minGames` games). */
export function detectThemes(
    evidence: readonly GameEvidence[],
    opts: DetectThemesOptions = {},
): ThemeCard[] {
    const minGames = opts.minGames ?? THEME_MIN_GAMES;
    const earlyMove = opts.earlyExitMove ?? EARLY_EXIT_MOVE;
    const cards: ThemeCard[] = [];

    for (const color of ["white", "black"] as const) {
        const mine = evidence.filter((e) => e.playerColor === color);
        const early = mine.filter((e) => isEarlyExit(e.deviation, earlyMove));
        if (early.length >= minGames) {
            cards.push({
                theme: "EarlyRepertoireExit",
                id: `EarlyRepertoireExit:${color}`,
                key: "Events.Theme.EarlyRepertoireExit",
                params: { total: mine.length, count: early.length, move: earlyMove, color },
                games: early.map((e) => e.key),
            });
        }
    }

    const midgame = evidence.filter(
        (e) => e.review && hasMidgameLoss(e.review, colorFor(e.review, e.playerColor)),
    );
    if (midgame.length >= minGames) {
        cards.push({
            theme: "MidgameLoss",
            id: "MidgameLoss",
            key: "Events.Theme.MidgameLoss",
            params: { count: midgame.length, from: MIDGAME_WINDOW[0], to: MIDGAME_WINDOW[1] },
            games: midgame.map((e) => e.key),
        });
    }

    const unconverted = evidence.filter(
        (e) => e.review && isUnconvertedWin(e.review, colorFor(e.review, e.playerColor), e.result),
    );
    if (unconverted.length >= minGames) {
        cards.push({
            theme: "UnconvertedWins",
            id: "UnconvertedWins",
            key: "Events.Theme.UnconvertedWins",
            params: { count: unconverted.length },
            games: unconverted.map((e) => e.key),
        });
    }

    const pressure = evidence.filter((e) => e.review && hasTimePressureMistake(e.review));
    if (pressure.length >= minGames) {
        cards.push({
            theme: "TimePressure",
            id: "TimePressure",
            key: "Events.Theme.TimePressure",
            params: { count: pressure.length },
            games: pressure.map((e) => e.key),
        });
    }

    return cards;
}
