import { afterEach, expect, test, vi } from "vitest";
import {
    createRequestQueue,
    isStaleRequestError,
    type QueueResponse,
    StaleRequestError,
} from "./lichessQueue";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const ok: QueueResponse = { status: 200 };

afterEach(() => {
    vi.useRealTimers();
});

test("runs one request at a time, in order", async () => {
    const queue = createRequestQueue();
    const first = deferred<QueueResponse>();
    const started: string[] = [];

    const p1 = queue.enqueue("a", () => {
        started.push("1");
        return first.promise;
    });
    const p2 = queue.enqueue("b", async () => {
        started.push("2");
        return ok;
    });

    await vi.waitFor(() => expect(started).toEqual(["1"]));
    expect(queue.pendingCount()).toBe(1);

    first.resolve(ok);
    await expect(p1).resolves.toBe(ok);
    await expect(p2).resolves.toBe(ok);
    expect(started).toEqual(["1", "2"]);
    expect(queue.pendingCount()).toBe(0);
});

test("a superseding request drops queued and aborts in-flight tasks of its lane", async () => {
    const queue = createRequestQueue();
    const never = deferred<QueueResponse>();
    let inFlightSignal: AbortSignal | undefined;

    const p1 = queue.enqueue(
        "tab",
        (signal) => {
            inFlightSignal = signal;
            return never.promise;
        },
        { supersede: true },
    );
    const p2 = queue.enqueue("tab", async () => ok);
    const other = queue.enqueue("other", async () => ({ status: 201 }), { supersede: true });
    await vi.waitFor(() => expect(inFlightSignal).toBeDefined());

    const p3 = queue.enqueue("tab", async () => ({ status: 202 }), { supersede: true });

    await expect(p2).rejects.toBeInstanceOf(StaleRequestError);
    expect(inFlightSignal?.aborted).toBe(true);
    // The in-flight task never settles on its own; the queue must not wait for it.
    await expect(p1).rejects.toSatisfy(isStaleRequestError);
    await expect(other).resolves.toEqual({ status: 201 });
    await expect(p3).resolves.toEqual({ status: 202 });
});

test("on 429 waits for the back-off window and retries once", async () => {
    vi.useFakeTimers();
    const queue = createRequestQueue({ retryDelayMs: 60_000 });
    const responses = [{ status: 429 }, ok];
    let calls = 0;

    const p = queue.enqueue("tab", async () => {
        calls += 1;
        return responses.shift()!;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(queue.getRateLimitedUntil()).toBe(Date.now() + 60_000);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe(ok);
    expect(calls).toBe(2);
    expect(queue.getRateLimitedUntil()).toBeNull();
});

test("a second 429 is returned to the caller and keeps the window for later tasks", async () => {
    vi.useFakeTimers();
    const queue = createRequestQueue({ retryDelayMs: 60_000 });
    const listener = vi.fn<() => void>();
    queue.subscribe(listener);

    const p1 = queue.enqueue("a", async () => ({ status: 429 }));
    let secondStarted = false;
    const p2 = queue.enqueue("b", async () => {
        secondStarted = true;
        return ok;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p1).resolves.toEqual({ status: 429 });
    expect(queue.getRateLimitedUntil()).toBe(Date.now() + 60_000);
    expect(secondStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p2).resolves.toBe(ok);
    expect(queue.getRateLimitedUntil()).toBeNull();
    expect(listener).toHaveBeenCalled();
});

test("superseding a task that is waiting out a 429 frees the queue immediately", async () => {
    vi.useFakeTimers();
    const queue = createRequestQueue({ retryDelayMs: 60_000 });

    const p1 = queue.enqueue("tab", async () => ({ status: 429 }), { supersede: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getRateLimitedUntil()).not.toBeNull();

    const p2 = queue.enqueue("tab", async () => ok, { supersede: true });
    await expect(p1).rejects.toSatisfy(isStaleRequestError);

    // The replacement still honours the window.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(queue.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p2).resolves.toBe(ok);
});
