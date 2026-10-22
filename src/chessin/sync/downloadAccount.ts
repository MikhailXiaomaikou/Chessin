/**
 * Chessin: the account download flow, extracted verbatim from
 * `src/components/home/AccountCard.tsx` so the auto-sync job can run it
 * without the card. The card still calls it from its download button.
 *
 * Steps (unchanged): download the delta since the newest game in the
 * account's .db3 (Lichess export / Chess.com archives → `<username>_<type>.pgn`),
 * convert that PGN into `<username>_<type>.db3` (publishing progress on
 * `databaseConversionStateAtom` and the `<type>_<username>` progress event
 * the card listens to), then `deleteEmptyGames`.
 */
import { basename, resolve } from "@tauri-apps/api/path";
import { info } from "@tauri-apps/plugin-log";
import { getDefaultStore } from "jotai";
import { commands, events } from "@/bindings";
import { databaseConversionStateAtom } from "@/state/atoms";
import { type ChessComStats, downloadChessCom } from "@/utils/chess.com/api";
import { query_games } from "@/utils/db";
import { downloadLichess, type LichessAccount } from "@/utils/lichess/api";
import { unwrap } from "@/utils/unwrap";

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type AccountType = "lichess" | "chesscom";

/**
 * UTC timestamp (ms) of the newest game in the database, or null when the
 * database has no dated game (or cannot be opened). Same rule as the card:
 * both `date` and `time` must be present.
 */
export async function getLastGameDate(
    databaseFile: string,
    queryGames: typeof query_games = query_games,
): Promise<number | null> {
    const games = await queryGames(databaseFile, {
        options: {
            page: 1,
            pageSize: 1,
            sort: "date",
            direction: "desc",
            skipCount: false,
        },
    });
    if (games.count! > 0 && games.data[0].date && games.data[0].time) {
        const [year, month, day] = games.data[0].date.split(".").map(Number);
        const [hour, minute, second] = games.data[0].time.split(":").map(Number);
        return Date.UTC(year, month - 1, day, hour, minute, second);
    }
    return null;
}

/** Title the converted database gets (`<username> Lichess` / `<username> Chess.com`). */
export function accountDatabaseTitle(username: string, type: AccountType): string {
    return username + (type === "lichess" ? " Lichess" : " Chess.com");
}

/** Total rated games of a Lichess account, as `AccountCards` computes it. */
export function lichessTotalGames(account: LichessAccount | undefined): number {
    const perfs = account?.perfs;
    return (
        (perfs?.ultraBullet?.games ?? 0) +
        (perfs?.bullet?.games ?? 0) +
        (perfs?.blitz?.games ?? 0) +
        (perfs?.rapid?.games ?? 0) +
        (perfs?.classical?.games ?? 0) +
        (perfs?.correspondence?.games ?? 0)
    );
}

/** Total games of a Chess.com account, as `AccountCards` computes it. */
export function chessComTotalGames(stats: ChessComStats | undefined): number {
    let total = 0;
    if (!stats) return 0;
    for (const stat of Object.values(stats)) {
        if (stat?.record) {
            total += stat.record.win + stat.record.loss + stat.record.draw;
        }
    }
    return total;
}

export type ConvertAccountPgnInput = {
    type: AccountType;
    username: string;
    databasesDir: string;
    pgnPath: string;
    /** `getLastGameDate` result: games at or before it are skipped by the importer. */
    timestamp: number | null;
    store?: JotaiStore;
};

/** `AccountCard.convert`: PGN → `<databasesDir>/<basename>.db3`. Resolves to the .db3 path. */
export async function convertAccountPgn({
    type,
    username,
    databasesDir,
    pgnPath,
    timestamp,
    store = getDefaultStore(),
}: ConvertAccountPgnInput): Promise<string> {
    info(`converting ${pgnPath} ${timestamp}`);
    const filename = accountDatabaseTitle(username, type);
    const dbPath = await resolve(
        databasesDir,
        `${pgnPath
            .split(/(\\|\/)/g)
            .pop()
            ?.replace(".pgn", ".db3")}`,
    );
    const sourceFileName = await basename(pgnPath);
    store.set(databaseConversionStateAtom, (prev) => ({
        ...prev,
        inProgress: true,
        targetDatabasePath: dbPath,
        targetDatabaseTitle: filename,
        sourceFileName,
    }));
    unwrap(
        await commands.convertPgn(
            [pgnPath],
            dbPath,
            timestamp ? timestamp / 1000 : null,
            filename,
            null,
        ),
    );
    events.progressEvent.emit({
        id: `${type}_${username}`,
        progress: 100,
        finished: true,
    });
    return dbPath;
}

export type DownloadAccountGamesInput = {
    type: AccountType;
    username: string;
    databasesDir: string;
    /** From `getLastGameDate`; null downloads everything. */
    lastGameDate: number | null;
    /** Lichess only: games still missing (`total - downloaded`), used for the size estimate. */
    remaining: number;
    /** Lichess OAuth token when the account was linked with a login. */
    token?: string;
    /** Download progress 0..100 (Lichess reports it; Chess.com emits events instead). */
    setProgress?: (progress: number) => void;
    store?: JotaiStore;
};

export type DownloadAccountGamesResult = {
    pgnPath: string;
    dbPath: string;
    /** False when conversion / cleanup threw (logged, as the card did). */
    converted: boolean;
};

/**
 * The card's download-button flow. Download errors propagate; conversion
 * errors are logged and reported through `converted: false`, and the
 * conversion state atom is always reset afterwards.
 */
export async function downloadAccountGames({
    type,
    username,
    databasesDir,
    lastGameDate,
    remaining,
    token,
    setProgress = () => {},
    store = getDefaultStore(),
}: DownloadAccountGamesInput): Promise<DownloadAccountGamesResult> {
    if (type === "lichess") {
        await downloadLichess(username, lastGameDate, remaining, setProgress, token);
    } else {
        await downloadChessCom(username, lastGameDate);
    }
    const pgnPath = await resolve(databasesDir, `${username}_${type}.pgn`);
    const dbPath = pgnPath.replace(".pgn", ".db3");
    let converted = false;
    try {
        await convertAccountPgn({
            type,
            username,
            databasesDir,
            pgnPath,
            timestamp: lastGameDate,
            store,
        });
        await commands.deleteEmptyGames(dbPath);
        converted = true;
    } catch (e) {
        console.error(e);
    } finally {
        store.set(databaseConversionStateAtom, (prev) => ({
            ...prev,
            inProgress: false,
            totalGames: 0,
            elapsedSeconds: 0,
            targetDatabasePath: null,
            targetDatabaseTitle: null,
            sourceFileName: null,
        }));
    }
    return { pgnPath, dbPath, converted };
}
