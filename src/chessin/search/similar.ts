import type { NormalizedGame } from "@/bindings";
import { OfflineError } from "@/chessin/sources/lichessQueue";
import type { Source } from "@/chessin/sources/sources";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import { getGamesByIds, searchPosition } from "@/utils/db";
import { convertToNormalized, getLichessGames, getMasterGames } from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import { plyFromFen, reduceFen } from "./fen";
import {
    getIndexState,
    type IndexFilter,
    indexPawnCandidates,
    indexPosition,
    type IndexPositionResult,
    type IndexState,
    MAX_INDEX_PLY,
} from "./index";
import {
    applyFilters,
    dedupeByKey,
    EMPTY_SUMMARY,
    hasClientOnlyFilters,
    type SimilarFilters,
    type Summary,
    summarizeGames,
    summarizeStats,
    withDecisiveOnly,
} from "./mapping";
import { buildMatchQuery, fenAtPly, findMatchedPly, type SimilarMode } from "./replay";

/**
 * Data for the "查找相似" drawer (W4-1 v0).
 *
 * 相同局面 (`position`): the index when it is ready and the position lies
 * within its depth, else `search_position { type_: "exact" }`; Lichess
 * sources use the explorer API.
 *
 * 相同兵形 (`pawns`) and 兵形加子力 (`pawnsMaterial`): local sources only.
 * `search_position { type_: "partial" }` on a pawns-only FEN matches every
 * game that reaches a position *containing* those pawns (subset semantics —
 * extra pawns elsewhere are allowed), so it is used as a candidate generator
 * (or `index_pawn_candidates` when the index is ready) and every candidate
 * is replayed with chessops to keep only games with exactly the same pawn
 * structure (and, for `pawnsMaterial`, the same piece counts). The summary
 * of those tabs is therefore over the verified sample, not the whole database.
 */

export type SimilarVia = "index" | "scan" | "lichess";

export type SimilarRow = {
    /** `database#id` (or `lichess#id`), unique within a result. */
    key: string;
    game: NormalizedGame;
    /** Main-line ply at which the game matches (0 = its start position). */
    ply: number;
    /** Position at `ply` (what the row's MiniBoard shows). */
    fen: string;
    /** `.db3` path for `gameOrigin`, null for online sources. */
    database: string | null;
};

export type SimilarSample = { candidates: number; checked: number; verified: number };

export type SimilarResult = {
    via: SimilarVia;
    summary: Summary;
    rows: SimilarRow[];
    /** True when `summary` describes the verified sample rather than every game. */
    approximate: boolean;
    sample: SimilarSample | null;
};

export type SimilarQuery = {
    kind: "similar";
    mode: SimilarMode;
    fen: string;
    source: Source;
    filters: SimilarFilters;
    /** Request lane / `search_position` tab id (one per drawer, not the explorer's). */
    lane: string;
    token: string;
    lichessOptions: LichessGamesOptions;
    masterOptions: MasterGamesOptions;
};

/** Rows listed per tab. */
export const SIMILAR_ROW_LIMIT = 50;
/** Candidates replayed for the pawn-structure tabs. */
export const VERIFY_LIMIT = 300;
/** Lichess top games fetched (each is one PGN request). */
export const LICHESS_ROW_LIMIT = 8;

type LichessMove = {
    uci: string;
    san: string;
    averageRating: number;
    white: number;
    black: number;
    draws: number;
};

type LichessTopGame = {
    uci: string;
    id: string;
    winner: string | null;
    speed: string;
    mode: string;
    black: { name: string; rating: number };
    white: { name: string; rating: number };
    year: number;
    month: string;
};

export type LichessExplorerData = {
    white: number;
    black: number;
    draws: number;
    moves: LichessMove[];
    recentGames?: LichessTopGame[];
    topGames?: LichessTopGame[];
};

export type SimilarDeps = {
    indexState(dbPath: string): IndexState;
    indexPosition(
        dbPath: string,
        fen: string,
        filter: IndexFilter,
        limit: number,
    ): Promise<IndexPositionResult>;
    indexPawnCandidates(dbPath: string, fen: string, limit: number): Promise<number[]>;
    getGamesByIds(dbPath: string, ids: number[]): Promise<NormalizedGame[]>;
    searchPosition(
        options: LocalOptions,
        lane: string,
    ): Promise<[{ move: string; white: number; draw: number; black: number }[], NormalizedGame[]]>;
    lichess(query: SimilarQuery): Promise<LichessExplorerData | null>;
    lichessGames(
        games: LichessTopGame[],
        opts: { lane: string; masters: boolean },
    ): Promise<NormalizedGame[]>;
};

