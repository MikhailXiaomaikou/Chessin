/**
 * Chessin: account auto-sync (S2-6).
 *
 * `syncAccounts({ reason })` enqueues one `kind: "sync"` job (deduped on
 * `SYNC_DEDUPE_KEY`) through the S2-2 job queue, so it shows in the task
 * centre and stays queued while offline. The handler, `runAccountSync`, goes
 * through every linked account: newest game date → delta download + convert
 * (the flow extracted from `AccountCard` into `./downloadAccount`) → the new
 * games (ids above the previous maximum) → a "full" review job for the most
 * recent `MAX_AUTO_REVIEWS` of them through S2-3's `enqueueReview` (loaded
 * lazily; a no-op when the module is absent) → `myGamesAtom` refresh and
 * the `Sync.Done` notification when anything new arrived.
 *
 * Startup: `scheduleStartupSync` runs the sync once after
 * `workspaceReadyAtom`, provided `autoSyncAtom` is on, offline mode is off
 * and the first-run screen is not showing (it waits, polling, while it is).
 *
 * `installAutoSync()` wires the job handler, the `sync.now` command and the
 * startup trigger. The module installs itself on import (the settings page
 * imports `autoSyncAtom`, which puts it in the eager route bundle); it is
 * idempotent, so an explicit `import "@/chessin/sync/autoSync"` from the
 * shell mounts is a harmless, clearer alternative.
 */
import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands, type NormalizedGame } from "@/bindings";
import { registerCommand } from "@/chessin/commands/registry";
import {
    type EnqueueJobInput,
    enqueueJob,
    type Job,
    type JobContext,
    registerJobHandler,
} from "@/chessin/jobs/queue";
import { firstRunDoneAtom, isFirstRunOpen } from "@/chessin/onboarding/firstRunState";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { workspaceReadyAtom } from "@/chessin/store/workspace";
import { sessionsAtom, storedDatabasesDirAtom } from "@/state/atoms";
import { query_games } from "@/utils/db";
import { getDatabasesDir } from "@/utils/directories";
import type { Session } from "@/utils/session";
import type { GameOrigin } from "@/utils/tabs";
import {
    type AccountType,
    chessComTotalGames,
    downloadAccountGames,
    getLastGameDate,
    lichessTotalGames,
} from "./downloadAccount";
import {
    type AccountDatabase,
    accountDatabaseFileName,
    accountPlayerNames,
    joinPath,
    type MyGame,
    type QueryGames,
    refreshMyGames,
    sortMyGames,
    toMyGame,
} from "./myGames";

type JotaiStore = ReturnType<typeof getDefaultStore>;

export type SyncReason = "startup" | "manual";
export type SyncPayload = { reason: SyncReason };

export const SYNC_JOB_KIND = "sync";
export const SYNC_DEDUPE_KEY = "sync:accounts";
/** Reviews enqueued per sync (newest games first); a first full download must not flood the queue. */
export const MAX_AUTO_REVIEWS = 10;
/** How often the startup trigger re-checks while the first-run screen is open. */
export const FIRST_RUN_POLL_MS = 2000;
/** Page size and page cap when scanning for games newer than the previous maximum id. */
const NEW_GAMES_PAGE_SIZE = 100;
const NEW_GAMES_MAX_PAGES = 50;

/** "启动时自动同步账号对局" — persisted, default on. */
export const autoSyncAtom = atomWithStorage<boolean>("chessin.sync.auto", true, undefined, {
    getOnInit: true,
});

export type SyncAccount = {
    type: AccountType;
    username: string;
    /** Games the site reports for the account (Lichess size estimate). */
    total: number;
    token?: string;
};

