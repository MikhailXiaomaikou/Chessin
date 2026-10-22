/**
 * Types of S3-1's position-index commands (`index_build`, `index_status`,
 * `index_delete`, `index_position`, `index_pawn_candidates`), spelled the way
 * the generated bindings will expose them (snake_case payload fields). Kept in
 * their own module so the pure helpers in `mapping.ts` do not pull in the
 * wrappers (and their Tauri / job-queue imports).
 */

export type IndexStats = {
    games: number;
    postings: number;
    bytes: number;
    max_game_id: number;
    /** Unix seconds or milliseconds as the plugin reports it. */
    built_at: number;
};

export type IndexFilter = {
    min_elo?: number | null;
    max_elo?: number | null;
    /** `"1-0" | "0-1" | "1/2-1/2"`. */
    result?: string | null;
    year_from?: number | null;
    year_to?: number | null;
};

export type IndexMoveStats = {
    uci: string;
    san: string;
    white: number;
    draw: number;
    black: number;
    games: number;
    avg_elo: number;
    last_year: number;
};

export type IndexGameRef = { id: number; ply: number };

export type IndexPositionResult = {
    ply: number;
    moves: IndexMoveStats[];
    games: IndexGameRef[];
    total: number;
};

/** Payload of the plugin event `chessin://index-progress`. */
export type IndexProgressPayload = {
    db_path: string;
    /** 0..1 (or 0..100; both are accepted). */
    progress: number;
    finished: boolean;
};

/**
 * `unknown` until the first `index_status` answer; `none` = no sidecar (or the
 * commands are missing from this build); `building` = a job is queued or
 * running; `ready` = the index can serve queries.
 */
export type IndexState = "unknown" | "none" | "building" | "ready";
