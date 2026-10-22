import { atom, getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands } from "@/chessin/bindings";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { hasTauri, unwrapResult } from "@/chessin/store/libraryStore";

/**
 * Background job queue (S2-2).
 *
 * - `enqueueJob` adds a job; `registerJobHandler(kind, fn)` says how a kind runs.
 * - `startJobRunner()` (once, from `ChessinMounts` after `workspaceReadyAtom`)
 *   loads the persisted jobs, re-queues anything left `running` by a crash and
 *   runs the queue with concurrency 1 in creation order.
 * - Every transition is written through the plugin's `job_*` commands when
 *   they exist on the generated bindings (`typeof` check, same policy as
 *   `libraryStore.ts`); otherwise an in-memory backend with the same semantics
 *   is used (vitest, browser dev server, builds before S2-1 landed).
 * - `pauseJobsAtom` (persisted) stops new jobs from starting; `offlineModeAtom`
 *   keeps `kind === "sync"` jobs queued and is handed to handlers as `ctx.offline`.
 * - A queued job whose kind has no handler fails with `Jobs.NoHandler` — except
 *   during a short grace period after the runner starts, so handlers registered
 *   by lazily imported modules can still pick up jobs restored from disk.
 */

export type JobKind = "review" | "sync" | "import" | (string & {});

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type Job = {
    id: string;
    kind: JobKind;
    /** Already translated; shown as-is in the task centre. */
    title: string;
    status: JobStatus;
    payload: unknown;
    /** 0..1 (`setProgress` also accepts percentages: values above 1 are divided by 100). */
    progress: number;
    result?: unknown;
    /** Message, or a translation key such as `Jobs.NoHandler`. */
    error?: string;
    /** Unix milliseconds. */
    createdAt: number;
    updatedAt: number;
    dedupeKey?: string;
};

export type JobContext = {
    setProgress(p: number): void;
    /** Aborted by `cancelJob`; handlers are expected to stop promptly. */
    signal: AbortSignal;
    /** `offlineModeAtom` when the job started. */
    offline: boolean;
};

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

export type EnqueueJobInput = {
    kind: JobKind;
    title: string;
    payload?: unknown;
    /** A queued or running job with the same key is returned instead of a new one. */
    dedupeKey?: string;
};

/** Row of the `jobs` table (S2-1 `JobRecord`, snake_case like the Rust struct). */
export type JobRecord = {
    id: string;
    kind: string;
    title: string;
    status: string;
    payload: string;
    progress: number;
    result: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
};

export interface JobBackend {
    readonly native: boolean;
    upsert(record: JobRecord): Promise<void>;
    /** Newest first, running + queued first (the order the plugin returns). */
    list(status: string | null): Promise<JobRecord[]>;
    delete(id: string): Promise<void>;
    /** Deletes the oldest done / failed / cancelled rows beyond `keepFinished`; returns the count. */
    prune(keepFinished: number): Promise<number>;
}

export type StartJobRunnerOptions = {
    store?: JotaiStore;
    /** Milliseconds after start during which jobs without a handler stay queued. */
    handlerGraceMs?: number;
};

/** Error string of a job whose kind has no registered handler (a translation key). */
export const NO_HANDLER_ERROR = "Jobs.NoHandler";
/** Finished jobs kept in the store / shown in the task centre. */
export const KEEP_FINISHED = 50;
/** Default grace for late handler registration after `startJobRunner`. */
export const HANDLER_GRACE_MS = 10_000;
/** A cancelled handler that ignores its signal frees the runner after this long. */
export const CANCEL_RELEASE_MS = 5_000;
/** Progress writes to the store are throttled to one per job per interval. */
export const PROGRESS_PERSIST_MS = 1_000;

const FINISHED: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed", "cancelled"]);

type JotaiStore = ReturnType<typeof getDefaultStore>;

export function isFinishedStatus(status: JobStatus): boolean {
    return FINISHED.has(status);
}

export function isActiveStatus(status: JobStatus): boolean {
    return status === "queued" || status === "running";
}

