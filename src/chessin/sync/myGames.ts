/**
 * Chessin: "my games" — the user's own games across every account database
 * (`<databasesDir>/<username>_<lichess|chesscom>.db3`, one per session in
 * `sessionsAtom`), merged and sorted by date descending.
 *
 * Pure data module: no React, no UI strings. `query_games` is injectable so
 * the merge/sort logic is testable without Tauri.
 */
import { atom, getDefaultStore } from "jotai";
import type { GameQuery, NormalizedGame, QueryResponse } from "@/bindings";
import { originToString } from "@/chessin/save/saveModel";
import { sessionsAtom, storedDatabasesDirAtom } from "@/state/atoms";
import { query_games } from "@/utils/db";
import type { Session } from "@/utils/session";
import type { GameOrigin } from "@/utils/tabs";

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type MyGameSite = "lichess" | "chesscom";

export type MyGame = {
    /** `originToString({ kind: "database", database, gameId })`. */
    key: string;
    origin: GameOrigin;
    database: string;
    gameId: number;
    white: string;
    black: string;
    whiteElo: number | null;
    blackElo: number | null;
    result: string;
    /** PGN date (`YYYY.MM.DD`) as stored, or null. */
    date: string | null;
    /** `date` + `time` as a UTC timestamp (ms), when the date is complete. */
    timestamp: number | null;
    playerColor: "white" | "black";
    site: MyGameSite;
    timeControl?: string | null;
};

export type AccountDatabase = {
    site: MyGameSite;
    username: string;
    /** `<databasesDir>/<username>_<site>.db3`. */
    path: string;
};

export type QueryGames = (db: string, query: GameQuery) => Promise<QueryResponse<NormalizedGame[]>>;

export type ListMyGamesOptions = {
    /** Per-account page size and size of the merged result. Default 50. */
    limit?: number;
    /** Only games played strictly after this timestamp (ms); undated games are dropped. */
    sinceTs?: number;
    store?: JotaiStore;
    /** Defaults to `query_games` from `@/utils/db`. */
    queryGames?: QueryGames;
};

export const DEFAULT_MY_GAMES_LIMIT = 50;

/** Player names of every connected account (lichess + chess.com usernames and aliases). */
export function accountPlayerNames(store: JotaiStore = getDefaultStore()): string[] {
    const names = new Set<string>();
    for (const session of store.get(sessionsAtom) as Session[]) {
        if (session.lichess?.username) names.add(session.lichess.username);
        if (session.chessCom?.username) names.add(session.chessCom.username);
        if (session.player) names.add(session.player);
    }
    return Array.from(names);
}

export function joinPath(dir: string, file: string): string {
    if (!dir) return file;
    const sep = dir.includes("\\") ? "\\" : "/";
    return dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`;
}

/** File name of an account database, as `AccountCard` creates it. */
export function accountDatabaseFileName(username: string, site: MyGameSite): string {
    return `${username}_${site}.db3`;
}

/** The account databases implied by `sessionsAtom` (whether or not the files exist yet). */
export function accountDatabases(store: JotaiStore = getDefaultStore()): AccountDatabase[] {
    const dir = store.get(storedDatabasesDirAtom);
    const out: AccountDatabase[] = [];
    for (const session of store.get(sessionsAtom) as Session[]) {
        if (session.lichess?.username) {
            const username = session.lichess.username;
            out.push({
                site: "lichess",
                username,
                path: joinPath(dir, accountDatabaseFileName(username, "lichess")),
            });
        }
        if (session.chessCom?.username) {
            const username = session.chessCom.username;
            out.push({
                site: "chesscom",
                username,
                path: joinPath(dir, accountDatabaseFileName(username, "chesscom")),
            });
        }
    }
    return out;
}

export function myGameKey(database: string, gameId: number): string {
    return (
        originToString({ kind: "database", database, gameId }) ?? `database:${database}#${gameId}`
    );
}

/**
 * `YYYY.MM.DD` (+ optional `HH:MM:SS`) → UTC timestamp in ms, or null when
 * the date is incomplete (`????.??.??`). Unlike `getLastGameDate`, a missing
 * time counts as midnight so undated-time games still sort by day.
 */
