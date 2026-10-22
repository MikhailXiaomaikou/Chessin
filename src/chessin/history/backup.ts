import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands } from "@/chessin/bindings";
import { registerCommand } from "@/chessin/commands/registry";
import {
    type EnqueueJobInput,
    enqueueJob,
    type Job,
    registerJobHandler,
} from "@/chessin/jobs/queue";
import { getKv, hasTauri, setKv, unwrapResult } from "@/chessin/store/libraryStore";
import { workspaceReadyAtom } from "@/chessin/store/workspace";

/**
 * Library backups (S3-7).
 *
 * The copy itself is a Rust command, `backup_library() -> String` (the path
 * of the new file; `VACUUM INTO '<app_data>/chessin/backups/library-<ts>.sqlite'`,
 * seven newest kept). It is reached through a `typeof` guard, so until the
 * command is on the bindings `isBackupAvailable()` is false: the settings
 * button is disabled with a hint and the daily trigger stays quiet.
 *
 * - `backupNow({ reason })` enqueues one `kind: "backup"` job (deduped), so a
 *   backup shows in the task centre like a sync or a review.
 * - The handler runs the command and records the time in the library kv
 *   (`backup.last`, unix milliseconds as a decimal string; `backup.lastPath`
 *   holds the file). `backupLastAtom` mirrors it for the settings row.
 * - `scheduleDailyBackup` runs once per process after `workspaceReadyAtom`:
 *   when `backupDailyAtom` is on, the command exists and no backup was made
 *   today (local calendar day), it enqueues a daily backup.
 *
 * `installBackup()` wires handler, `backup.now` command and the trigger; the
 * module installs itself on import (the settings row and the board's history
 * control import it, both in eager route bundles) and is idempotent.
 */

export type BackupReason = "daily" | "manual";
export type BackupPayload = { reason: BackupReason };
export type BackupResult = { path: string; at: number };

export const BACKUP_JOB_KIND = "backup";
export const BACKUP_DEDUPE_KEY = "backup:library";
export const BACKUP_LAST_KEY = "backup.last";
export const BACKUP_LAST_PATH_KEY = "backup.lastPath";

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** "每天自动备份" — persisted, default on. */
export const backupDailyAtom = atomWithStorage<boolean>("chessin.backup.daily", true, undefined, {
    getOnInit: true,
});

/** Unix milliseconds of the last backup (null = never / not loaded yet). */
export const backupLastAtom = atom<number | null>(null);

// ---------------------------------------------------------------------------
// Native command (typeof-guarded, like `jobs/queue.ts` and `search/index.ts`)

type NativeBackupCommands = { backupLibrary?: () => Promise<unknown> };

/** The translated hint, or the key itself while i18n has no resources (tests). */
function unavailableMessage(): string {
    const text = i18n.t("Backup.Unavailable");
    return typeof text === "string" && text !== "" ? text : "Backup.Unavailable";
}

/** True when `backup_library` exists on the generated bindings (inside Tauri). */
export function isBackupAvailable(): boolean {
    return hasTauri() && typeof (commands as NativeBackupCommands).backupLibrary === "function";
}

async function nativeBackup(): Promise<string> {
    const fn = (commands as NativeBackupCommands).backupLibrary;
    if (typeof fn !== "function") throw new Error(unavailableMessage());
    const path = unwrapResult<unknown>(await fn());
    return typeof path === "string" ? path : String(path ?? "");
}

// ---------------------------------------------------------------------------
// Daily gate (pure)

