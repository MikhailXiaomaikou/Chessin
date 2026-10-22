import { INITIAL_FEN } from "chessops/fen";
import type { TFunction } from "i18next";
import type { NormalizedGame, Outcome } from "@/bindings";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import type { Opening } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import { plyFromFen } from "./fen";
import type { IndexFilter, IndexMoveStats, IndexState } from "./types";

/**
 * Pure mappings between the position index (S3-1), En Croissant's explorer
 * rows and the "查找相似" drawer: result codes, filters, summaries, dedupe.
 */

/** Plies from the game start the index covers (S3-1's `MAX_PLY`). */
export const MAX_INDEX_PLY = 40;

// ---------------------------------------------------------------------------
// Explorer rows

/** `IndexMoveStats` → the explorer's `Opening` rows ("*" = game ended here, like `search_position`). */
export function toOpenings(moves: readonly IndexMoveStats[]): Opening[] {
    return moves.map((m) => ({
        move: m.san && m.san !== "" ? m.san : "*",
        white: m.white,
        black: m.black,
        draw: m.draw,
    }));
}

/** Most played first (same order the panel applies to `search_position`). */
export function sortOpenings(openings: Opening[]): Opening[] {
    return [...openings].sort((a, b) => b.black + b.draw + b.white - (a.black + a.draw + a.white));
}

/** Row of S3-1's `index_games` (`IndexGame` in the generated bindings). */
export type IndexGameRow = {
    id: number;
    white: string;
    black: string;
    white_elo: number | null;
    black_elo: number | null;
    /** `1-0`, `0-1`, `1/2-1/2` or `*`. */
    result: string;
    date: string | null;
    event: string;
    site: string;
    eco: string | null;
    ply_count: number | null;
    /** Start position; null for the standard one. */
    fen: string | null;
    /** SAN main line without the result token. */
    moves: string;
};

function outcomeOf(result: string): Outcome {
    return result === "1-0" || result === "0-1" || result === "1/2-1/2" ? result : "*";
}

/**
 * `IndexGame` → the `NormalizedGame` shape the explorer table, the drawer
 * rows and `openInWorkspace` use. Player / event / site ids are not part of
 * the index row and are 0 (like Lichess games in the explorer).
 */
export function toNormalizedGame(row: IndexGameRow): NormalizedGame {
    return {
        id: row.id,
        fen: row.fen && row.fen.trim() !== "" ? row.fen : INITIAL_FEN,
        event: row.event ?? "",
        event_id: 0,
        site: row.site ?? "",
        site_id: 0,
        date: row.date ?? null,
        time: null,
        round: null,
        white: row.white ?? "",
        white_id: 0,
        white_elo: row.white_elo ?? null,
        black: row.black ?? "",
        black_id: 0,
        black_elo: row.black_elo ?? null,
        result: outcomeOf(row.result),
        time_control: null,
        eco: row.eco ?? null,
        ply_count: row.ply_count ?? null,
        moves: row.moves ?? "",
    };
}

// ---------------------------------------------------------------------------
// Filters

/** `LocalOptions.result` → the index's PGN result code. */
export function indexResultOf(result: LocalOptions["result"] | undefined): string | undefined {
    switch (result) {
        case "whitewon":
            return "1-0";
        case "blackwon":
            return "0-1";
        case "draw":
            return "1/2-1/2";
        default:
            return undefined;
    }
}

/**
 * The year of a `YYYY.MM.DD` panel date when it is a whole-year boundary
 * (`YYYY.01.01` for a start date, `YYYY.12.31` for an end date, or a bare
 * `YYYY`); `undefined` when there is no date; `null` when the date cuts a
 * year (the index filters by year only, so such a query must fall back).
 */
export function wholeYearOf(
    date: string | undefined,
    kind: "start" | "end",
): number | null | undefined {
    if (!date || date.trim() === "") return undefined;
    const m = /^(\d{4})(?:[.-](\d{2})[.-](\d{2}))?$/.exec(date.trim());
    if (!m) return null;
    const year = Number.parseInt(m[1], 10);
    if (!m[2]) return year;
    const boundary = kind === "start" ? "0101" : "1231";
    return `${m[2]}${m[3]}` === boundary ? year : null;
}