const defaultDeps: SimilarDeps = {
    indexState: getIndexState,
    indexPosition,
    indexPawnCandidates,
    getGamesByIds,
    searchPosition,
    lichess(query) {
        const { source } = query;
        if (source.kind === "lichess-masters") {
            return getMasterGames(query.fen, query.masterOptions, query.token, query.lane);
        }
        if (source.kind === "lichess") {
            return getLichessGames(
                query.fen,
                {
                    ...query.lichessOptions,
                    ...(source.ratings
                        ? { ratings: source.ratings as LichessGamesOptions["ratings"] }
                        : {}),
                    ...(source.speeds
                        ? { speeds: source.speeds as LichessGamesOptions["speeds"] }
                        : {}),
                },
                query.token,
                query.lane,
            );
        }
        return Promise.resolve(null);
    },
    lichessGames: (games, opts) => convertToNormalized(games, opts),
};

function rowKey(database: string | null, game: NormalizedGame): string {
    return `${database ?? "lichess"}#${game.id}`;
}

function localOptions(
    path: string,
    fen: string,
    type: "exact" | "partial",
    filters: SimilarFilters,
): LocalOptions {
    return {
        path,
        fen,
        type,
        player: null,
        color: "white",
        result: "any",
        start_date: filters.yearFrom !== null ? `${filters.yearFrom}.01.01` : undefined,
    };
}

function indexFilter(filters: SimilarFilters): IndexFilter {
    const filter: IndexFilter = {};
    if (filters.minElo !== null) filter.min_elo = filters.minElo;
    if (filters.yearFrom !== null) filter.year_from = filters.yearFrom;
    return filter;
}

function totalOf(stats: readonly { white: number; draw: number; black: number }[]): number {
    return stats.reduce((acc, s) => acc + s.white + s.draw + s.black, 0);
}

async function samePositionLocal(
    path: string,
    query: SimilarQuery,
    deps: SimilarDeps,
): Promise<SimilarResult> {
    const { fen, filters, lane } = query;
    const match = buildMatchQuery(fen, "position");
    if (!match) throw new Error("Search.BadFen");

    if (deps.indexState(path) === "ready" && plyFromFen(fen) <= MAX_INDEX_PLY) {
        const result = await deps.indexPosition(
            path,
            fen,
            indexFilter(filters),
            SIMILAR_ROW_LIMIT * 2,
        );
        const refs = dedupeByKey(result.games, (g) => String(g.id));
        const plyOf = new Map(refs.map((g) => [g.id, g.ply]));
        const games = applyFilters(
            await deps.getGamesByIds(
                path,
                refs.map((g) => g.id),
            ),
            filters,
        );
        const rows: SimilarRow[] = games.slice(0, SIMILAR_ROW_LIMIT).map((game) => {
            const ply = plyOf.get(game.id) ?? result.ply;
            return {
                key: rowKey(path, game),
                game,
                ply,
                fen: fenAtPly(game.moves, game.fen, ply) ?? fen,
                database: path,
            };
        });
        let summary = summarizeStats(result.moves);
        if (filters.decisiveOnly) summary = withDecisiveOnly(summary);
        return { via: "index", summary, rows, approximate: false, sample: null };
    }

    const [stats, games] = await deps.searchPosition(
        localOptions(path, fen, "exact", filters),
        lane,
    );
    const filtered = applyFilters(games, filters);
    const rows: SimilarRow[] = filtered.slice(0, SIMILAR_ROW_LIMIT).map((game) => {
        const hit = findMatchedPly(game.moves, game.fen, match);
        return {
            key: rowKey(path, game),
            game,
            ply: hit?.ply ?? plyFromFen(fen),
            fen: hit?.fen ?? fen,
            database: path,
        };
    });
    const clientOnly = hasClientOnlyFilters(filters, "scan");
    let summary: Summary;
    if (clientOnly) {
        summary = summarizeGames(filtered);
    } else {
        summary = { ...summarizeStats(stats), avgElo: summarizeGames(games).avgElo };
    }
    return {
        via: "scan",
        summary,
        rows,
        approximate: clientOnly,
        sample: clientOnly
            ? { candidates: totalOf(stats), checked: games.length, verified: filtered.length }
            : null,
    };
}

