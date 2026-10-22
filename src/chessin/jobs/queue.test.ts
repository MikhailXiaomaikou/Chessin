import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import {
    __resetJobsForTests,
    __setJobBackendForTests,
    awaitJobWrites,
    CANCEL_RELEASE_MS,
    cancelJob,
    clearFinishedJobs,
    createMemoryJobBackend,
    enqueueJob,
    getJob,
    getJobs,
    hasNativeJobCommands,
    isJobStoreNative,
    type Job,
    type JobContext,
    type JobRecord,
    jobsAtom,
    jobToRecord,
    KEEP_FINISHED,
    NO_HANDLER_ERROR,
    pauseJobsAtom,
    recordToJob,
    registerJobHandler,
    removeJob,
    retryJob,
    startJobRunner,
    waitForJob,
} from "./queue";

const store = getDefaultStore();

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Lets microtasks and one macrotask run (enough for a scheduled tick). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Handler that resolves on `cancel`'s abort signal with a rejection. */
function abortable(): (job: Job, ctx: JobContext) => Promise<unknown> {
    return (_job, ctx) =>
        new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
}

beforeEach(() => {
    __resetJobsForTests();
    store.set(offlineModeAtom, false);
});

afterEach(() => {
    __resetJobsForTests();
    vi.useRealTimers();
});

describe("backend selection", () => {
    it("uses the in-memory backend outside Tauri even though the commands exist", () => {
        expect(hasNativeJobCommands()).toBe(true);
        expect(isJobStoreNative()).toBe(false);
    });

    it("round-trips a job through the record shape", () => {
        const job: Job = {
            id: "j1",
            kind: "review",
            title: "复盘",
            status: "done",
            payload: { gameKey: "database:/x.db3#4", preset: "full" },
            progress: 1,
            result: { accuracy: 92 },
            error: undefined,
            createdAt: 100,
            updatedAt: 200,
            dedupeKey: "review:database:/x.db3#4",
        };
        const record = jobToRecord(job);
        expect(record.created_at).toBe(100);
        expect(record.updated_at).toBe(200);
        expect(record.error).toBeNull();
        expect(JSON.parse(record.payload)).toEqual({
            v: 1,
            payload: job.payload,
            dedupeKey: job.dedupeKey,
        });
        const back = recordToJob(record);
        expect(back).toEqual({
            id: "j1",
            kind: "review",
            title: "复盘",
            status: "done",
            payload: job.payload,
            progress: 1,
            result: { accuracy: 92 },
            createdAt: 100,
            updatedAt: 200,
            dedupeKey: "review:database:/x.db3#4",
        });
    });

    it("reads rows without the payload envelope and with unknown statuses", () => {
        const record: JobRecord = {
            id: "legacy",
            kind: "import",
            title: "t",
            status: "weird",
            payload: '{"path":"a.pgn"}',
            progress: 7,
            result: null,
            error: "boom",
            created_at: 1,
            updated_at: 2,
        };
        const job = recordToJob(record);
        expect(job.status).toBe("failed");
        expect(job.payload).toEqual({ path: "a.pgn" });
        expect(job.progress).toBe(1);
        expect(job.error).toBe("boom");
        expect(job.result).toBeUndefined();
        expect(job.dedupeKey).toBeUndefined();
    });

    it("memory backend lists active rows first and prunes the oldest finished", async () => {
        const backend = createMemoryJobBackend();
        const row = (id: string, status: string, at: number): JobRecord => ({
            id,
            kind: "k",
            title: id,
            status,
            payload: "",
            progress: 0,
            result: null,
            error: null,
            created_at: at,
            updated_at: at,
        });
        await backend.upsert(row("old-done", "done", 1));
        await backend.upsert(row("queued", "queued", 2));
        await backend.upsert(row("running", "running", 3));
        await backend.upsert(row("new-done", "failed", 4));
        await backend.upsert(row("newest-done", "cancelled", 5));

        expect((await backend.list(null)).map((r) => r.id)).toEqual([
            "running",
            "queued",
            "newest-done",
            "new-done",
            "old-done",
        ]);
        expect((await backend.list("queued")).map((r) => r.id)).toEqual(["queued"]);

        expect(await backend.prune(2)).toBe(1);
        expect(
            backend
                .rows()
                .map((r) => r.id)
                .sort(),
        ).toEqual(["new-done", "newest-done", "queued", "running"].sort());
    });
});

