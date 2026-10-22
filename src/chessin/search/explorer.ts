import type { NormalizedGame } from "@/bindings";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import { getGamesByIds, type Opening } from "@/utils/db";
import { indexPosition } from "./index";
import { dedupeByKey, indexFilterFor, sortOpenings, toOpenings } from "./mapping";

/**
 * The explorer (DatabasePanel, local source) through the position index:
 * move statistics straight from `index_position`, sample games fetched by id.
 * Whether a query may use the index is decided by `indexFallbackReason`.
 */

/** Sample games listed in the panel's "对局" tab on the index path. */
export const EXPLORER_GAMES_LIMIT = 60;

export type IndexExplorerData = {
    openings: Opening[];
    games: NormalizedGame[];
    /** Milliseconds the index lookup itself took (shown on the chip). */
    indexMs: number;
    total: number;
};

function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export async function explorerViaIndex(
    options: LocalOptions & { path: string },
): Promise<IndexExplorerData> {
    const started = now();
    const result = await indexPosition(
        options.path,
        options.fen,
        indexFilterFor(options),
        EXPLORER_GAMES_LIMIT,
    );
    const indexMs = Math.max(0, Math.round(now() - started));
    const refs = dedupeByKey(result.games, (g) => String(g.id));
    const games = await getGamesByIds(
        options.path,
        refs.map((g) => g.id),
    );
    return {
        openings: sortOpenings(toOpenings(result.moves)),
        games,
        indexMs,
        total: result.total,
    };
}
