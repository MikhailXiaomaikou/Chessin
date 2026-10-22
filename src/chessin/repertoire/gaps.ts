import { getWinChance } from "@/utils/score";
import type { GapCandidate } from "./coverage";
import { type ExplorerStats, movesTotal } from "./explorerCache";
import type { PlayerColor } from "./model";

/**
 * Gap ranking (S3-5). A gap is an opponent move, played at least 1 in
 * `coverageTarget` games at the user's level, that leads to a position
 * without a prepared reply. Gaps are ranked by
 *
 *     score = probability × (evalLoss ?? 0.5)
 *
 * where `evalLoss` is the opponent's expected score (0..1) in the position
 * after their move, taken from a cached engine evaluation of that position
 * (the best reply's eval, white's point of view) — a gap behind a strong
 * opponent move outranks one behind a dubious move of the same frequency.
 * Without a cached eval the factor is the neutral 0.5.
 */

export type EngineScore = { type: "cp" | "mate"; value: number };

export type Gap = GapCandidate & {
    /** `<epd>|<uci>`: the same opponent move reached through transpositions merges. */
    id: string;
    /** Opponent's expected score after the move, null without a cached eval. */
    evalLoss: number | null;
    score: number;
};

export const MATE_CP = 10_000;

export function gapId(candidate: Pick<GapCandidate, "epd" | "uci">): string {
    return `${candidate.epd}|${candidate.uci}`;
}

export function gapThreshold(coverageTarget: number): number {
    return coverageTarget > 0 ? 1 / coverageTarget : 0;
}

/** White-view centipawns of an engine score (mates saturate at ±MATE_CP). */
export function scoreToCp(score: EngineScore): number {
    if (score.type === "cp") return score.value;
    return score.value > 0 ? MATE_CP : score.value < 0 ? -MATE_CP : 0;
}

/** Opponent's expected score (0..1) from a white-view score and the user's colour. */
export function opponentExpectedScore(score: EngineScore | number, userColor: PlayerColor): number {
    const cp = typeof score === "number" ? score : scoreToCp(score);
    const opponentCp = userColor === "white" ? -cp : cp;
    return getWinChance(opponentCp) / 100;
}

export type RankGapsOptions = {
    coverageTarget: number;
    color: PlayerColor;
    /** Cached evals keyed by the EPD *after* the opponent's move (white view). */
    evals?: Map<string, EngineScore | number>;
};

/** Merges transposed candidates, applies the frequency threshold and ranks. */
export function rankGaps(candidates: GapCandidate[], options: RankGapsOptions): Gap[] {
    const threshold = gapThreshold(options.coverageTarget);
    const merged = new Map<string, Gap>();
    for (const candidate of candidates) {
        const id = gapId(candidate);
        const existing = merged.get(id);
        if (!existing) {
            merged.set(id, { ...candidate, id, evalLoss: null, score: 0 });
            continue;
        }
        existing.probability += candidate.probability;
        existing.games = Math.max(existing.games, candidate.games);
        // Keep the shallowest occurrence as the representative path.
        if (candidate.path.length < existing.path.length) {
            existing.path = candidate.path;
            existing.nodeId = candidate.nodeId;
            existing.fen = candidate.fen;
            existing.halfMoves = candidate.halfMoves;
            existing.childPath = candidate.childPath;
            existing.inTree = candidate.inTree;
            existing.childFen = candidate.childFen;
            existing.childEpd = candidate.childEpd;
        } else if (!existing.inTree && candidate.inTree) {
            existing.inTree = true;
            existing.childPath = candidate.childPath;
            existing.childFen = candidate.childFen;
            existing.childEpd = candidate.childEpd;
        }
    }
    const out: Gap[] = [];
    for (const gap of merged.values()) {
        if (gap.probability < threshold) continue;
        const cached = gap.childEpd ? options.evals?.get(gap.childEpd) : undefined;
        gap.evalLoss = cached === undefined ? null : opponentExpectedScore(cached, options.color);
        gap.score = gap.probability * (gap.evalLoss ?? 0.5);
        out.push(gap);
    }
    out.sort(
        (a, b) =>
            b.score - a.score ||
            b.probability - a.probability ||
            a.path.length - b.path.length ||
            a.san.localeCompare(b.san),
    );
    return out;
}

export type Reply = {
    san: string;
    uci: string;
    games: number;
    /** Share of the games continuing from the position. */
    share: number;
    /** The user's score with this reply: (wins + draws / 2) / games. */
    userScore: number;
    white: number;
    draws: number;
    black: number;
};

/** The most played replies in a gap position, with the user's score for each. */
export function topReplies(stats: ExplorerStats, color: PlayerColor, n = 3): Reply[] {
    const total = stats.moves.reduce((acc, m) => acc + movesTotal(m), 0);
    return stats.moves
        .map((m) => {
            const games = movesTotal(m);
            const wins = color === "white" ? m.white : m.black;
            return {
                san: m.san,
                uci: m.uci,
                games,
                share: total > 0 ? games / total : 0,
                userScore: games > 0 ? (wins + m.draws / 2) / games : 0,
                white: m.white,
                draws: m.draws,
                black: m.black,
            };
        })
        .filter((r) => r.games > 0)
        .sort((a, b) => b.games - a.games || b.userScore - a.userScore)
        .slice(0, n);
}
