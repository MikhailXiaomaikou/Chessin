import { commands } from "@/chessin/bindings";
import { notifications } from "@mantine/notifications";
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommand } from "@/chessin/commands/registry";
import { type EnqueueJobInput, hasJobHandler, type Job } from "@/chessin/jobs/queue";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
    setKv,
} from "@/chessin/store/libraryStore";
import { workspaceReadyAtom } from "@/chessin/store/workspace";
import {
    __resetBackupForTests,
    BACKUP_DEDUPE_KEY,
    BACKUP_JOB_KIND,
    BACKUP_LAST_KEY,
    BACKUP_LAST_PATH_KEY,
    backupDailyAtom,
    backupLastAtom,
    backupNow,
    type DailyBackupDeps,
    installBackup,
    isBackupAvailable,
    isSameLocalDay,
    loadBackupLast,
    parseBackupLast,
    runBackup,
    runBackupJob,
    scheduleDailyBackup,
    shouldRunDailyBackup,
} from "./backup";

type DailyBackup = NonNullable<DailyBackupDeps["backup"]>;
type Enqueue = (input: EnqueueJobInput) => Promise<Job>;

const NOON = new Date(2026, 9, 22, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function job(partial: Partial<Job> = {}): Job {
    const now = Date.now();
    return {
        id: "job-1",
        kind: BACKUP_JOB_KIND,
        title: "backup",
        status: "queued",
        payload: undefined,
        progress: 0,
        createdAt: now,
        updatedAt: now,
        ...partial,
    };
}

async function flushPromises(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
    localStorage.clear();
    __resetBackupForTests();
    __setLibraryBackendForTests(createMemoryBackend());
});

afterEach(() => {
    __resetBackupForTests();
    __setLibraryBackendForTests(null);
    vi.restoreAllMocks();
});

describe("daily gate", () => {
    it("parses backup.last as milliseconds or an ISO date", () => {
        expect(parseBackupLast(null)).toBeNull();
        expect(parseBackupLast("")).toBeNull();
        expect(parseBackupLast("  ")).toBeNull();
        expect(parseBackupLast("abc")).toBeNull();
        expect(parseBackupLast("0")).toBeNull();
        expect(parseBackupLast("-5")).toBeNull();
        expect(parseBackupLast("1700000000000")).toBe(1700000000000);
        expect(parseBackupLast(" 1700000000000 ")).toBe(1700000000000);
        expect(parseBackupLast("2026-10-22T10:00:00Z")).toBe(Date.parse("2026-10-22T10:00:00Z"));
    });

    it("compares local calendar days", () => {
        expect(isSameLocalDay(NOON, NOON - 3 * HOUR)).toBe(true);
        expect(isSameLocalDay(NOON, NOON + 11 * HOUR)).toBe(true);
        expect(isSameLocalDay(NOON, NOON - DAY)).toBe(false);
        expect(isSameLocalDay(NOON, NOON + DAY)).toBe(false);
    });

    it("runs when there was no backup yet today", () => {
        expect(shouldRunDailyBackup(null, NOON)).toBe(true);
        expect(shouldRunDailyBackup(NOON, NOON)).toBe(false);
        expect(shouldRunDailyBackup(NOON - 2 * HOUR, NOON)).toBe(false);
        expect(shouldRunDailyBackup(NOON - DAY, NOON)).toBe(true);
        expect(shouldRunDailyBackup(NOON - 40 * DAY, NOON)).toBe(true);
        expect(shouldRunDailyBackup(NOON - 365 * DAY, NOON)).toBe(true);
    });
});

describe("runBackup", () => {
    it("is unavailable outside Tauri", () => {
        expect(isBackupAvailable()).toBe(false);
    });

    it("records the time and the path of the new backup", async () => {
        const store = createStore();
        const backup = vi.fn<() => Promise<string>>(
            async () => "/data/chessin/backups/library-1.sqlite",
        );
        const result = await runBackup({ store, backup, now: () => NOON });
        expect(result).toEqual({ path: "/data/chessin/backups/library-1.sqlite", at: NOON });
        expect(await getKv(BACKUP_LAST_KEY)).toBe(String(NOON));
        expect(await getKv(BACKUP_LAST_PATH_KEY)).toBe("/data/chessin/backups/library-1.sqlite");
        expect(store.get(backupLastAtom)).toBe(NOON);
    });

    it("throws when the native command is missing", async () => {
        // The bindings now carry `backupLibrary`; simulate an older build.
        const table = commands as unknown as Record<string, unknown>;
        const native = table.backupLibrary;
        delete table.backupLibrary;
        try {
            await expect(runBackup({ store: createStore() })).rejects.toThrow(
                /Backup\.Unavailable|not available|尚不支持/,
            );
        } finally {
            table.backupLibrary = native;
        }
    });

    it("loadBackupLast reads the kv into the atom", async () => {
        const store = createStore();
        expect(await loadBackupLast(store)).toBeNull();
        await setKv(BACKUP_LAST_KEY, String(NOON));
        expect(await loadBackupLast(store)).toBe(NOON);
        expect(store.get(backupLastAtom)).toBe(NOON);
    });

    it("runBackupJob notifies manual runs only", async () => {
        const show = vi.spyOn(notifications, "show").mockImplementation(() => "id");
        const backup = vi.fn<() => Promise<string>>(async () => "/b/library-2.sqlite");
        await runBackupJob(job({ payload: { reason: "daily" } }), { store: createStore(), backup });
        expect(show).not.toHaveBeenCalled();
        await runBackupJob(job({ payload: { reason: "manual" } }), {
            store: createStore(),
            backup,
        });
        expect(show).toHaveBeenCalledTimes(1);
    });
});