/** The accounts a sync covers, in `sessionsAtom` order. */
export function syncAccountsFromSessions(sessions: readonly Session[]): SyncAccount[] {
    const out: SyncAccount[] = [];
    for (const session of sessions) {
        if (session.lichess?.username) {
            out.push({
                type: "lichess",
                username: session.lichess.username,
                total: lichessTotalGames(session.lichess.account),
                token: session.lichess.accessToken,
            });
        }
        if (session.chessCom?.username) {
            out.push({
                type: "chesscom",
                username: session.chessCom.username,
                total: chessComTotalGames(session.chessCom.stats),
            });
        }
    }
    return out;
}

export type AccountSyncOutcome = {
    account: SyncAccount;
    dbPath: string;
    /** Games that were not in the database before this sync, newest first. */
    newGames: MyGame[];
    reviewsEnqueued: number;
    error?: string;
};

export type SyncResult = {
    reason: SyncReason;
    accounts: AccountSyncOutcome[];
    newGames: MyGame[];
    reviewsEnqueued: number;
};

/** What this module needs from S2-3 (`@/chessin/review/reviewGame`). */
export type ReviewBridge = {
    enqueueReview: (
        source: GameOrigin,
        opts: {
            playerColor?: "white" | "black";
            preset: "full";
            /** Shown in the task centre (S2-3 falls back to the raw game key). */
            title?: string;
            /** S2-3 derives the same `review:<gameKey>` itself; passed for the contract. */
            dedupeKey: string;
        },
    ) => Promise<unknown>;
    hasReview?: (gameKey: string) => Promise<boolean> | boolean;
};

export type SyncDeps = {
    store?: JotaiStore;
    databasesDir?: () => Promise<string>;
    queryGames?: QueryGames;
    /** Games currently in the database (0 when it does not exist). */
    gameCount?: (dbPath: string) => Promise<number>;
    download?: typeof downloadAccountGames;
    loadReview?: () => Promise<ReviewBridge | null>;
    notify?: (newGames: number) => void;
    refresh?: (store: JotaiStore) => void;
    maxAutoReviews?: number;
};

// ---------------------------------------------------------------------------
// Review bridge (S2-3), loaded lazily so a missing module only disables reviews.

let reviewBridgePromise: Promise<ReviewBridge | null> | null = null;

export function loadReviewBridge(): Promise<ReviewBridge | null> {
    if (!reviewBridgePromise) {
        reviewBridgePromise = import("@/chessin/review/reviewGame")
            .then((mod) => {
                const m = mod as unknown as Partial<ReviewBridge>;
                if (typeof m.enqueueReview !== "function") return null;
                return {
                    enqueueReview: m.enqueueReview,
                    hasReview: typeof m.hasReview === "function" ? m.hasReview : undefined,
                };
            })
            .catch(() => null);
    }
    return reviewBridgePromise;
}

/** Keys already handed to the review queue in this process (dedupe across syncs). */
const enqueuedReviewKeys = new Set<string>();

export function reviewDedupeKey(gameKey: string): string {
    return `review:${gameKey}`;
}

/**
 * Enqueues a "full" review for up to `maxAutoReviews` games (newest first),
 * skipping games already reviewed or already enqueued. Returns how many
 * were enqueued.
 */
export async function enqueueReviewsFor(
    games: readonly MyGame[],
    {
        loadReview = loadReviewBridge,
        maxAutoReviews = MAX_AUTO_REVIEWS,
        signal,
    }: {
        loadReview?: () => Promise<ReviewBridge | null>;
        maxAutoReviews?: number;
        signal?: AbortSignal;
    },
): Promise<number> {
    if (games.length === 0) return 0;
    const bridge = await loadReview();
    if (!bridge) return 0;
    let enqueued = 0;
    for (const game of games) {
        if (enqueued >= maxAutoReviews || signal?.aborted) break;
        if (enqueuedReviewKeys.has(game.key)) continue;
        if (bridge.hasReview && (await bridge.hasReview(game.key))) {
            enqueuedReviewKeys.add(game.key);
            continue;
        }
        await bridge.enqueueReview(game.origin, {
            playerColor: game.playerColor,
            preset: "full",
            title: `${game.white} - ${game.black}`,
            dedupeKey: reviewDedupeKey(game.key),
        });
        enqueuedReviewKeys.add(game.key);
        enqueued += 1;
    }
    return enqueued;
}

