import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    __resetJobsForTests,
    getJob,
    type JobContext,
    registerJobHandler,
    startJobRunner,
    waitForJob,
} from "@/chessin/jobs/queue";
import {
    __setIndexDepsForTests,
    ensureIndex,
    INDEX_GAMES_BATCH,
    INDEX_JOB_KIND,
    type IndexDeps,
    type IndexProgressPayload,
    indexGames,
    indexProgressAtomFamily,
    indexStateAtomFamily,
    type IndexStats,
    refreshIndexState,
    runIndexJob,
} from "./index";

const DB = "/collections/mega.db3";
const STATS: IndexStats = {
    games: 200,
    postings: 8000,
    bytes: 70000,
    max_game_id: 200,
    built_at: 1,
};
const store = getDefaultStore();

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

type Fake = IndexDeps & {
    listeners: Set<(p: IndexProgressPayload) => void>;
    emit(p: IndexProgressPayload): void;
    hasIndex: boolean;
    builds: number;
    buildGate: ReturnType<typeof deferred<IndexStats>> | null;
};

function fakeDeps(): Fake {
    const fake: Fake = {
        listeners: new Set(),
        hasIndex: false,
        builds: 0,
        buildGate: null,
        emit(p) {
            for (const l of fake.listeners) l(p);
        },
        available: () => true,
        status: async () => (fake.hasIndex ? STATS : null),
        async build() {
            fake.builds += 1;
            const stats = fake.buildGate ? await fake.buildGate.promise : STATS;
            fake.hasIndex = true;
            return stats;
        },
        async remove() {
            fake.hasIndex = false;
        },
        position: async () => ({ ply: 0, moves: [], games: [], total: 0 }),
        pawnCandidates: async () => [],
        async listenProgress(handler) {
            fake.listeners.add(handler);
            return () => fake.listeners.delete(handler);
        },
        gamesAvailable: () => false,
        games: async () => [],
    };
    return fake;
}

let fake: Fake;

beforeEach(() => {
    __resetJobsForTests();
    registerJobHandler(INDEX_JOB_KIND, runIndexJob);
    fake = fakeDeps();
    __setIndexDepsForTests(fake);
    store.set(indexStateAtomFamily(DB), "unknown");
    store.set(indexProgressAtomFamily(DB), 0);
});

afterEach(() => {
    __setIndexDepsForTests(null);
    __resetJobsForTests();
});

describe("ensureIndex", () => {
    it("reports ready without a job when the sidecar exists", async () => {
        fake.hasIndex = true;
        const result = await ensureIndex(DB);
        expect(result).toEqual({ state: "ready", job: null });
        expect(store.get(indexStateAtomFamily(DB))).toBe("ready");
    });

    it("is unavailable without the commands", async () => {
        fake.available = () => false;
        expect(await ensureIndex(DB)).toEqual({ state: "none", job: null });
        expect(store.get(indexStateAtomFamily(DB))).toBe("none");
    });

    it("queues one job per database (dedupe) and mirrors progress events", async () => {
        await startJobRunner();
        fake.buildGate = deferred<IndexStats>();
        const first = await ensureIndex(DB);
        expect(first.state).toBe("building");
        expect(first.job?.kind).toBe(INDEX_JOB_KIND);
        expect(first.job?.dedupeKey).toBe(`index:${DB}`);
        expect(first.job?.payload).toEqual({ dbPath: DB });

        const second = await ensureIndex(DB);
        expect(second.job?.id).toBe(first.job?.id);

        // Let the runner pick the job up and subscribe to progress.
        await new Promise((r) => setTimeout(r, 0));
        expect(getJob(first.job!.id)?.status).toBe("running");
        expect(store.get(indexStateAtomFamily(DB))).toBe("building");
        expect(await refreshIndexState(DB)).toBe("building");

        fake.emit({ db_path: "/other.db3", progress: 0.9, finished: false });
        expect(getJob(first.job!.id)?.progress).toBe(0);
        fake.emit({ db_path: DB, progress: 42, finished: false });
        expect(getJob(first.job!.id)?.progress).toBeCloseTo(0.42);
        expect(store.get(indexProgressAtomFamily(DB))).toBeCloseTo(0.42);

        fake.buildGate.resolve(STATS);
        const done = await waitForJob(first.job!.id);
        expect(done.status).toBe("done");
        expect(done.result).toEqual(STATS);
        expect(fake.builds).toBe(1);
        expect(fake.listeners.size).toBe(0);
        expect(store.get(indexStateAtomFamily(DB))).toBe("ready");
        expect(store.get(indexProgressAtomFamily(DB))).toBe(1);

        // A third call now sees the sidecar and queues nothing.
        const third = await ensureIndex(DB);
        expect(third).toEqual({ state: "ready", job: null });
    });

    it("marks the state none again when the build fails", async () => {
        await startJobRunner();
        fake.buildGate = deferred<IndexStats>();
        const { job } = await ensureIndex(DB);
        await new Promise((r) => setTimeout(r, 0));
        fake.buildGate.reject(new Error("disk full"));
        const failed = await waitForJob(job!.id);
        expect(failed.status).toBe("failed");
        expect(failed.error).toBe("disk full");
        expect(store.get(indexStateAtomFamily(DB))).toBe("none");
        expect(await refreshIndexState(DB)).toBe("none");
    });
});

