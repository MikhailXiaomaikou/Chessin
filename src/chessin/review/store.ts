import {
    deleteDoc,
    getDoc,
    type LibraryDocumentMeta,
    listDocs,
    putDoc,
} from "@/chessin/store/libraryStore";
import { emitReviewSaved } from "./events";
import { gameKeyFromDocId, isReview, type Review, REVIEW_DOC_KIND, reviewDocId } from "./model";

/**
 * Reviews as library documents: `kind: "review"`, id `"review:" + gameKey`,
 * `origin` = the game key, `data` = the JSON `Review`. One document per game;
 * saving again replaces it (a blunder check never stacks on a full review).
 */

export type ReviewMeta = LibraryDocumentMeta & { gameKey: string };

export function parseReview(data: string): Review | null {
    try {
        const parsed: unknown = JSON.parse(data);
        return isReview(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function reviewTitle(review: Review): string {
    const h = review.headers;
    if (h && (h.white || h.black)) {
        const result = h.result && h.result !== "*" ? ` ${h.result}` : "";
        return `${h.white || "?"} – ${h.black || "?"}${result}`;
    }
    return review.gameKey;
}

/** Writes the review document and notifies `onReviewSaved` listeners. */
export async function saveReview(review: Review, title?: string): Promise<void> {
    await putDoc({
        id: reviewDocId(review.gameKey),
        kind: REVIEW_DOC_KIND,
        title: title ?? reviewTitle(review),
        origin: review.gameKey,
        data: JSON.stringify(review),
    });
    emitReviewSaved(review);
}

export async function getReview(gameKey: string): Promise<Review | null> {
    const doc = await getDoc(reviewDocId(gameKey));
    if (!doc || doc.kind !== REVIEW_DOC_KIND) return null;
    return parseReview(doc.data);
}

export async function hasReview(gameKey: string): Promise<boolean> {
    const doc = await getDoc(reviewDocId(gameKey));
    return doc !== null && doc.kind === REVIEW_DOC_KIND;
}

/** Newest first. */
export async function listReviews(): Promise<ReviewMeta[]> {
    const metas = await listDocs(REVIEW_DOC_KIND);
    const out: ReviewMeta[] = [];
    for (const meta of metas) {
        const gameKey = meta.origin ?? gameKeyFromDocId(meta.id);
        if (gameKey) out.push({ ...meta, gameKey });
    }
    return out;
}

export async function deleteReview(gameKey: string): Promise<void> {
    await deleteDoc(reviewDocId(gameKey));
}