// ---------------------------------------------------------------------------
// Delta detection

/** Highest game id in the database, or null when it is empty or cannot be opened. */
export async function maxGameId(dbPath: string, queryGames: QueryGames): Promise<number | null> {
    try {
        const res = await queryGames(dbPath, {
            options: { page: 1, pageSize: 1, sort: "id", direction: "desc", skipCount: true },
        });
        return res.data[0]?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * Games whose id is above `prevMaxId` (all games when null), newest id
 * first. Ids are assigned increasingly by the importer, so this is the set
 * of games this sync added (minus what `deleteEmptyGames` removed).
 */
export async function listGamesAfterId(
    dbPath: string,
    prevMaxId: number | null,
    queryGames: QueryGames,
    pageSize = NEW_GAMES_PAGE_SIZE,
): Promise<NormalizedGame[]> {
    const out: NormalizedGame[] = [];
    for (let page = 1; page <= NEW_GAMES_MAX_PAGES; page++) {
        const res = await queryGames(dbPath, {
            options: { page, pageSize, sort: "id", direction: "desc", skipCount: true },
        });
        let done = res.data.length < pageSize;
        for (const game of res.data) {
            if (prevMaxId !== null && game.id <= prevMaxId) {
                done = true;
                break;
            }
            out.push(game);
        }
        if (done) break;
    }
    return out;
}

// ---------------------------------------------------------------------------
// The sync itself (job handler body)

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function defaultGameCount(dbPath: string): Promise<number> {
    try {
        const res = await commands.getDbInfo(dbPath);
        return res.status === "ok" ? res.data.game_count : 0;
    } catch {
        return 0;
    }
}

async function defaultDatabasesDir(store: JotaiStore): Promise<string> {
    const stored = store.get(storedDatabasesDirAtom);
    return stored || getDatabasesDir();
}

function notifySyncDone(newGames: number): void {
    notifications.show({
        id: "chessin-sync-done",
        message: i18n.t("Sync.Done", { n: newGames }),
        autoClose: 6000,
    });
}

/** Offline mode, also before the status bar has hydrated the atom (same rule as the Lichess API). */
function isOfflineNow(store: JotaiStore): boolean {
    if (store.get(offlineModeAtom)) return true;
    try {
        return localStorage.getItem("chessin.offline") === "true";
    } catch {
        return false;
    }
}

export async function runAccountSync(
    { reason, ctx }: { reason: SyncReason; ctx?: Partial<JobContext> },
    deps: SyncDeps = {},
): Promise<SyncResult> {
    const store = deps.store ?? getDefaultStore();
    const queryGames = deps.queryGames ?? query_games;
    const download = deps.download ?? downloadAccountGames;
    const gameCount = deps.gameCount ?? defaultGameCount;
    const loadReview = deps.loadReview ?? loadReviewBridge;
    const notify = deps.notify ?? notifySyncDone;
    const refresh = deps.refresh ?? refreshMyGames;
    const maxAutoReviews = deps.maxAutoReviews ?? MAX_AUTO_REVIEWS;
    const setProgress = ctx?.setProgress ?? (() => {});
    const signal = ctx?.signal;

    const result: SyncResult = { reason, accounts: [], newGames: [], reviewsEnqueued: 0 };
    // Never touch the network while offline (the runner also keeps sync jobs queued).
    if (ctx?.offline || isOfflineNow(store)) return result;
    const accounts = syncAccountsFromSessions(store.get(sessionsAtom));
    if (accounts.length === 0) return result;

    const databasesDir = await (deps.databasesDir ?? (() => defaultDatabasesDir(store)))();
    const names = accountPlayerNames(store);

    for (let i = 0; i < accounts.length; i++) {
        if (signal?.aborted) break;
        const account = accounts[i];
        const db: AccountDatabase = {
            site: account.type,
            username: account.username,
            path: joinPath(databasesDir, accountDatabaseFileName(account.username, account.type)),
        };
        const outcome: AccountSyncOutcome = {
            account,
            dbPath: db.path,
            newGames: [],
            reviewsEnqueued: 0,
        };
        const base = i / accounts.length;
        const span = 1 / accounts.length;
        setProgress(base);
        try {
            const prevMaxId = await maxGameId(db.path, queryGames);
            // Startup syncs are incremental only: the first full export of an
            // account stays user-initiated (first run or the account card).
            if (reason === "startup" && prevMaxId === null) {
                result.accounts.push(outcome);
                setProgress(base + span);
                continue;
            }
            const lastGameDate =
                prevMaxId === null
                    ? null
                    : await getLastGameDate(db.path, queryGames).catch(() => null);
            const downloaded = prevMaxId === null ? 0 : await gameCount(db.path);
            await download({
                type: account.type,
                username: account.username,
                databasesDir,
                lastGameDate,
                remaining: Math.max(0, account.total - downloaded),
                token: account.token,
                setProgress: (p) =>
                    setProgress(base + (span * Math.min(100, Math.max(0, p))) / 100),
                store,
            });
            const fresh = await listGamesAfterId(db.path, prevMaxId, queryGames);
            outcome.newGames = fresh.map((game) => toMyGame(game, db, names));
            outcome.reviewsEnqueued = await enqueueReviewsFor(outcome.newGames, {
                loadReview,
                maxAutoReviews,
                signal,
            });
        } catch (e) {
            outcome.error = errorMessage(e);
            console.warn(
                `[chessin] sync ${account.type}/${account.username} failed: ${outcome.error}`,
            );
        }
        result.accounts.push(outcome);
        result.newGames.push(...outcome.newGames);
        result.reviewsEnqueued += outcome.reviewsEnqueued;
        setProgress(base + span);
    }

    result.newGames = sortMyGames(result.newGames);
    refresh(store);
    if (result.newGames.length > 0) notify(result.newGames.length);

    // One account failing is a warning (the others synced); all of them failing
    // fails the job so the task centre shows it. Usernames and error text are
    // not translatable, so the message is assembled as is.
    const failed = result.accounts.filter((a) => a.error);
    if (failed.length > 0 && failed.length === result.accounts.length) {
        throw new Error(failed.map((a) => `${a.account.username}: ${a.error}`).join("\n"));
    }
    return result;
}

// ---------------------------------------------------------------------------
// Enqueueing, command, startup trigger

export type SyncAccountsOptions = {
    reason: SyncReason;
    store?: JotaiStore;
    /** Defaults to the job queue's `enqueueJob`. */
    enqueue?: (input: EnqueueJobInput) => Promise<Job>;
};

/**
 * Enqueues the sync job (deduped: a queued/running sync is returned as is).
 * Resolves to null when there is no linked account. Manual runs get a hint
 * when nothing can be done right now; startup runs stay silent.
 */
export async function syncAccounts({
    reason,
    store = getDefaultStore(),
    enqueue = enqueueJob,
}: SyncAccountsOptions): Promise<Job | null> {
    if (syncAccountsFromSessions(store.get(sessionsAtom)).length === 0) {
        if (reason === "manual") {
            notifications.show({
                id: "chessin-sync",
                message: i18n.t("Sync.NoAccounts"),
                color: "gray",
                autoClose: 4000,
            });
        }
        return null;
    }
    const before = Date.now();
    const payload: SyncPayload = { reason };
    const job = await enqueue({
        kind: SYNC_JOB_KIND,
        title: i18n.t("Sync.JobTitle"),
        payload,
        dedupeKey: SYNC_DEDUPE_KEY,
    });
    if (reason === "manual") {
        if (job.createdAt < before) {
            notifications.show({
                id: "chessin-sync",
                message: i18n.t("Sync.AlreadyRunning"),
                color: "gray",
                autoClose: 3000,
            });
        } else if (isOfflineNow(store)) {
            notifications.show({
                id: "chessin-sync",
                message: i18n.t("Sync.Offline"),
                color: "gray",
                autoClose: 5000,
            });
        }
    }
    return job;
}

function payloadReason(payload: unknown): SyncReason {
    return (payload as Partial<SyncPayload> | undefined)?.reason === "manual"
        ? "manual"
        : "startup";
}

let startupScheduled = false;

export type StartupSyncDeps = {
    sync?: (opts: { reason: SyncReason; store: JotaiStore }) => Promise<unknown>;
    firstRunOpen?: () => boolean;
    pollMs?: number;
};

/**
 * Runs `syncAccounts({ reason: "startup" })` once the workspace is ready,
 * unless auto-sync is off or offline mode is on at that moment; while the
 * first-run screen is showing it re-checks every `pollMs`. Scheduled at
 * most once per process. Returns a cancel function.
 */
export function scheduleStartupSync(
    store: JotaiStore = getDefaultStore(),
    deps: StartupSyncDeps = {},
): () => void {
    if (startupScheduled) return () => {};
    startupScheduled = true;
    const sync = deps.sync ?? syncAccounts;
    const firstRunOpen = deps.firstRunOpen ?? isFirstRunOpen;
    const pollMs = deps.pollMs ?? FIRST_RUN_POLL_MS;

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    const stop = () => {
        finished = true;
        unsub?.();
        unsub = null;
        if (timer) clearTimeout(timer);
        timer = null;
    };
    const attempt = () => {
        if (finished || timer) return;
        if (!store.get(workspaceReadyAtom)) return;
        if (!store.get(autoSyncAtom) || isOfflineNow(store)) {
            stop();
            return;
        }
        if (firstRunOpen() || !store.get(firstRunDoneAtom)) {
            timer = setTimeout(() => {
                timer = null;
                attempt();
            }, pollMs);
            return;
        }
        stop();
        void sync({ reason: "startup", store });
    };
    unsub = store.sub(workspaceReadyAtom, attempt);
    attempt();
    return stop;
}

let installed: (() => void) | null = null;

/** Wires the job handler, the `sync.now` command and the startup trigger. Idempotent. */
export function installAutoSync(store: JotaiStore = getDefaultStore()): () => void {
    if (installed) return installed;
    const offHandler = registerJobHandler(SYNC_JOB_KIND, (job, ctx) =>
        runAccountSync({ reason: payloadReason(job.payload), ctx }, { store }),
    );
    const offCommand = registerCommand({
        id: "sync.now",
        section: "sources",
        title: () => i18n.t("Sync.Now"),
        aliases: [
            "sync",
            "sync accounts",
            "download games",
            "lichess",
            "chess.com",
            "同步",
            "同步对局",
            "账号",
            "下载对局",
        ],
        enabled: () => syncAccountsFromSessions(store.get(sessionsAtom)).length > 0,
        disabledReason: () => i18n.t("Sync.NoAccounts"),
        run: async () => {
            await syncAccounts({ reason: "manual", store });
        },
    });
    const offStartup = scheduleStartupSync(store);
    const off = () => {
        offHandler();
        offCommand();
        offStartup();
        installed = null;
    };
    installed = off;
    return off;
}

/** Test helper: forgets the review dedupe set, the startup flag and the bridge. */
export function __resetAutoSyncForTests(): void {
    enqueuedReviewKeys.clear();
    startupScheduled = false;
    reviewBridgePromise = null;
    installed?.();
    installed = null;
}

if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
    installAutoSync();
}