/** Why the explorer stays on `search_position` for a query, or `null` when the index serves it. */
export type IndexFallbackReason =
    | "unavailable"
    | "not_ready"
    | "partial"
    | "ply"
    | "player"
    | "dates";

export function indexFallbackReason(
    options: Pick<LocalOptions, "fen" | "type" | "player" | "start_date" | "end_date">,
    state: IndexState,
    available = true,
): IndexFallbackReason | null {
    if (!available) return "unavailable";
    if (state !== "ready") return "not_ready";
    if (options.type !== "exact") return "partial";
    if (plyFromFen(options.fen) > MAX_INDEX_PLY) return "ply";
    // Player filters stay on the brute-force path in v0 (the index has no player ids).
    if (options.player !== null && options.player !== undefined) return "player";
    if (wholeYearOf(options.start_date, "start") === null) return "dates";
    if (wholeYearOf(options.end_date, "end") === null) return "dates";
    return null;
}

/** The panel's result / date filters as an `IndexFilter` (call after `indexFallbackReason` is null). */
export function indexFilterFor(
    options: Pick<LocalOptions, "result" | "start_date" | "end_date">,
): IndexFilter {
    const filter: IndexFilter = {};
    const result = indexResultOf(options.result);
    if (result) filter.result = result;
    const from = wholeYearOf(options.start_date, "start");
    if (typeof from === "number") filter.year_from = from;
    const to = wholeYearOf(options.end_date, "end");
    if (typeof to === "number") filter.year_to = to;
    return filter;
}

/** Drawer filter chips. */
export type SimilarFilters = {
    /** Both players at least this strong; unrated games are excluded. */
    minElo: number | null;
    decisiveOnly: boolean;
    yearFrom: number | null;
};

export const DEFAULT_SIMILAR_FILTERS: SimilarFilters = {
    minElo: null,
    decisiveOnly: false,
    yearFrom: null,
};

export type GameResult = "white" | "draw" | "black" | "unknown";

export function resultOf(game: Pick<NormalizedGame, "result">): GameResult {
    switch (game.result) {
        case "1-0":
            return "white";
        case "0-1":
            return "black";
        case "1/2-1/2":
            return "draw";
        default:
            return "unknown";
    }
}

export function yearOf(game: Pick<NormalizedGame, "date">): number | null {
    const m = /^(\d{4})/.exec(game.date ?? "");
    if (!m) return null;
    const year = Number.parseInt(m[1], 10);
    return year > 0 ? year : null;
}

export function passesFilters(
    game: Pick<NormalizedGame, "result" | "date" | "white_elo" | "black_elo">,
    filters: SimilarFilters,
): boolean {
    if (filters.minElo !== null) {
        const w = game.white_elo ?? 0;
        const b = game.black_elo ?? 0;
        if (w < filters.minElo || b < filters.minElo) return false;
    }
    if (filters.decisiveOnly) {
        const r = resultOf(game);
        if (r !== "white" && r !== "black") return false;
    }
    if (filters.yearFrom !== null) {
        const year = yearOf(game);
        if (year === null || year < filters.yearFrom) return false;
    }
    return true;
}

export function applyFilters<
    G extends Pick<NormalizedGame, "result" | "date" | "white_elo" | "black_elo">,
>(games: readonly G[], filters: SimilarFilters): G[] {
    return games.filter((g) => passesFilters(g, filters));
}

