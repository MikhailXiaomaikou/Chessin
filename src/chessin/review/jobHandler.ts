import { type Job, type JobContext, registerJobHandler } from "@/chessin/jobs/queue";
import { loadGameFromOrigin, reviewGame, type ReviewJobPayload } from "./reviewGame";

/**
 * `kind: "review"` jobs (S2-2 queue): payload `ReviewJobPayload`, result
 * `{ gameKey, moments, accuracy }`. Registered once; importing this module
 * (the review panel does, so the board bundle brings it in at startup) or
 * calling `enqueueReview` is enough.
 */

export type ReviewJobResult = {
    gameKey: string;
    moments: number;
    accuracy: { white: number; black: number };
};

let registered = false;

export function isReviewJobPayload(value: unknown): value is ReviewJobPayload {
    if (!value || typeof value !== "object") return false;
    const p = value as Partial<ReviewJobPayload>;
    return typeof p.gameKey === "string" && !!p.source && typeof p.source === "object";
}

export async function runReviewJob(job: Job, ctx: JobContext): Promise<ReviewJobResult> {
    if (!isReviewJobPayload(job.payload)) throw new Error("Review.BadPayload");
    const payload = job.payload;
    const { tree, title } = await loadGameFromOrigin(payload.source);
    const review = await reviewGame({
        tree,
        gameKey: payload.gameKey,
        playerColor: payload.playerColor ?? null,
        preset: payload.preset ?? "full",
        title: payload.title ?? title,
        onProgress: ctx.setProgress,
        signal: ctx.signal,
    });
    return {
        gameKey: review.gameKey,
        moments: review.moments.length,
        accuracy: review.summary.accuracy,
    };
}

export function registerReviewJobHandler(): void {
    if (registered) return;
    registered = true;
    registerJobHandler("review", runReviewJob);
}

registerReviewJobHandler();
