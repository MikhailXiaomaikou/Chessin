import { z } from "zod";
import { getDoc, putDoc } from "@/chessin/store/libraryStore";
import type { LichessGameSpeed, LichessRating } from "@/utils/lichess/explorer";
import type { Session } from "@/utils/session";

/**
 * Repertoire workbench model (S3-5 v0).
 *
 * A repertoire stays an En Croissant repertoire file (PGN flagged as
 * `repertoire`). Chessin adds a sidecar library document, kind
 * `repertoire_meta`, id `rep:<file path>`, holding the parameters the
 * coverage check needs: which colour the user plays, the rating band and time
 * control that define "my level" on the Lichess explorer, the coverage target
 * (cover every opponent move played at least 1 in N games) and the cold-shelf
 * threshold. Defaults are inferred from the linked accounts (`sessionsAtom`).
 */

export const REPERTOIRE_META_KIND = "repertoire_meta";

export const REPERTOIRE_META_PREFIX = "rep:";

export function repertoireMetaId(filePath: string): string {
    return `${REPERTOIRE_META_PREFIX}${filePath}`;
}

export type PlayerColor = "white" | "black";

export const RATING_SOURCES = ["lichess", "fide"] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

export const TIME_CONTROLS = ["classical", "rapid", "blitz"] as const;
export type TimeControl = (typeof TIME_CONTROLS)[number];

export const repertoireMetaSchema = z.object({
    color: z.enum(["white", "black"]),
    startFen: z.string(),
    /** `[lo, hi]` rating band of the opponents the check is run against. */
    eloRange: z.tuple([z.number(), z.number()]),
    /** `lichess`: explorer filtered to `eloRange`; `fide`: OTB master games. */
    ratingSource: z.enum(RATING_SOURCES),
    timeControl: z.enum(TIME_CONTROLS),
    /** Cover opponent moves played at least 1 in N games. */
    coverageTarget: z.number().int().positive(),
    /** Lines reached with probability below this are shelved as cold. */
    coldThreshold: z.number().min(0).max(1),
    /** Check depth in full moves from the start position (default 10). */
    depth: z.number().int().positive().optional(),
});

export type RepertoireMeta = z.infer<typeof repertoireMetaSchema>;

export const DEFAULT_COVERAGE_TARGET = 100;
export const DEFAULT_COLD_THRESHOLD = 0.01;
export const DEFAULT_DEPTH_MOVES = 10;
export const DEFAULT_ELO_RANGE: [number, number] = [1600, 1800];
export const DEFAULT_TIME_CONTROL: TimeControl = "rapid";

/** The explorer's rating buckets; each covers `[bucket, next bucket)`. */
export const LICHESS_RATING_BUCKETS: readonly LichessRating[] = [
    0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500,
];

/** Upper bound used for the open-ended top bucket. */
export const TOP_BUCKET_CEILING = 3200;

/** Largest explorer bucket not above `rating`. */
export function bucketFor(rating: number): LichessRating {
    let bucket: LichessRating = 0;
    for (const b of LICHESS_RATING_BUCKETS) {
        if (b <= rating) bucket = b;
    }
    return bucket;
}

/** Exclusive upper bound of an explorer bucket. */
export function bucketCeiling(bucket: LichessRating): number {
    const i = LICHESS_RATING_BUCKETS.indexOf(bucket);
    const next = LICHESS_RATING_BUCKETS[i + 1];
    return next === undefined ? TOP_BUCKET_CEILING : next;
}

/** The explorer band around a rating, e.g. 1712 → `[1600, 1800]`. */
export function eloRangeAround(rating: number): [number, number] {
    const bucket = bucketFor(rating);
    return [bucket, bucketCeiling(bucket)];
}

/**
 * Explorer buckets whose interval overlaps `[lo, hi)`. A degenerate or
 * reversed range yields the bucket containing `lo`; never empty.
 */
export function lichessRatingsFor(range: [number, number]): LichessRating[] {
    const lo = Math.min(range[0], range[1]);
    const hi = Math.max(range[0], range[1]);
    const upper = hi > lo ? hi : lo + 1;
    const out = LICHESS_RATING_BUCKETS.filter((b) => b < upper && bucketCeiling(b) > lo);
    return out.length > 0 ? out : [bucketFor(lo)];
}

export function lichessSpeedsFor(timeControl: TimeControl): LichessGameSpeed[] {
    switch (timeControl) {
        case "classical":
            return ["classical"];
        case "rapid":
            return ["rapid"];
        case "blitz":
            return ["blitz"];
    }
}

export function formatEloRange(range: [number, number]): string {
    return `${range[0]}–${range[1]}`;
}

// ---------------------------------------------------------------------------
// Defaults from the linked accounts

export type RatingHint = {
    rating: number;
    timeControl: TimeControl;
    source: "lichess" | "chesscom" | "fide";
    /** Games played in that pool (0 when unknown); used to pick the main pool. */
    games: number;
    account: string;
};

const LICHESS_PERFS: readonly TimeControl[] = ["classical", "rapid", "blitz"];

