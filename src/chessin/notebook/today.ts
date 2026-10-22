import i18n from "i18next";
import { summarizeGame } from "@/chessin/explain";
import { type LoadedQueue, loadQueue } from "@/chessin/queue/load";
import { isReview, REVIEW_DOC_KIND, type Review } from "@/chessin/review/model";
import { getDoc, listDocs } from "@/chessin/store/libraryStore";
import { listMyGames } from "@/chessin/sync/myGames";
import { loadReviewGameModule } from "./optional";

/**
 * Data behind the "今天" card on the "+" tab: today's unified review queue
 * (S4-1: minutes, items and the per-source breakdown), synced games that
 * have no review yet, and one summary sentence of the most recent review.
 * Every source is optional — a missing module or an empty library just
 * yields nothing.
 */

export type TodayExtras = {
    /** The built queue (`null` when building it failed). */
    queue: LoadedQueue | null;
    /** Synced games without a review (`null` when unknown). */
    pendingReviews: number | null;
    latest: { title: string | null; sentence: string } | null;
};

/** Today's queue, or `null` on failure (the card then falls back to the card count). */
export async function loadTodayQueue(now = Date.now()): Promise<LoadedQueue | null> {
    try {
        return await loadQueue(now);
    } catch (e) {
        console.warn("today: building the review queue failed", e);
        return null;
    }
}

export const PENDING_GAMES_LIMIT = 50;

/** Synced games (S2-6) without a stored review (S2-3). */
export async function countGamesPendingReview(limit = PENDING_GAMES_LIMIT): Promise<number | null> {
    try {
        const games = await listMyGames({ limit });
        if (games.length === 0) return 0;
        const review = await loadReviewGameModule();
        if (review?.hasReview) {
            const flags = await Promise.all(
                games.map((game) => review.hasReview!(game.key).catch(() => true)),
            );
            return flags.filter((reviewed) => !reviewed).length;
        }
        const docs = await listDocs(REVIEW_DOC_KIND);
        const reviewed = new Set(docs.map((doc) => doc.id));
        return games.filter((game) => !reviewed.has(`review:${game.key}`)).length;
    } catch {
        return null;
    }
}

export function currentLang(): "zh" | "en" {
    return (i18n.language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** The newest stored review and its first summary sentence (S2-4 `summarizeGame`). */
export async function latestReviewSummary(): Promise<TodayExtras["latest"]> {
    try {
        const docs = (await listDocs(REVIEW_DOC_KIND)).sort((a, b) => b.updatedAt - a.updatedAt);
        const newest = docs[0];
        if (!newest) return null;
        const doc = await getDoc(newest.id);
        if (!doc) return null;
        const data: unknown = JSON.parse(doc.data);
        if (!isReview(data)) return null;
        const review = data as Review;
        const sentences = summarizeGame(review.plies, review.playerColor).filter(
            (s) => typeof s === "string" && s.trim().length > 0,
        );
        if (sentences.length === 0) return null;
        return { title: doc.title || null, sentence: sentences[0] };
    } catch {
        return null;
    }
}

export async function loadTodayExtras(now = Date.now()): Promise<TodayExtras> {
    const [queue, pendingReviews, latest] = await Promise.all([
        loadTodayQueue(now),
        countGamesPendingReview(),
        latestReviewSummary(),
    ]);
    return { queue, pendingReviews, latest };
}