export function countActiveJobs(list: readonly Job[]): number {
    return list.filter((job) => isActiveStatus(job.status)).length;
}

// ---------------------------------------------------------------------------
// Backend selection

const NATIVE_COMMANDS = ["jobUpsert", "jobList", "jobDelete", "jobPrune"] as const;

/** True when every `job_*` command exists on the generated bindings. */
export function hasNativeJobCommands(): boolean {
    const table = commands as unknown as Record<string, unknown>;
    return NATIVE_COMMANDS.every((name) => typeof table[name] === "function");
}

function toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function field(record: Record<string, unknown>, snake: string, camel: string): unknown {
    return snake in record ? record[snake] : record[camel];
}

function normalizeRecord(raw: unknown): JobRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? "");
    if (!id) return null;
    return {
        id,
        kind: String(r.kind ?? ""),
        title: String(r.title ?? ""),
        status: String(r.status ?? "queued"),
        payload: String(r.payload ?? ""),
        progress: toNumber(r.progress),
        result: r.result == null ? null : String(r.result),
        error: r.error == null ? null : String(r.error),
        created_at: toNumber(field(r, "created_at", "createdAt")),
        updated_at: toNumber(field(r, "updated_at", "updatedAt")),
    };
}

/**
 * Backend over the plugin commands. They are reached through an untyped table
 * so this module compiles both before and after S2-1 adds them to the
 * bindings; `hasNativeJobCommands()` keeps the app on memory until then.
 * `created_at` / `updated_at` are sent as plain numbers (serde accepts them
 * for `i64`), while the generated types may declare them as `bigint`.
 */
function createTauriBackend(): JobBackend {
    const table = commands as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    return {
        native: true,
        async upsert(record) {
            unwrapResult<unknown>(await table.jobUpsert(record));
        },
        async list(status) {
            const raw = unwrapResult<unknown>(await table.jobList(status));
            if (!Array.isArray(raw)) return [];
            return raw.map(normalizeRecord).filter((r): r is JobRecord => r !== null);
        },
        async delete(id) {
            unwrapResult<unknown>(await table.jobDelete(id));
        },
        async prune(keepFinished) {
            return toNumber(unwrapResult<unknown>(await table.jobPrune(keepFinished)));
        },
    };
}

/** In-memory backend with the plugin's semantics (tests, browser, pre-S2-1 builds). */
export function createMemoryJobBackend(): JobBackend & { rows(): JobRecord[] } {
    const rows = new Map<string, JobRecord>();
    const rank = (status: string) => (status === "running" ? 0 : status === "queued" ? 1 : 2);
    return {
        native: false,
        rows() {
            return Array.from(rows.values()).map((r) => ({ ...r }));
        },
        async upsert(record) {
            rows.set(record.id, { ...record });
        },
        async list(status) {
            return Array.from(rows.values())
                .filter((r) => status === null || r.status === status)
                .sort((a, b) => rank(a.status) - rank(b.status) || b.created_at - a.created_at)
                .map((r) => ({ ...r }));
        },
        async delete(id) {
            rows.delete(id);
        },
        async prune(keepFinished) {
            const finished = Array.from(rows.values())
                .filter((r) => FINISHED.has(r.status as JobStatus))
                .sort((a, b) => b.updated_at - a.updated_at);
            const victims = finished.slice(Math.max(0, keepFinished));
            for (const r of victims) rows.delete(r.id);
            return victims.length;
        },
    };
}

let backend: JobBackend | null = null;

function resolveBackend(): JobBackend {
    if (!backend) {
        backend =
            hasTauri() && hasNativeJobCommands() ? createTauriBackend() : createMemoryJobBackend();
    }
    return backend;
}

/** True when jobs are written to library.sqlite (false on the in-memory fallback). */
export function isJobStoreNative(): boolean {
    return resolveBackend().native;
}

/** Test hook: replaces the backend (null restores automatic selection). */
export function __setJobBackendForTests(next: JobBackend | null): void {
    backend = next;
}