/** Every usable rating the sessions carry, in no particular order. */
export function ratingHintsFromSessions(sessions: readonly Session[]): RatingHint[] {
    const hints: RatingHint[] = [];
    for (const session of sessions) {
        const lichess = session.lichess;
        if (lichess) {
            for (const tc of LICHESS_PERFS) {
                const perf = lichess.account?.perfs?.[tc];
                if (perf && Number.isFinite(perf.rating) && perf.rating > 0 && perf.games > 0) {
                    hints.push({
                        rating: perf.rating,
                        timeControl: tc,
                        source: "lichess",
                        games: perf.games,
                        account: lichess.username,
                    });
                }
            }
            const fide = lichess.account?.profile?.fideRating;
            if (typeof fide === "number" && fide > 0) {
                hints.push({
                    rating: fide,
                    timeControl: "classical",
                    source: "fide",
                    games: 0,
                    account: lichess.username,
                });
            }
        }
        const chessCom = session.chessCom;
        if (chessCom) {
            const perfs: [TimeControl, keyof typeof chessCom.stats][] = [
                ["classical", "chess_daily"],
                ["rapid", "chess_rapid"],
                ["blitz", "chess_blitz"],
            ];
            for (const [tc, key] of perfs) {
                const perf = chessCom.stats?.[key];
                if (!perf || !Number.isFinite(perf.last?.rating) || perf.last.rating <= 0) continue;
                const record = perf.record;
                hints.push({
                    rating: perf.last.rating,
                    timeControl: tc,
                    source: "chesscom",
                    games: record ? record.win + record.loss + record.draw : 0,
                    account: chessCom.username,
                });
            }
        }
    }
    return hints;
}

export type InferredDefaults = {
    eloRange: [number, number];
    timeControl: TimeControl;
    ratingSource: RatingSource;
    /** The hint the defaults came from, null when nothing usable was linked. */
    from: RatingHint | null;
};

/**
 * Picks the defaults for a new repertoire: the Lichess pool with the most
 * games, else the chess.com pool with the most games (its rating is used as a
 * Lichess band as-is), else a FIDE rating (→ master games), else the built-in
 * 1600–1800 rapid band.
 */
export function inferDefaults(sessions: readonly Session[]): InferredDefaults {
    const hints = ratingHintsFromSessions(sessions);
    const best = (source: RatingHint["source"]) =>
        hints
            .filter((h) => h.source === source)
            .sort((a, b) => b.games - a.games || b.rating - a.rating)[0] ?? null;
    const online = best("lichess") ?? best("chesscom");
    if (online) {
        return {
            eloRange: eloRangeAround(online.rating),
            timeControl: online.timeControl,
            ratingSource: "lichess",
            from: online,
        };
    }
    const fide = best("fide");
    if (fide) {
        return {
            eloRange: eloRangeAround(fide.rating),
            timeControl: "classical",
            ratingSource: "fide",
            from: fide,
        };
    }
    return {
        eloRange: DEFAULT_ELO_RANGE,
        timeControl: DEFAULT_TIME_CONTROL,
        ratingSource: "lichess",
        from: null,
    };
}

export function defaultMeta({
    color,
    startFen,
    sessions = [],
}: {
    color: PlayerColor;
    startFen: string;
    sessions?: readonly Session[];
}): RepertoireMeta {
    const inferred = inferDefaults(sessions);
    return {
        color,
        startFen,
        eloRange: inferred.eloRange,
        ratingSource: inferred.ratingSource,
        timeControl: inferred.timeControl,
        coverageTarget: DEFAULT_COVERAGE_TARGET,
        coldThreshold: DEFAULT_COLD_THRESHOLD,
        depth: DEFAULT_DEPTH_MOVES,
    };
}

// ---------------------------------------------------------------------------
// Persistence

/** Parses a stored document payload; unknown or invalid fields are dropped. */
export function parseMeta(raw: string | null | undefined): Partial<RepertoireMeta> | null {
    if (!raw) return null;
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }
    const parsed = repertoireMetaSchema.partial().safeParse(json);
    return parsed.success ? parsed.data : null;
}

export function withDefaults(
    partial: Partial<RepertoireMeta> | null,
    fallback: RepertoireMeta,
): RepertoireMeta {
    if (!partial) return fallback;
    const merged: RepertoireMeta = { ...fallback };
    for (const key of Object.keys(partial) as (keyof RepertoireMeta)[]) {
        const value = partial[key];
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return merged;
}

/** The stored meta of a repertoire file merged over `fallback`. */
export async function loadRepertoireMeta(
    filePath: string,
    fallback: RepertoireMeta,
): Promise<{ meta: RepertoireMeta; stored: boolean }> {
    try {
        const doc = await getDoc(repertoireMetaId(filePath));
        const partial = parseMeta(doc?.data);
        return { meta: withDefaults(partial, fallback), stored: partial !== null };
    } catch {
        return { meta: fallback, stored: false };
    }
}

export function saveRepertoireMeta(
    filePath: string,
    title: string,
    meta: RepertoireMeta,
): Promise<void> {
    return putDoc({
        id: repertoireMetaId(filePath),
        kind: REPERTOIRE_META_KIND,
        title,
        origin: filePath,
        data: JSON.stringify(meta),
    });
}

/** First four FEN fields (board, turn, castling, en passant); an EPD passes through. */
export function toEpd(fenOrEpd: string): string {
    return fenOrEpd.trim().split(/\s+/).slice(0, 4).join(" ");
}

/** True when it is the user's move in a position `halfMoves` plies from the initial position. */
export function isUserTurn(halfMoves: number, color: PlayerColor): boolean {
    return color === "white" ? halfMoves % 2 === 0 : halfMoves % 2 === 1;
}