/** True when a chip cannot be pushed into the backend query and must run on the sample. */
export function hasClientOnlyFilters(filters: SimilarFilters, via: "index" | "scan"): boolean {
    if (filters.decisiveOnly) return true;
    if (via === "scan" && filters.minElo !== null) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Summary line

export type Summary = {
    games: number;
    white: number;
    draw: number;
    black: number;
    /** Rounded average rating, or null when nothing is rated. */
    avgElo: number | null;
};

export const EMPTY_SUMMARY: Summary = { games: 0, white: 0, draw: 0, black: 0, avgElo: null };

type StatsLike = {
    white: number;
    draw: number;
    black: number;
    games?: number;
    avg_elo?: number;
};

/** Totals over per-move statistics; the rating is weighted by games when present. */
export function summarizeStats(moves: readonly StatsLike[]): Summary {
    let white = 0;
    let draw = 0;
    let black = 0;
    let eloWeight = 0;
    let eloSum = 0;
    for (const m of moves) {
        white += m.white;
        draw += m.draw;
        black += m.black;
        const games = m.games ?? m.white + m.draw + m.black;
        if (m.avg_elo && m.avg_elo > 0 && games > 0) {
            eloWeight += games;
            eloSum += m.avg_elo * games;
        }
    }
    return {
        games: white + draw + black,
        white,
        draw,
        black,
        avgElo: eloWeight > 0 ? Math.round(eloSum / eloWeight) : null,
    };
}

/** Totals over a list of games; the rating averages every known (non-zero) Elo. */
export function summarizeGames(
    games: readonly Pick<NormalizedGame, "result" | "white_elo" | "black_elo">[],
): Summary {
    let white = 0;
    let draw = 0;
    let black = 0;
    let eloCount = 0;
    let eloSum = 0;
    for (const g of games) {
        switch (resultOf(g)) {
            case "white":
                white += 1;
                break;
            case "black":
                black += 1;
                break;
            default:
                draw += 1;
        }
        for (const elo of [g.white_elo, g.black_elo]) {
            if (elo && elo > 0) {
                eloCount += 1;
                eloSum += elo;
            }
        }
    }
    return {
        games: games.length,
        white,
        draw,
        black,
        avgElo: eloCount > 0 ? Math.round(eloSum / eloCount) : null,
    };
}

/** The summary without the draws (the "只看分出胜负" chip). */
export function withDecisiveOnly(summary: Summary): Summary {
    return {
        ...summary,
        draw: 0,
        games: summary.white + summary.black,
    };
}

function pct(part: number, total: number): number {
    return total > 0 ? Math.round((100 * part) / total) : 0;
}

/** "1,240 盘 · 白胜 56% · 和 31% · 平均 2410 分" (`Search.Summary`), or `Search.Empty`. */
export function formatSummary(summary: Summary, t: TFunction): string {
    if (summary.games <= 0) return t("Search.Empty");
    const values = {
        games: formatNumber(summary.games),
        white: pct(summary.white, summary.games),
        draw: pct(summary.draw, summary.games),
        elo: summary.avgElo ?? 0,
    };
    return summary.avgElo === null
        ? t("Search.Summary.NoElo", values)
        : t("Search.Summary", values);
}

// ---------------------------------------------------------------------------
// Dedupe

/**
 * Removes repeated keys, keeping the entry with the lowest `ply` (a game can
 * reach a position twice; the index may list both postings). First-seen
 * order of keys is preserved.
 */
export function dedupeByKey<T extends { ply: number }>(
    items: readonly T[],
    keyOf: (item: T) => string,
): T[] {
    const best = new Map<string, T>();
    for (const item of items) {
        const key = keyOf(item);
        const existing = best.get(key);
        if (!existing || item.ply < existing.ply) best.set(key, item);
    }
    return Array.from(best.values());
}

/** Unique ids in first-seen order. */
export function uniqueIds(ids: readonly number[]): number[] {
    return Array.from(new Set(ids));
}

/**
 * Groups sorted ids into `[lo, hi]` ranges, starting a new range when two
 * consecutive ids are more than `maxGap` apart. `getGamesByIds` fetches one
 * window per range.
 */
export function clusterIds(sortedIds: readonly number[], maxGap: number): [number, number][] {
    const out: [number, number][] = [];
    for (const id of sortedIds) {
        const last = out[out.length - 1];
        if (last && id - last[1] <= maxGap) last[1] = id;
        else out.push([id, id]);
    }
    return out;
}