async function samePawnsLocal(
    path: string,
    query: SimilarQuery,
    deps: SimilarDeps,
): Promise<SimilarResult> {
    const { fen, filters, lane, mode } = query;
    const match = buildMatchQuery(fen, mode);
    const reduced = reduceFen(fen, "pawns");
    if (!match || !reduced) throw new Error("Search.BadFen");

    let via: SimilarVia;
    let candidates: number;
    let games: NormalizedGame[];
    if (deps.indexState(path) === "ready") {
        via = "index";
        const ids = await deps.indexPawnCandidates(path, fen, VERIFY_LIMIT);
        candidates = ids.length;
        games = await deps.getGamesByIds(path, ids);
    } else {
        via = "scan";
        const [stats, sample] = await deps.searchPosition(
            localOptions(path, reduced, "partial", filters),
            lane,
        );
        candidates = Math.max(totalOf(stats), sample.length);
        games = sample;
    }

    const filtered = applyFilters(games, filters).slice(0, VERIFY_LIMIT);
    const verified: SimilarRow[] = [];
    for (const game of filtered) {
        const hit = findMatchedPly(game.moves, game.fen, match);
        if (!hit) continue;
        verified.push({
            key: rowKey(path, game),
            game,
            ply: hit.ply,
            fen: hit.fen,
            database: path,
        });
    }
    const rows = dedupeByKey(verified, (r) => r.key).slice(0, SIMILAR_ROW_LIMIT);
    return {
        via,
        summary: summarizeGames(verified.map((r) => r.game)),
        rows,
        approximate: true,
        sample: { candidates, checked: filtered.length, verified: verified.length },
    };
}

async function samePositionLichess(query: SimilarQuery, deps: SimilarDeps): Promise<SimilarResult> {
    const { fen, filters, lane, source } = query;
    const match = buildMatchQuery(fen, "position");
    if (!match) throw new Error("Search.BadFen");
    const data = await deps.lichess(query);
    if (!data) throw new OfflineError();
    const top = (data.topGames ?? data.recentGames ?? []).slice(0, LICHESS_ROW_LIMIT);
    const games = await deps.lichessGames(top, {
        lane,
        masters: source.kind === "lichess-masters",
    });
    const rows: SimilarRow[] = applyFilters(games, filters).map((game) => {
        const hit = findMatchedPly(game.moves, game.fen, match);
        return {
            key: rowKey(null, game),
            game,
            ply: hit?.ply ?? plyFromFen(fen),
            fen: hit?.fen ?? fen,
            database: null,
        };
    });
    let summary = summarizeStats(
        data.moves.map((m) => ({
            white: m.white,
            draw: m.draws,
            black: m.black,
            avg_elo: m.averageRating,
        })),
    );
    if (filters.decisiveOnly) summary = withDecisiveOnly(summary);
    return { via: "lichess", summary, rows, approximate: false, sample: null };
}

/** The drawer's data for one tab; throws `OfflineError` / `Error("Search.LocalOnly")` where it cannot run. */
export async function fetchSimilar(
    query: SimilarQuery,
    deps: SimilarDeps = defaultDeps,
): Promise<SimilarResult> {
    const { source, mode } = query;
    if (source.kind === "local") {
        return mode === "position"
            ? samePositionLocal(source.path, query, deps)
            : samePawnsLocal(source.path, query, deps);
    }
    if (source.kind === "chessdb") throw new Error("Sources.Unsupported");
    if (mode !== "position") throw new Error("Search.LocalOnly");
    return samePositionLichess(query, deps);
}

/**
 * What the drawer shows instead of fetching: online sources only answer 相同局面.
 * Keys returned here and thrown above, listed for the extractor:
 * t("Search.LocalOnly") t("Search.BadFen") t("Sources.Unsupported")
 */
export function similarUnavailableKey(source: Source, mode: SimilarMode): string | null {
    if (source.kind === "chessdb") return "Sources.Unsupported";
    if (source.kind !== "local" && mode !== "position") return "Search.LocalOnly";
    return null;
}

export { EMPTY_SUMMARY };
