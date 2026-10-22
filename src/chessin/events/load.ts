import { getDefaultStore } from "jotai";
import type { GameQuery, NormalizedGame, QueryResponse } from "@/bindings";
import {
    type AccountDatabase,
    accountDatabases,
    accountPlayerNames,
    toMyGame,
} from "@/chessin/sync/myGames";
import { query_games } from "@/utils/db";
import type { EventGameRow } from "./group";

/**
 * The user's games with their event headers: the same account databases as
 * `listMyGames` (one per linked lichess / chess.com session), but the rows
 * keep `event`, `site` and `round`, which `MyGame` drops. `query_games` is
 * injectable so the mapping is testable without Tauri.
 */

export const DEFAULT_EVENT_GAMES_LIMIT = 500;

export type QueryGames = (db: string, query: GameQuery) => Promise<QueryResponse<NormalizedGame[]>>;

type JotaiStore = ReturnType<typeof getDefaultStore>;

export function rowFromGame(
    game: NormalizedGame,
    db: AccountDatabase,
    otherNames: readonly string[] = [],
): EventGameRow {
    const mine = toMyGame(game, db, otherNames);
    return {
        key: mine.key,
        origin: mine.origin,
        database: mine.database,
        gameId: mine.gameId,
        event: game.event ?? "",
        site: game.site ?? "",
        round: game.round ?? null,
        date: mine.date,
        timestamp: mine.timestamp,
        white: mine.white,
        black: mine.black,
        whiteElo: mine.whiteElo,
        blackElo: mine.blackElo,
        result: mine.result,
        playerColor: mine.playerColor,
        timeControl: mine.timeControl ?? null,
    };
}

export type LoadEventRowsOptions = {
    /** Per-account page size (default 500). */
    limit?: number;
    store?: JotaiStore;
    queryGames?: QueryGames;
};

/** Newest first across every account database; databases that cannot be opened are skipped. */
export async function loadEventRows({
    limit = DEFAULT_EVENT_GAMES_LIMIT,
    store = getDefaultStore(),
    queryGames = query_games,
}: LoadEventRowsOptions = {}): Promise<EventGameRow[]> {
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
    const rows: EventGameRow[] = [];
    results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        for (const game of result.value.data) rows.push(rowFromGame(game, dbs[i], names));
    });
    return rows.sort((a, b) => {
        if (a.timestamp === b.timestamp) return 0;
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return b.timestamp - a.timestamp;
    });
}