describe("indexGames", () => {
    it("throws without the command and batches ids otherwise", async () => {
        await expect(indexGames(DB, [1])).rejects.toThrow("Explorer.Index.Unavailable");
        const batches: number[][] = [];
        fake.gamesAvailable = () => true;
        fake.games = async (_db, ids) => {
            batches.push(ids);
            return ids.map((id) => ({
                id,
                fen: "",
                event: "",
                event_id: 0,
                site: "",
                site_id: 0,
                white: "",
                white_id: 0,
                black: "",
                black_id: 0,
                result: "*",
                moves: "",
            }));
        };
        const ids = Array.from({ length: INDEX_GAMES_BATCH + 3 }, (_, i) => i + 1);
        const games = await indexGames(DB, [...ids, 2, 0, -1]);
        expect(games.map((g) => g.id)).toEqual(ids);
        expect(batches.map((b) => b.length)).toEqual([INDEX_GAMES_BATCH, 3]);
    });
});

describe("runIndexJob", () => {
    function ctx(): JobContext & { progress: number[] } {
        const progress: number[] = [];
        return {
            progress,
            signal: new AbortController().signal,
            offline: false,
            setProgress: (p) => progress.push(p),
        };
    }

    it("normalises percentages and `finished`", async () => {
        fake.buildGate = deferred<IndexStats>();
        const c = ctx();
        const run = runIndexJob(
            {
                id: "j",
                kind: INDEX_JOB_KIND,
                title: "",
                status: "running",
                payload: { dbPath: DB },
                progress: 0,
                createdAt: 0,
                updatedAt: 0,
            },
            c,
        );
        await new Promise((r) => setTimeout(r, 0));
        fake.emit({ db_path: DB, progress: 0.5, finished: false });
        fake.emit({ db_path: DB, progress: 75, finished: false });
        fake.emit({ db_path: DB, progress: 0, finished: true });
        fake.buildGate.resolve(STATS);
        expect(await run).toEqual(STATS);
        expect(c.progress).toEqual([0.5, 0.75, 1]);
    });

    it("rejects a payload without a database path", async () => {
        await expect(
            runIndexJob(
                {
                    id: "j",
                    kind: INDEX_JOB_KIND,
                    title: "",
                    status: "running",
                    payload: {},
                    progress: 0,
                    createdAt: 0,
                    updatedAt: 0,
                },
                ctx(),
            ),
        ).rejects.toThrow("Explorer.Index.BadPayload");
    });
});