// ---------------------------------------------------------------------------
// Record <-> Job

type PayloadEnvelope = { v: 1; payload: unknown; dedupeKey: string | null };

function safeStringify(value: unknown): string | null {
    if (value === undefined) return null;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? null : text;
    } catch {
        return null;
    }
}

function safeParse(text: string | null): unknown {
    if (text == null || text === "") return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

export function jobToRecord(job: Job): JobRecord {
    const envelope: PayloadEnvelope = {
        v: 1,
        payload: job.payload === undefined ? null : job.payload,
        dedupeKey: job.dedupeKey ?? null,
    };
    return {
        id: job.id,
        kind: job.kind,
        title: job.title,
        status: job.status,
        payload: safeStringify(envelope) ?? '{"v":1,"payload":null,"dedupeKey":null}',
        progress: job.progress,
        result: safeStringify(job.result),
        error: job.error ?? null,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
    };
}

export function recordToJob(record: JobRecord): Job {
    let payload: unknown = undefined;
    let dedupeKey: string | undefined;
    const parsed = safeParse(record.payload);
    if (parsed && typeof parsed === "object" && (parsed as PayloadEnvelope).v === 1) {
        const env = parsed as PayloadEnvelope;
        payload = env.payload === null ? undefined : env.payload;
        dedupeKey = env.dedupeKey ?? undefined;
    } else {
        payload = parsed;
    }
    const status = STATUSES.has(record.status) ? (record.status as JobStatus) : "failed";
    const result = safeParse(record.result);
    const job: Job = {
        id: record.id,
        kind: record.kind,
        title: record.title,
        status,
        payload,
        progress: Math.min(1, Math.max(0, record.progress || 0)),
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
    if (result !== undefined) job.result = result;
    if (record.error) job.error = record.error;
    if (dedupeKey) job.dedupeKey = dedupeKey;
    return job;
}

// ---------------------------------------------------------------------------
// State

const jobsBaseAtom = atom<Job[]>([]);

/** Live list: running first, then the queue in run order, then finished jobs newest first. */
export const jobsAtom = atom((get) => get(jobsBaseAtom));

/** When true no new job starts (the running one finishes). Persisted. */
export const pauseJobsAtom = atomWithStorage<boolean>("chessin.jobs.paused", false);

type Entry = {
    job: Job;
    /** Queue position: creation time, bumped on retry. */
    queuedAt: number;
    seq: number;
};

const entries = new Map<string, Entry>();
const handlers = new Map<string, JobHandler>();
const waiters = new Map<string, ((job: Job) => void)[]>();
let seqCounter = 0;
let store: JotaiStore = getDefaultStore();

let loadPromise: Promise<void> | null = null;
let startPromise: Promise<void> | null = null;
let runnerStarted = false;
let runnerStartedAt = 0;
let handlerGraceMs = HANDLER_GRACE_MS;
let graceTimer: ReturnType<typeof setTimeout> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

let runningId: string | null = null;
let runningAbort: AbortController | null = null;
let tickScheduled = false;

function newId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    if (typeof e === "string") return e;
    try {
        return JSON.stringify(e) ?? String(e);
    } catch {
        return String(e);
    }
}

function byQueueOrder(a: Entry, b: Entry): number {
    return a.queuedAt - b.queuedAt || a.seq - b.seq;
}

function sortedJobs(): Job[] {
    const running: Entry[] = [];
    const queued: Entry[] = [];
    const finished: Entry[] = [];
    for (const entry of entries.values()) {
        if (entry.job.status === "running") running.push(entry);
        else if (entry.job.status === "queued") queued.push(entry);
        else finished.push(entry);
    }
    queued.sort(byQueueOrder);
    finished.sort((a, b) => b.job.updatedAt - a.job.updatedAt || b.seq - a.seq);
    return [...running, ...queued, ...finished].map((e) => ({ ...e.job }));
}

function publish(): void {
    store.set(jobsBaseAtom, sortedJobs());
}

/** Snapshot of every known job (same order as `jobsAtom`). */
export function getJobs(): Job[] {
    return sortedJobs();
}

export function getJob(id: string): Job | undefined {
    const entry = entries.get(id);
    return entry ? { ...entry.job } : undefined;
}

/** Resolves with the job once it is done / failed / cancelled (immediately if it already is). */
export function waitForJob(id: string): Promise<Job> {
    const entry = entries.get(id);
    if (!entry) return Promise.reject(new Error(`Unknown job ${id}`));
    if (isFinishedStatus(entry.job.status)) return Promise.resolve({ ...entry.job });
    return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);
    });
}