/** `backup.last` as stored (decimal milliseconds; an ISO date is accepted too). */
export function parseBackupLast(raw: string | null | undefined): number | null {
    if (raw == null) return null;
    const text = raw.trim();
    if (text === "") return null;
    if (/^-?\d+(\.\d+)?$/.test(text)) {
        const n = Number(text);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isSameLocalDay(a: number, b: number): boolean {
    const da = new Date(a);
    const db = new Date(b);
    return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
    );
}

/** Once per local calendar day: true when there was no backup yet today. */
export function shouldRunDailyBackup(last: number | null, now: number = Date.now()): boolean {
    return last === null || !isSameLocalDay(last, now);
}

// ---------------------------------------------------------------------------
// Running

export type RunBackupDeps = {
    store?: JotaiStore;
    backup?: () => Promise<string>;
    now?: () => number;
};

/** Runs the native backup and records `backup.last`. Throws when unavailable. */
export async function runBackup(deps: RunBackupDeps = {}): Promise<BackupResult> {
    const store = deps.store ?? getDefaultStore();
    const backup = deps.backup ?? nativeBackup;
    const path = await backup();
    const at = (deps.now ?? Date.now)();
    await Promise.all([setKv(BACKUP_LAST_KEY, String(at)), setKv(BACKUP_LAST_PATH_KEY, path)]);
    store.set(backupLastAtom, at);
    return { path, at };
}

/** Reads `backup.last` into `backupLastAtom`; null when unset or unreadable. */
export async function loadBackupLast(
    store: JotaiStore = getDefaultStore(),
): Promise<number | null> {
    let last: number | null = null;
    try {
        last = parseBackupLast(await getKv(BACKUP_LAST_KEY));
    } catch {
        last = null;
    }
    store.set(backupLastAtom, last);
    return last;
}

export type BackupNowOptions = {
    reason: BackupReason;
    store?: JotaiStore;
    enqueue?: (input: EnqueueJobInput) => Promise<Job>;
    available?: () => boolean;
};

/**
 * Enqueues the backup job (deduped: a queued / running backup is returned as
 * is). Null when the command is unavailable. Manual runs explain themselves
 * with a notification; daily runs stay silent.
 */
export async function backupNow({
    reason,
    enqueue = enqueueJob,
    available = isBackupAvailable,
}: BackupNowOptions): Promise<Job | null> {
    if (!available()) {
        if (reason === "manual") {
            notifications.show({
                id: "chessin-backup",
                message: i18n.t("Backup.Unavailable"),
                color: "gray",
                autoClose: 4000,
            });
        }
        return null;
    }
    const before = Date.now();
    const payload: BackupPayload = { reason };
    const job = await enqueue({
        kind: BACKUP_JOB_KIND,
        title: i18n.t("Backup.JobTitle"),
        payload,
        dedupeKey: BACKUP_DEDUPE_KEY,
    });
    if (reason === "manual" && job.createdAt < before) {
        notifications.show({
            id: "chessin-backup",
            message: i18n.t("Backup.AlreadyRunning"),
            color: "gray",
            autoClose: 3000,
        });
    }
    return job;
}

function payloadReason(payload: unknown): BackupReason {
    return (payload as Partial<BackupPayload> | undefined)?.reason === "manual"
        ? "manual"
        : "daily";
}

/** Job handler body: runs the backup; manual runs get a "done" notification. */
export async function runBackupJob(job: Job, deps: RunBackupDeps = {}): Promise<BackupResult> {
    const result = await runBackup(deps);
    if (payloadReason(job.payload) === "manual") {
        notifications.show({
            id: "chessin-backup",
            message: i18n.t("Backup.Done", { path: result.path }),
            autoClose: 6000,
        });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Daily trigger

let dailyScheduled = false;

export type DailyBackupDeps = {
    backup?: (opts: { reason: BackupReason; store: JotaiStore }) => Promise<unknown>;
    available?: () => boolean;
    now?: () => number;
};

/**
 * After `workspaceReadyAtom`: when daily backups are on and the command
 * exists, enqueues a backup unless one was made today. Scheduled at most
 * once per process; returns a cancel function.
 */
export function scheduleDailyBackup(
    store: JotaiStore = getDefaultStore(),
    deps: DailyBackupDeps = {},
): () => void {
    if (dailyScheduled) return () => {};
    dailyScheduled = true;
    const backup = deps.backup ?? ((opts) => backupNow(opts));
    const available = deps.available ?? isBackupAvailable;
    const now = deps.now ?? Date.now;

    let finished = false;
    let unsub: (() => void) | null = null;
    const stop = () => {
        finished = true;
        unsub?.();
        unsub = null;
    };
    const attempt = () => {
        if (finished) return;
        if (!store.get(workspaceReadyAtom)) return;
        stop();
        if (!store.get(backupDailyAtom) || !available()) return;
        void (async () => {
            const last = await loadBackupLast(store);
            if (shouldRunDailyBackup(last, now())) await backup({ reason: "daily", store });
        })().catch((e: unknown) => {
            console.warn(`[chessin] daily backup failed: ${String(e)}`);
        });
    };
    unsub = store.sub(workspaceReadyAtom, attempt);
    attempt();
    return stop;
}

let installed: (() => void) | null = null;

/** Wires the job handler, the `backup.now` command and the daily trigger. Idempotent. */
export function installBackup(store: JotaiStore = getDefaultStore()): () => void {
    if (installed) return installed;
    const offHandler = registerJobHandler(BACKUP_JOB_KIND, (job) => runBackupJob(job, { store }));
    const offCommand = registerCommand({
        id: "backup.now",
        section: "app",
        title: () => i18n.t("Backup.Now"),
        aliases: ["backup", "back up", "备份", "立即备份", "数据备份"],
        enabled: isBackupAvailable,
        disabledReason: () => i18n.t("Backup.Unavailable"),
        run: async () => {
            await backupNow({ reason: "manual", store });
        },
    });
    const offDaily = scheduleDailyBackup(store);
    installed = () => {
        offHandler();
        offCommand();
        offDaily();
        installed = null;
    };
    return installed;
}

/** Test helper: forgets the daily flag and uninstalls. */
export function __resetBackupForTests(): void {
    dailyScheduled = false;
    installed?.();
    installed = null;
}

if (typeof window !== "undefined" && import.meta.env.MODE !== "test") {
    installBackup();
}