describe("runner", () => {
    it("runs jobs one at a time in creation order and records the result", async () => {
        const started: string[] = [];
        const gates = new Map<string, ReturnType<typeof deferred<string>>>();
        registerJobHandler("t", async (job) => {
            started.push(job.title);
            const gate = deferred<string>();
            gates.set(job.title, gate);
            return gate.promise;
        });

        const a = await enqueueJob({ kind: "t", title: "a", payload: 1 });
        const b = await enqueueJob({ kind: "t", title: "b", payload: 2 });
        const c = await enqueueJob({ kind: "t", title: "c", payload: 3 });
        expect(a.status).toBe("queued");

        await startJobRunner({ handlerGraceMs: 0 });
        await vi.waitFor(() => expect(started).toEqual(["a"]));
        expect(getJob(a.id)?.status).toBe("running");
        expect(getJob(b.id)?.status).toBe("queued");

        gates.get("a")?.resolve("ra");
        await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
        expect(getJob(a.id)).toMatchObject({ status: "done", result: "ra", progress: 1 });

        gates.get("b")?.resolve("rb");
        await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
        gates.get("c")?.resolve("rc");
        const done = await waitForJob(c.id);
        expect(done.result).toBe("rc");
        expect(getJobs().filter((j) => j.status === "done")).toHaveLength(3);
    });

    it("dedupes queued / running jobs by key but not finished ones", async () => {
        const gate = deferred();
        registerJobHandler("t", () => gate.promise);

        const first = await enqueueJob({ kind: "t", title: "a", dedupeKey: "k" });
        const again = await enqueueJob({ kind: "t", title: "a2", dedupeKey: "k" });
        expect(again.id).toBe(first.id);
        expect(getJobs()).toHaveLength(1);

        await startJobRunner({ handlerGraceMs: 0 });
        await vi.waitFor(() => expect(getJob(first.id)?.status).toBe("running"));
        const whileRunning = await enqueueJob({ kind: "t", title: "a3", dedupeKey: "k" });
        expect(whileRunning.id).toBe(first.id);

        gate.resolve();
        await waitForJob(first.id);
        const fresh = await enqueueJob({ kind: "t", title: "a4", dedupeKey: "k" });
        expect(fresh.id).not.toBe(first.id);
        expect(getJobs()).toHaveLength(2);
    });

    it("cancels a queued job before it runs", async () => {
        const handler = vi.fn<() => Promise<string>>(async () => "never");
        registerJobHandler("t", handler);
        store.set(pauseJobsAtom, true);
        const job = await enqueueJob({ kind: "t", title: "a" });
        await startJobRunner({ handlerGraceMs: 0 });

        await cancelJob(job.id);
        expect(getJob(job.id)?.status).toBe("cancelled");
        store.set(pauseJobsAtom, false);
        await settle();
        expect(handler).not.toHaveBeenCalled();
        expect(getJob(job.id)?.status).toBe("cancelled");
    });

    it("cancels the running job through its abort signal and moves on", async () => {
        let signal: AbortSignal | undefined;
        registerJobHandler("slow", (job, ctx) => {
            signal = ctx.signal;
            return abortable()(job, ctx);
        });
        registerJobHandler("fast", async () => "ok");

        const slow = await enqueueJob({ kind: "slow", title: "slow" });
        const fast = await enqueueJob({ kind: "fast", title: "fast" });
        await startJobRunner({ handlerGraceMs: 0 });
        await vi.waitFor(() => expect(getJob(slow.id)?.status).toBe("running"));
        expect(getJob(fast.id)?.status).toBe("queued");

        await cancelJob(slow.id);
        expect(signal?.aborted).toBe(true);
        expect(getJob(slow.id)?.status).toBe("cancelled");
        expect((await waitForJob(fast.id)).status).toBe("done");
        expect(getJob(slow.id)?.status).toBe("cancelled");
    });

    it("frees the runner when a cancelled handler ignores its signal", async () => {
        vi.useFakeTimers();
        registerJobHandler("stuck", () => new Promise(() => undefined));
        registerJobHandler("fast", async () => "ok");

        const stuck = await enqueueJob({ kind: "stuck", title: "stuck" });
        const fast = await enqueueJob({ kind: "fast", title: "fast" });
        await startJobRunner({ handlerGraceMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(getJob(stuck.id)?.status).toBe("running");

        await cancelJob(stuck.id);
        await vi.advanceTimersByTimeAsync(1);
        expect(getJob(fast.id)?.status).toBe("queued");
        await vi.advanceTimersByTimeAsync(CANCEL_RELEASE_MS + 1);
        expect(getJob(fast.id)?.status).toBe("done");
    });

    it("retries a failed job at the end of the queue", async () => {
        let calls = 0;
        registerJobHandler("t", async () => {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return "second";
        });
        const job = await enqueueJob({ kind: "t", title: "a" });
        await startJobRunner({ handlerGraceMs: 0 });
        const failed = await waitForJob(job.id);
        expect(failed).toMatchObject({ status: "failed", error: "boom" });

        expect(await retryJob("missing")).toBeNull();
        const retried = await retryJob(job.id);
        expect(retried).toMatchObject({ id: job.id, status: "queued", progress: 0 });
        expect(retried?.error).toBeUndefined();
        const done = await waitForJob(job.id);
        expect(done).toMatchObject({ status: "done", result: "second" });
        expect(done.error).toBeUndefined();
        expect(await retryJob(job.id)).toBeNull();
    });

    it("does not start jobs while paused", async () => {
        registerJobHandler("t", async () => "ok");
        store.set(pauseJobsAtom, true);
        const job = await enqueueJob({ kind: "t", title: "a" });
        await startJobRunner({ handlerGraceMs: 0 });
        await settle();
        expect(getJob(job.id)?.status).toBe("queued");

        store.set(pauseJobsAtom, false);
        expect((await waitForJob(job.id)).status).toBe("done");
    });

    it("keeps sync jobs queued while offline and tells handlers about offline", async () => {
        const seen: Record<string, boolean> = {};
        const handler = async (job: Job, ctx: JobContext) => {
            seen[job.kind] = ctx.offline;
            return job.kind;
        };
        registerJobHandler("sync", handler);
        registerJobHandler("review", handler);
        store.set(offlineModeAtom, true);

        const sync = await enqueueJob({ kind: "sync", title: "同步" });
        const review = await enqueueJob({ kind: "review", title: "复盘" });
        await startJobRunner({ handlerGraceMs: 0 });
        expect((await waitForJob(review.id)).status).toBe("done");
        expect(seen.review).toBe(true);
        expect(getJob(sync.id)?.status).toBe("queued");

        store.set(offlineModeAtom, false);
        expect((await waitForJob(sync.id)).status).toBe("done");
        expect(seen.sync).toBe(false);
    });

    it("fails jobs of an unknown kind with Jobs.NoHandler", async () => {
        await startJobRunner({ handlerGraceMs: 0 });
        const job = await enqueueJob({ kind: "nope", title: "?" });
        const failed = await waitForJob(job.id);
        expect(failed.error).toBe(NO_HANDLER_ERROR);
        expect(failed.status).toBe("failed");
    });

    it("waits for a late handler during the grace period", async () => {
        await startJobRunner({ handlerGraceMs: 5_000 });
        const job = await enqueueJob({ kind: "late", title: "late" });
        await settle();
        expect(getJob(job.id)?.status).toBe("queued");

        registerJobHandler("late", async () => "picked up");
        expect(await waitForJob(job.id)).toMatchObject({ status: "done", result: "picked up" });
    });

    it("re-queues jobs left running by a crash and runs them in creation order", async () => {
        const backend = createMemoryJobBackend();
        const row = (id: string, status: string, at: number): JobRecord => ({
            id,
            kind: "t",
            title: id,
            status,
            payload: JSON.stringify({ v: 1, payload: { n: at }, dedupeKey: `d:${id}` }),
            progress: 0.5,
            result: null,
            error: null,
            created_at: at,
            updated_at: at,
        });
        await backend.upsert(row("second", "queued", 20));
        await backend.upsert(row("crashed", "running", 10));
        await backend.upsert(row("earlier", "done", 5));
        __setJobBackendForTests(backend);

        const ran: string[] = [];
        registerJobHandler("t", async (job) => {
            ran.push(job.id);
            return (job.payload as { n: number }).n;
        });
        await startJobRunner({ handlerGraceMs: 0 });
        await waitForJob("second");
        expect(ran).toEqual(["crashed", "second"]);
        expect(getJob("crashed")).toMatchObject({
            status: "done",
            result: 10,
            dedupeKey: "d:crashed",
        });
        expect(getJob("earlier")?.status).toBe("done");

        await awaitJobWrites();
        const rows = new Map(backend.rows().map((r) => [r.id, r]));
        expect(rows.get("crashed")).toMatchObject({ status: "done", progress: 1, result: "10" });
        expect(rows.get("second")?.status).toBe("done");
        expect(rows.size).toBe(3);
    });

    it("dedupes against jobs restored from the store", async () => {
        const backend = createMemoryJobBackend();
        await backend.upsert({
            id: "stored",
            kind: "review",
            title: "复盘",
            status: "queued",
            payload: JSON.stringify({ v: 1, payload: null, dedupeKey: "review:x" }),
            progress: 0,
            result: null,
            error: null,
            created_at: 1,
            updated_at: 1,
        });
        __setJobBackendForTests(backend);
        const job = await enqueueJob({ kind: "review", title: "复盘", dedupeKey: "review:x" });
        expect(job.id).toBe("stored");
    });

    it("persists every transition and prunes finished rows beyond the cap", async () => {
        const backend = createMemoryJobBackend();
        __setJobBackendForTests(backend);
        registerJobHandler("t", async (_job, ctx) => {
            ctx.setProgress(0.5);
            return null;
        });
        await startJobRunner({ handlerGraceMs: 0 });

        store.set(pauseJobsAtom, true);
        const first = await enqueueJob({ kind: "t", title: "first" });
        await awaitJobWrites();
        expect(backend.rows().find((r) => r.id === first.id)?.status).toBe("queued");
        store.set(pauseJobsAtom, false);
        await waitForJob(first.id);
        await awaitJobWrites();
        expect(backend.rows().find((r) => r.id === first.id)).toMatchObject({
            status: "done",
            progress: 1,
        });

        const ids: string[] = [];
        for (let i = 0; i < KEEP_FINISHED + 1; i++) {
            ids.push((await enqueueJob({ kind: "t", title: `job ${i}` })).id);
        }
        await waitForJob(ids[ids.length - 1]);
        await awaitJobWrites();
        expect(getJobs()).toHaveLength(KEEP_FINISHED);
        expect(getJob(first.id)).toBeUndefined();
        expect(backend.rows()).toHaveLength(KEEP_FINISHED);
    });

    it("clamps progress, accepts percentages and ignores progress after cancel", async () => {
        const gate = deferred();
        let ctxRef: JobContext | undefined;
        const observed: number[] = [];
        registerJobHandler("t", async (_job, ctx) => {
            ctxRef = ctx;
            ctx.setProgress(50);
            ctx.setProgress(-1);
            ctx.setProgress(0.25);
            ctx.setProgress(150);
            await gate.promise;
            return null;
        });
        const job = await enqueueJob({ kind: "t", title: "p" });
        const unsub = store.sub(jobsAtom, () => {
            const current = store.get(jobsAtom).find((j) => j.id === job.id);
            if (current?.status === "running") observed.push(current.progress);
        });
        await startJobRunner({ handlerGraceMs: 0 });
        await vi.waitFor(() => expect(getJob(job.id)?.progress).toBe(1));
        expect(observed).toEqual([0, 0.5, 0, 0.25, 1]);

        await cancelJob(job.id);
        ctxRef?.setProgress(0.1);
        expect(getJob(job.id)).toMatchObject({ status: "cancelled", progress: 1 });
        gate.resolve();
        await settle();
        expect(getJob(job.id)?.status).toBe("cancelled");
        unsub();
    });

    it("clears and removes finished jobs from the list and the store", async () => {
        const backend = createMemoryJobBackend();
        __setJobBackendForTests(backend);
        registerJobHandler("t", async (job) => {
            if (job.title === "bad") throw new Error("no");
            return "ok";
        });
        await startJobRunner({ handlerGraceMs: 0 });
        const good = await enqueueJob({ kind: "t", title: "good" });
        const bad = await enqueueJob({ kind: "t", title: "bad" });
        await waitForJob(bad.id);
        store.set(pauseJobsAtom, true);
        const pending = await enqueueJob({ kind: "t", title: "pending" });

        await removeJob(pending.id);
        expect(getJob(pending.id)?.status).toBe("queued");

        await clearFinishedJobs();
        expect(getJobs().map((j) => j.id)).toEqual([pending.id]);
        await awaitJobWrites();
        expect(backend.rows().map((r) => r.id)).toEqual([pending.id]);
        expect(getJob(good.id)).toBeUndefined();
    });

    it("exposes the live list as running, queue order, then newest finished", async () => {
        const gates: ReturnType<typeof deferred<void>>[] = [];
        registerJobHandler("t", () => {
            const gate = deferred<void>();
            gates.push(gate);
            return gate.promise;
        });
        const a = await enqueueJob({ kind: "t", title: "a" });
        const b = await enqueueJob({ kind: "t", title: "b" });
        const c = await enqueueJob({ kind: "t", title: "c" });
        const d = await enqueueJob({ kind: "t", title: "d" });
        await startJobRunner({ handlerGraceMs: 0 });
        await vi.waitFor(() => expect(gates).toHaveLength(1));
        gates[0].resolve();
        await waitForJob(a.id);
        await vi.waitFor(() => expect(gates).toHaveLength(2));
        gates[1].resolve();
        await waitForJob(b.id);
        await vi.waitFor(() => expect(gates).toHaveLength(3));

        const list = store.get(jobsAtom);
        expect(list.map((j) => [j.title, j.status])).toEqual([
            ["c", "running"],
            ["d", "queued"],
            ["b", "done"],
            ["a", "done"],
        ]);
        expect(c.id).toBe(list[0].id);
        expect(d.id).toBe(list[1].id);
    });
});