function notifyWaiters(job: Job): void {
    if (!isFinishedStatus(job.status)) return;
    const list = waiters.get(job.id);
    if (!list) return;
    waiters.delete(job.id);
    for (const resolve of list) resolve({ ...job });
}

// ---------------------------------------------------------------------------
// Persistence (writes per job id are chained so transitions never overtake each other)

const writeChains = new Map<string, Promise<void>>();

function chain(id: string, work: () => Promise<void>): Promise<void> {
    const previous = writeChains.get(id) ?? Promise.resolve();
    const task = previous
        .catch(() => undefined)
        .then(work)
        .catch((e: unknown) => {
            console.warn(`[chessin] job persistence failed for ${id}: ${String(e)}`);
        });
    writeChains.set(id, task);
    const cleanup = () => {
        if (writeChains.get(id) === task) writeChains.delete(id);
    };
    task.then(cleanup, cleanup);
    return task;
}

function persist(job: Job): Promise<void> {
    const record = jobToRecord(job);
    return chain(job.id, () => resolveBackend().upsert(record));
}

function persistDelete(id: string): Promise<void> {
    return chain(id, () => resolveBackend().delete(id));
}

/** Resolves once every queued store write has settled (tests, shutdown). */
export async function awaitJobWrites(): Promise<void> {
    await Promise.allSettled(Array.from(writeChains.values()));
}

function update(id: string, patch: Partial<Job>, now = Date.now()): Job | undefined {
    const entry = entries.get(id);
    if (!entry) return undefined;
    const next: Job = { ...entry.job, ...patch, updatedAt: now };
    for (const key of ["result", "error", "dedupeKey"] as const) {
        if (next[key] === undefined) delete next[key];
    }
    entry.job = next;
    publish();
    notifyWaiters(next);
    return next;
}

// ---------------------------------------------------------------------------
// Loading

/** Loads the persisted jobs once; a job left `running` by a crash is queued again. */
function ensureLoaded(): Promise<void> {
    if (!loadPromise) {
        loadPromise = (async () => {
            let records: JobRecord[] = [];
            try {
                records = await resolveBackend().list(null);
            } catch (e) {
                console.warn(`[chessin] could not load jobs: ${String(e)}`);
            }
            records.sort((a, b) => a.created_at - b.created_at);
            for (const record of records) {
                if (entries.has(record.id)) continue;
                let job = recordToJob(record);
                if (job.status === "running") {
                    job = { ...job, status: "queued", progress: 0, updatedAt: Date.now() };
                    void persist(job);
                }
                entries.set(job.id, { job, queuedAt: job.createdAt, seq: seqCounter++ });
            }
            publish();
        })();
    }
    return loadPromise;
}

// ---------------------------------------------------------------------------
// Public API

/** Says how jobs of `kind` run. Re-registering replaces; returns an unregister function. */
export function registerJobHandler(kind: JobKind, handler: JobHandler): () => void {
    handlers.set(kind, handler);
    scheduleTick();
    return () => {
        if (handlers.get(kind) === handler) handlers.delete(kind);
    };
}

export function hasJobHandler(kind: JobKind): boolean {
    return handlers.has(kind);
}