export function parseGameTimestamp(date?: string | null, time?: string | null): number | null {
    if (!date) return null;
    const [y, m, d] = date.split(".").map(Number);
    if (!y || !m || !d) return null;
    let h = 0;
    let min = 0;
    let s = 0;
    if (time) {
        const parts = time.split(":").map(Number);
        h = Number.isFinite(parts[0]) ? parts[0] : 0;
        min = Number.isFinite(parts[1]) ? parts[1] : 0;
        s = Number.isFinite(parts[2]) ? parts[2] : 0;
    }
    const ts = Date.UTC(y, m - 1, d, h, min, s);
    return Number.isFinite(ts) ? ts : null;
}

function sameName(a: string | null | undefined, b: string): boolean {
    return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Which side the user played. The account's own username wins; aliases and
 * the other accounts' names are the fallback (a chess.com archive may spell
 * the name differently from the session). Defaults to white.
 */
export function detectPlayerColor(
    game: Pick<NormalizedGame, "white" | "black">,
    username: string,
    otherNames: readonly string[] = [],
): "white" | "black" {
    if (sameName(game.white, username)) return "white";
    if (sameName(game.black, username)) return "black";
    for (const name of otherNames) {
        if (sameName(game.white, name)) return "white";
        if (sameName(game.black, name)) return "black";
    }
    return "white";
}

export function toMyGame(
    game: NormalizedGame,
    db: AccountDatabase,
    otherNames: readonly string[] = [],
): MyGame {
    return {
        key: myGameKey(db.path, game.id),
        origin: { kind: "database", database: db.path, gameId: game.id },
        database: db.path,
        gameId: game.id,
        white: game.white,
        black: game.black,
        whiteElo: game.white_elo ?? null,
        blackElo: game.black_elo ?? null,
        result: game.result,
        date: game.date ?? null,
        timestamp: parseGameTimestamp(game.date, game.time),
        playerColor: detectPlayerColor(game, db.username, otherNames),
        site: db.site,
        timeControl: game.time_control ?? null,
    };
}

/** Newest first; undated games last (stable within equal timestamps). */
export function sortMyGames(games: MyGame[]): MyGame[] {
    return [...games].sort((a, b) => {
        if (a.timestamp === b.timestamp) return 0;
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return b.timestamp - a.timestamp;
    });
}

/**
 * The user's games across every account database, newest first. Databases
 * that cannot be opened (not downloaded yet, moved away) are skipped.
 */
export async function listMyGames({
    limit = DEFAULT_MY_GAMES_LIMIT,
    sinceTs,
    store = getDefaultStore(),
    queryGames = query_games,
}: ListMyGamesOptions = {}): Promise<MyGame[]> {
    const dbs = accountDatabases(store);
    if (dbs.length === 0) return [];
    const names = accountPlayerNames(store);

    const results = await Promise.allSettled(
        dbs.map((db) =>
            queryGames(db.path, {
                options: {
                    page: 1,
                    pageSize: limit,
                    sort: "date",
                    direction: "desc",
                    skipCount: true,
                },
            }),
        ),
    );

    const merged: MyGame[] = [];
    results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        const db = dbs[i];
        for (const game of result.value.data) {
            const mine = toMyGame(game, db, names);
            if (sinceTs !== undefined && (mine.timestamp === null || mine.timestamp <= sinceTs)) {
                continue;
            }
            merged.push(mine);
        }
    });

    return sortMyGames(merged).slice(0, limit);
}

const myGamesRefreshAtom = atom(0);

/** Async atom of `listMyGames()`; `set(myGamesAtom)` (no value) refreshes it. */
export const myGamesAtom = atom(
    async (get) => {
        get(myGamesRefreshAtom);
        return listMyGames();
    },
    (_get, set) => {
        set(myGamesRefreshAtom, (n) => n + 1);
    },
);

export function refreshMyGames(store: JotaiStore = getDefaultStore()): void {
    store.set(myGamesAtom);
}
