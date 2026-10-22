import { getDefaultStore } from "jotai";
import { commands, type NormalizedGame } from "@/bindings";
import { gameKeyForOrigin } from "@/chessin/review/model";
import { getDoc } from "@/chessin/store/libraryStore";
import type { OpenTabArgs } from "@/chessin/workspace/openInWorkspace";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { writeSessionMirror } from "@/state/store/debouncedStorage";
import { parsePGN } from "@/utils/chess";
import { query_games } from "@/utils/db";
import type { GameOrigin, Tab } from "@/utils/tabs";

/**
 * From a card's `source.gameKey` back to the game: parsing the key
 * (`file:<path>#<n>`, `database:<path>#<id>`, `library:<docId>`), loading the
 * PGN and opening it in the board workspace through S2-6's `openInWorkspace`.
 */

export type ParsedGameKey =
    | { kind: "file"; path: string; gameNumber: number }
    | { kind: "database"; database: string; gameId: number }
    | { kind: "library"; docId: string };

export function parseGameKey(key: string): ParsedGameKey | null {
    if (key.startsWith("file:")) {
        const split = splitHash(key.slice("file:".length));
        return split ? { kind: "file", path: split.head, gameNumber: split.n } : null;
    }
    if (key.startsWith("database:")) {
        const split = splitHash(key.slice("database:".length));
        return split ? { kind: "database", database: split.head, gameId: split.n } : null;
    }
    if (key.startsWith("library:")) {
        const docId = key.slice("library:".length);
        return docId ? { kind: "library", docId } : null;
    }
    return null;
}

function splitHash(rest: string): { head: string; n: number } | null {
    const hash = rest.lastIndexOf("#");
    if (hash <= 0) return null;
    const n = Number(rest.slice(hash + 1));
    if (!Number.isInteger(n)) return null;
    return { head: rest.slice(0, hash), n };
}

export function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

/** Short human label for a key when the card has no title: `games.pgn #3`, `lichess_x.db3 #120`. */
export function gameKeyLabel(key: string): string {
    const parsed = parseGameKey(key);
    if (!parsed) return key;
    switch (parsed.kind) {
        case "file":
            return `${baseName(parsed.path)} #${parsed.gameNumber + 1}`;
        case "database":
            return `${baseName(parsed.database)} #${parsed.gameId}`;
        case "library":
            return parsed.docId;
    }
}

/** Tree path of the position before `ply` (1-based) on the main line. */
export function mainLinePath(ply: number): number[] {
    const n = Math.max(0, Math.floor(ply) - 1);
    return Array.from({ length: n }, () => 0);
}

/**
 * Finds a game by id in a .db3 database. `get_games` has no id filter, but
 * ids are assigned in insertion order, so sorted by id the game sits on page
 * `id` unless games were deleted; then a binary search over pages of one.
 */
export async function findDatabaseGame(
    database: string,
    gameId: number,
    maxProbes = 40,
): Promise<NormalizedGame | null> {
    const probe = async (page: number, skipCount: boolean) =>
        query_games(database, {
            options: { skipCount, page, pageSize: 1, sort: "id", direction: "asc" },
        });
    const first = await probe(1, false);
    const count = first.count ?? first.data.length;
    if (count <= 0) return null;
    if (first.data[0]?.id === gameId) return first.data[0];
    if (gameId > 1 && gameId <= count) {
        const guess = await probe(gameId, true);
        if (guess.data[0]?.id === gameId) return guess.data[0];
    }
    let lo = 1;
    let hi = count;
    for (let i = 0; i < maxProbes && lo <= hi; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const game = (await probe(mid, true)).data[0];
        if (!game) break;
        if (game.id === gameId) return game;
        if (game.id < gameId) lo = mid + 1;
        else hi = mid - 1;
    }
    return null;
}

/** What `openInWorkspace` needs to show the game (S2-6's `OpenTabArgs`). */
export type LoadedGame = OpenTabArgs;

/** Loads the PGN + origin of a key for `openInWorkspace`; `null` when the source is gone. */
export async function loadGameForKey(key: string, ply?: number): Promise<LoadedGame | null> {
    const parsed = parseGameKey(key);
    if (!parsed) return null;
    const position = ply !== undefined ? mainLinePath(ply) : undefined;
    if (parsed.kind === "file") {
        const [pgnResult, countResult] = await Promise.all([
            commands.readGames(parsed.path, parsed.gameNumber, parsed.gameNumber),
            commands.countPgnGames(parsed.path),
        ]);
        if (pgnResult.status === "error") return null;
        const pgn = pgnResult.data[0];
        if (!pgn) return null;
        const numGames = countResult.status === "ok" ? countResult.data : parsed.gameNumber + 1;
        const tree = await parsePGN(pgn);
        const name = baseName(parsed.path);
        const gameOrigin: GameOrigin = {
            kind: "file",
            gameNumber: parsed.gameNumber,
            file: {
                type: "file",
                name,
                path: parsed.path,
                numGames,
                metadata: { type: "game", tags: [] },
                lastModified: Math.floor(Date.now() / 1000),
            },
        };
        return {
            tab: { name: name.replace(/\.pgn$/i, ""), type: "analysis" },
            pgn,
            headers: tree.headers,
            gameOrigin,
            position,
        };
    }
    if (parsed.kind === "database") {
        const game = await findDatabaseGame(parsed.database, parsed.gameId);
        if (!game) return null;
        return {
            tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
            pgn: game.moves,
            headers: game,
            gameOrigin: { kind: "database", database: parsed.database, gameId: parsed.gameId },
            position,
        };
    }
    const doc = await getDoc(parsed.docId);
    if (!doc) return null;
    return {
        tab: { name: doc.title || parsed.docId, type: "analysis" },
        gameOrigin: { kind: "library", docId: parsed.docId },
    };
}

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type OpenGameOptions = {
    ply?: number;
    /** Creates the tab and shows the board (S2-6's `useOpenInWorkspace()` result). */
    open: (args: LoadedGame) => Promise<string>;
    /** Shows the board without creating a tab (an already open tab was activated). */
    focus: () => void;
    store?: JotaiStore;
};

/**
 * Opens the game behind `key`: activates the tab that already shows it, or
 * loads it and creates one. Resolves false when the source cannot be found.
 */
export async function openGameForKey(key: string, opts: OpenGameOptions): Promise<boolean> {
    const store = opts.store ?? getDefaultStore();
    const tabs = store.get(tabsAtom);
    const open = tabs.find((tab) => gameKeyForOrigin(tab.gameOrigin) === key);
    if (open) {
        store.set(activeTabAtom, open.value);
        opts.focus();
        return true;
    }
    const loaded = await loadGameForKey(key, opts.ply);
    if (!loaded) return false;
    if (loaded.gameOrigin?.kind === "library") {
        // Library documents are keyed by their tab id: open the document under
        // its own id (with its data as the session mirror) so autosave keeps
        // writing the same document instead of forking a copy.
        const docId = loaded.gameOrigin.docId;
        const doc = await getDoc(docId);
        if (!doc) return false;
        writeSessionMirror(docId, doc.data);
        const tab: Tab = { ...loaded.tab, value: docId, gameOrigin: loaded.gameOrigin };
        store.set(tabsAtom, [...store.get(tabsAtom), tab]);
        store.set(activeTabAtom, docId);
        opts.focus();
        return true;
    }
    await opts.open(loaded);
    return true;
}