/**
 * Adds a job to the queue. With `dedupeKey`, a job of that key that is still
 * queued or running is returned instead. Resolves once the job is persisted.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<Job> {
    await ensureLoaded();
    if (input.dedupeKey) {
        for (const entry of entries.values()) {
            if (entry.job.dedupeKey === input.dedupeKey && isActiveStatus(entry.job.status)) {
                return { ...entry.job };
            }
        }
    }
    const now = Date.now();
    const job: Job = {
        id: newId(),
        kind: input.kind,
        title: input.title,
        status: "queued",
        payload: input.payload,
        progress: 0,
        createdAt: now,
        updatedAt: now,
    };
    if (input.dedupeKey) job.dedupeKey = input.dedupeKey;
    entries.set(job.id, { job, queuedAt: now, seq: seqCounter++ });
    publish();
    await persist(job);
    scheduleTick();
    return { ...job };
}

/** Cancels a queued job, or aborts the running one (its status flips at once). */
export async function cancelJob(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry || !isActiveStatus(entry.job.status)) return;
    const wasRunning = entry.job.status === "running";
    const job = update(id, { status: "cancelled" });
    if (wasRunning && runningId === id) {
        runningAbort?.abort();
        // A handler that ignores the signal must not block the queue forever.
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
            releaseTimer = null;
            releaseSlot(id);
        }, CANCEL_RELEASE_MS);
    }
    if (job) await persist(job);
    scheduleTick();
}

/** Puts a failed or cancelled job back at the end of the queue. Returns null otherwise. */
export async function retryJob(id: string): Promise<Job | null> {
    const entry = entries.get(id);
    if (!entry || (entry.job.status !== "failed" && entry.job.status !== "cancelled")) return null;
    const now = Date.now();
    entry.queuedAt = now;
    entry.seq = seqCounter++;
    const job = update(
        id,
        { status: "queued", progress: 0, error: undefined, result: undefined },
        now,
    );
    if (job) await persist(job);
    scheduleTick();
    return job ? { ...job } : null;
}

/** Removes a finished job from the list and the store. */
export async function removeJob(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry || !isFinishedStatus(entry.job.status)) return;
    entries.delete(id);
    waiters.delete(id);
    publish();
    await persistDelete(id);
}

/** "清除已完成": drops every done / failed / cancelled job. */
export async function clearFinishedJobs(): Promise<void> {
    const ids = Array.from(entries.values())
        .filter((e) => isFinishedStatus(e.job.status))
        .map((e) => e.job.id);
    for (const id of ids) {
        entries.delete(id);
        waiters.delete(id);
    }
    publish();
    await Promise.all(ids.map((id) => persistDelete(id)));
}

// ---------------------------------------------------------------------------
// Runner

function scheduleTick(): void {
    if (tickScheduled) return;
    tickScheduled = true;
    queueMicrotask(() => {
        tickScheduled = false;
        void tick();
    });
}

function scheduleGraceTick(): void {
    if (graceTimer) return;
    const wait = Math.max(0, runnerStartedAt + handlerGraceMs - Date.now()) + 1;
    graceTimer = setTimeout(() => {
        graceTimer = null;
        scheduleTick();
    }, wait);
}

function releaseSlot(id: string): void {
    if (runningId !== id) return;
    runningId = null;
    runningAbort = null;
    if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
    }
    scheduleTick();
}

async function tick(): Promise<void> {
    if (!runnerStarted || runningId) return;
    if (store.get(pauseJobsAtom)) return;
    const offline = store.get(offlineModeAtom);
    const queued = Array.from(entries.values())
        .filter((e) => e.job.status === "queued")
        .sort(byQueueOrder);
    const inGrace = Date.now() - runnerStartedAt < handlerGraceMs;

    let next: Entry | undefined;
    let waitingForHandler = false;
    for (const entry of queued) {
        if (offline && entry.job.kind === "sync") continue;
        if (!handlers.has(entry.job.kind)) {
            if (inGrace) {
                waitingForHandler = true;
                continue;
            }
            const failed = update(entry.job.id, { status: "failed", error: NO_HANDLER_ERROR });
            if (failed) void persist(failed);
            continue;
        }
        next = entry;
        break;
    }
    if (!next) {
        if (waitingForHandler) scheduleGraceTick();
        return;
    }
    await run(next.job.id, offline);
}

