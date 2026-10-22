import type { Player, PlayerQuery, QueryResponse } from "@/bindings";
import { query_players } from "@/utils/db";
import type { PlayerResolver } from "./mapping";

/**
 * Name → `Players.ID` through `get_players` (`LIKE %name%`). An exact,
 * case-insensitive match wins; otherwise the highest-rated candidate (so
 * `Carlsen` finds Magnus rather than a namesake). Results are cached per
 * resolver, i.e. per database and bar lifetime.
 */

export type QueryPlayers = (db: string, query: PlayerQuery) => Promise<QueryResponse<Player[]>>;

export const RESOLVE_PAGE_SIZE = 10;

export function pickPlayer(name: string, candidates: Player[]): number | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    const exact = candidates.find((p) => (p.name ?? "").trim().toLowerCase() === wanted);
    if (exact) return exact.id;
    const best = candidates.reduce<Player | null>((acc, p) => {
        if (!acc) return p;
        return (p.elo ?? -1) > (acc.elo ?? -1) ? p : acc;
    }, null);
    return best ? best.id : null;
}

export function createPlayerResolver(
    file: string,
    queryPlayers: QueryPlayers = query_players,
): PlayerResolver {
    const cache = new Map<string, Promise<number | null>>();
    return (name) => {
        const key = name.trim().toLowerCase();
        if (!key) return Promise.resolve(null);
        let pending = cache.get(key);
        if (!pending) {
            pending = queryPlayers(file, {
                name: name.trim(),
                options: {
                    page: 1,
                    pageSize: RESOLVE_PAGE_SIZE,
                    skipCount: true,
                    sort: "elo",
                    direction: "desc",
                },
            })
                .then((res) => pickPlayer(name, res.data))
                .catch(() => {
                    cache.delete(key);
                    return null;
                });
            cache.set(key, pending);
        }
        return pending;
    };
}
