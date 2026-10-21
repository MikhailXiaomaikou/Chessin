/**
 * Serial request queue for Lichess (IA-3 v0).
 *
 * Lichess asks API clients to make one request at a time and backs off with
 * HTTP 429 when they do not. This queue:
 *
 * - runs one task at a time, in order;
 * - groups tasks in *lanes* (typically one lane per board tab): a task
 *   enqueued with `supersede: true` drops every queued task of its lane and
 *   aborts the in-flight one, so a fast-moving user never waits for stale
 *   positions;
 * - on a 429 waits `retryDelayMs` (60 s) and retries that task once; every
 *   other task waits for the back-off window too. The window is observable
 *   (`getRateLimitedUntil` / `subscribe`) so the UI can say so.
 *
 * Offline mode is handled by the callers (`src/utils/lichess/api.tsx`), which
 * never enqueue anything while it is on.
 */

export class StaleRequestError extends Error {
    constructor() {
        super("Request superseded by a newer one");
        this.name = "StaleRequestError";
    }
}

export class OfflineError extends Error {
    constructor() {
        super("Offline mode: no network request was sent");
        this.name = "OfflineError";
    }
}

export class RateLimitError extends Error {
    constructor() {
        super("Rate limited by Lichess (HTTP 429)");
        this.name = "RateLimitError";
    }
}

function hasName(error: unknown, name: string): boolean {
    return (
        typeof error === "object" && error !== null && (error as { name?: unknown }).name === name
    );
}

export function isStaleRequestError(error: unknown): boolean {
    return error instanceof StaleRequestError || hasName(error, "StaleRequestError");
}

export function isOfflineError(error: unknown): boolean {
    return error instanceof OfflineError || hasName(error, "OfflineError");
}

export function isRateLimitError(error: unknown): boolean {
    return error instanceof RateLimitError || hasName(error, "RateLimitError");
}

/** The minimum a task's result needs: enough to detect HTTP 429. */
export type QueueResponse = { status: number };

export type EnqueueOptions = {
    /**
     * Drop the queued tasks of the same lane and abort the in-flight one:
     * this task replaces them. They reject with `StaleRequestError`.
     */
    supersede?: boolean;
};

export type RequestQueue = {
    enqueue<R extends QueueResponse>(
        lane: string | null,
        run: (signal: AbortSignal) => Promise<R>,
        options?: EnqueueOptions,
    ): Promise<R>;
    /** Epoch ms until which requests wait because of a 429, or null. */
    getRateLimitedUntil(): number | null;
    subscribe(listener: () => void): () => void;
    /** Queued (not yet started) tasks. */
    pendingCount(): number;
};

export const RATE_LIMIT_RETRY_MS = 60_000;

type Task<R extends QueueResponse> = {
    lane: string | null;
    run: (signal: AbortSignal) => Promise<R>;
    controller: AbortController;
    resolve: (value: R) => void;
    reject: (reason: unknown) => void;
};

function abortPromise(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
        if (signal.aborted) {
            reject(new StaleRequestError());
            return;
        }
        signal.addEventListener("abort", () => reject(new StaleRequestError()), { once: true });
    });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new StaleRequestError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new StaleRequestError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export function createRequestQueue(
    options: { retryDelayMs?: number; now?: () => number } = {},
): RequestQueue {
    const retryDelayMs = options.retryDelayMs ?? RATE_LIMIT_RETRY_MS;
    const now = options.now ?? (() => Date.now());

    const pending: Task<QueueResponse>[] = [];
    let current: Task<QueueResponse> | null = null;
    let rateLimitedUntil: number | null = null;
    const listeners = new Set<() => void>();

    function setRateLimitedUntil(value: number | null) {
        if (rateLimitedUntil === value) return;
        rateLimitedUntil = value;
        for (const listener of listeners) listener();
    }

    async function waitForRateLimit(signal: AbortSignal) {
        while (rateLimitedUntil !== null) {
            const remaining = rateLimitedUntil - now();
            if (remaining <= 0) {
                setRateLimitedUntil(null);
                return;
            }
            await abortableSleep(remaining, signal);
        }
    }

    async function execute<R extends QueueResponse>(task: Task<R>): Promise<R> {
        const { signal } = task.controller;
        await waitForRateLimit(signal);
        let response = await Promise.race([task.run(signal), abortPromise(signal)]);
        if (response.status === 429) {
            setRateLimitedUntil(now() + retryDelayMs);
            await waitForRateLimit(signal);
            response = await Promise.race([task.run(signal), abortPromise(signal)]);
            if (response.status === 429) {
                // Still throttled: keep everyone else waiting another window.
                setRateLimitedUntil(now() + retryDelayMs);
                return response;
            }
        }
        setRateLimitedUntil(null);
        return response;
    }

    async function pump() {
        if (current !== null) return;
        const task = pending.shift();
        if (!task) return;
        current = task;
        try {
            task.resolve(await execute(task));
        } catch (error) {
            task.reject(task.controller.signal.aborted ? new StaleRequestError() : error);
        } finally {
            current = null;
            void pump();
        }
    }

    function dropLane(lane: string) {
        for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].lane !== lane) continue;
            const [stale] = pending.splice(i, 1);
            stale.controller.abort();
            stale.reject(new StaleRequestError());
        }
        if (current?.lane === lane) {
            current.controller.abort();
        }
    }

    return {
        enqueue(lane, run, { supersede = false } = {}) {
            return new Promise((resolve, reject) => {
                if (supersede && lane !== null) dropLane(lane);
                pending.push({
                    lane,
                    run,
                    controller: new AbortController(),
                    resolve: resolve as (value: QueueResponse) => void,
                    reject,
                });
                void pump();
            });
        },
        getRateLimitedUntil: () => rateLimitedUntil,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        pendingCount: () => pending.length,
    };
}

/** lichess.org and explorer.lichess.org: explorer, game exports, cloud eval. */
export const lichessQueue = createRequestQueue();

/** tablebase.lichess.org has its own limits; keep it out of the explorer lane. */
export const tablebaseQueue = createRequestQueue();