async function run(id: string, offline: boolean): Promise<void> {
    const entry = entries.get(id);
    if (!entry || entry.job.status !== "queued") return;
    const handler = handlers.get(entry.job.kind);
    if (!handler) return;

    const abort = new AbortController();
    runningId = id;
    runningAbort = abort;
    const started = update(id, {
        status: "running",
        progress: 0,
        error: undefined,
        result: undefined,
    });
    if (started) void persist(started);

    let lastPersisted = Date.now();
    const ctx: JobContext = {
        signal: abort.signal,
        offline,
        setProgress(p: number) {
            const current = entries.get(id)?.job;
            if (!current || current.status !== "running") return;
            const value = Number.isFinite(p) ? (p > 1 ? p / 100 : p) : 0;
            const progress = Math.min(1, Math.max(0, value));
            if (progress === current.progress) return;
            const next = update(id, { progress });
            const now = Date.now();
            if (next && now - lastPersisted >= PROGRESS_PERSIST_MS) {
                lastPersisted = now;
                void persist(next);
            }
        },
    };

    let finished: Job | undefined;
    try {
        const result = await Promise.resolve().then(() => handler({ ...entry.job }, ctx));
        if (entries.get(id)?.job.status === "running") {
            finished = update(id, { status: "done", progress: 1, result, error: undefined });
        }
    } catch (e) {
        if (entries.get(id)?.job.status === "running") {
            finished = abort.signal.aborted
                ? update(id, { status: "cancelled" })
                : update(id, { status: "failed", error: errorMessage(e) });
        }
    }
    if (finished) await persist(finished);
    await pruneFinished();
    releaseSlot(id);
}

async function pruneFinished(): Promise<void> {
    const finished = Array.from(entries.values())
        .filter((e) => isFinishedStatus(e.job.status))
        .sort((a, b) => b.job.updatedAt - a.job.updatedAt || b.seq - a.seq);
    for (const victim of finished.slice(KEEP_FINISHED)) {
        entries.delete(victim.job.id);
        waiters.delete(victim.job.id);
    }
    if (finished.length > KEEP_FINISHED) publish();
    try {
        await resolveBackend().prune(KEEP_FINISHED);
    } catch (e) {
        console.warn(`[chessin] job prune failed: ${String(e)}`);
    }
}

/**
 * Idempotent: loads the persisted jobs, re-queues crashed ones and starts the
 * runner. Resolves once the first tick has been scheduled.
 */
export function startJobRunner(options: StartJobRunnerOptions = {}): Promise<void> {
    if (startPromise) return startPromise;
    if (options.store) store = options.store;
    if (options.handlerGraceMs !== undefined) handlerGraceMs = options.handlerGraceMs;
    startPromise = (async () => {
        await ensureLoaded();
        runnerStarted = true;
        runnerStartedAt = Date.now();
        const unsubPause = store.sub(pauseJobsAtom, scheduleTick);
        const unsubOffline = store.sub(offlineModeAtom, scheduleTick);
        unsubscribe = () => {
            unsubPause();
            unsubOffline();
        };
        scheduleTick();
    })();
    return startPromise;
}

export function isJobRunnerStarted(): boolean {
    return runnerStarted;
}

/** Test helper: forgets every job, handler and runner state. */
export function __resetJobsForTests(): void {
    runningAbort?.abort();
    unsubscribe?.();
    unsubscribe = null;
    if (graceTimer) clearTimeout(graceTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    graceTimer = null;
    releaseTimer = null;
    entries.clear();
    handlers.clear();
    waiters.clear();
    writeChains.clear();
    seqCounter = 0;
    loadPromise = null;
    startPromise = null;
    runnerStarted = false;
    runnerStartedAt = 0;
    handlerGraceMs = HANDLER_GRACE_MS;
    runningId = null;
    runningAbort = null;
    tickScheduled = false;
    backend = null;
    store.set(jobsBaseAtom, []);
    store.set(pauseJobsAtom, false);
    store = getDefaultStore();
}