describe("backupNow", () => {
    it("enqueues one deduped backup job", async () => {
        const enqueue = vi.fn<Enqueue>(async (input) =>
            job({ kind: input.kind, payload: input.payload, dedupeKey: input.dedupeKey }),
        );
        const result = await backupNow({ reason: "daily", enqueue, available: () => true });
        expect(result?.kind).toBe(BACKUP_JOB_KIND);
        expect(enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: BACKUP_JOB_KIND,
                dedupeKey: BACKUP_DEDUPE_KEY,
                payload: { reason: "daily" },
            }),
        );
    });

    it("does nothing when the command is unavailable", async () => {
        const enqueue = vi.fn<Enqueue>(async (input) => job({ kind: input.kind }));
        vi.spyOn(notifications, "show").mockImplementation(() => "id");
        expect(await backupNow({ reason: "daily", enqueue, available: () => false })).toBeNull();
        expect(await backupNow({ reason: "manual", enqueue, available: () => false })).toBeNull();
        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe("scheduleDailyBackup", () => {
    it("waits for the workspace, then backs up once when none was made today", async () => {
        const store = createStore();
        const backup = vi.fn<DailyBackup>(async () => null);
        scheduleDailyBackup(store, { backup, available: () => true, now: () => NOON });
        await flushPromises();
        expect(backup).not.toHaveBeenCalled();

        store.set(workspaceReadyAtom, true);
        await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1));
        expect(backup).toHaveBeenCalledWith({ reason: "daily", store });

        // Flipping ready again does not re-run the trigger.
        store.set(workspaceReadyAtom, false);
        store.set(workspaceReadyAtom, true);
        await flushPromises();
        expect(backup).toHaveBeenCalledTimes(1);
    });

    it("skips when a backup was already made today, runs when it was yesterday", async () => {
        const store = createStore();
        store.set(workspaceReadyAtom, true);
        await setKv(BACKUP_LAST_KEY, String(NOON - HOUR));
        const backup = vi.fn<DailyBackup>(async () => null);
        scheduleDailyBackup(store, { backup, available: () => true, now: () => NOON });
        await flushPromises();
        expect(backup).not.toHaveBeenCalled();
        expect(store.get(backupLastAtom)).toBe(NOON - HOUR);

        __resetBackupForTests();
        await setKv(BACKUP_LAST_KEY, String(NOON - DAY));
        scheduleDailyBackup(store, { backup, available: () => true, now: () => NOON });
        await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1));
    });

    it("stays quiet when daily backups are off or the command is missing", async () => {
        const store = createStore();
        store.set(workspaceReadyAtom, true);
        store.set(backupDailyAtom, false);
        const backup = vi.fn<DailyBackup>(async () => null);
        scheduleDailyBackup(store, { backup, available: () => true, now: () => NOON });
        await flushPromises();
        expect(backup).not.toHaveBeenCalled();

        __resetBackupForTests();
        store.set(backupDailyAtom, true);
        scheduleDailyBackup(store, { backup, available: () => false, now: () => NOON });
        await flushPromises();
        expect(backup).not.toHaveBeenCalled();
    });

    it("is scheduled at most once per process", async () => {
        const store = createStore();
        store.set(workspaceReadyAtom, true);
        const first = vi.fn<DailyBackup>(async () => null);
        const second = vi.fn<DailyBackup>(async () => null);
        scheduleDailyBackup(store, { backup: first, available: () => true, now: () => NOON });
        scheduleDailyBackup(store, { backup: second, available: () => true, now: () => NOON });
        await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
        expect(second).not.toHaveBeenCalled();
    });
});

describe("installBackup", () => {
    it("registers the job handler and the backup.now command, idempotently", () => {
        const store = createStore();
        const off = installBackup(store);
        expect(installBackup(store)).toBe(off);
        expect(hasJobHandler(BACKUP_JOB_KIND)).toBe(true);
        const command = getCommand("backup.now");
        expect(command).toBeDefined();
        expect(command?.enabled?.()).toBe(false);
        off();
        expect(hasJobHandler(BACKUP_JOB_KIND)).toBe(false);
        expect(getCommand("backup.now")).toBeUndefined();
    });
});
