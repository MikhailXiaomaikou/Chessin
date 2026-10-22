import type { Review } from "./model";

/**
 * Loader for S2-5's notebook bridge (`addCardsFromReview`). Resolved by Vite
 * at build time through `import.meta.glob`, so a checkout without the
 * notebook still builds; the panel's "加入错题本" button then reports that the
 * notebook is unavailable.
 */

export type NotebookHooksModule = {
    addCardsFromReview?: (review: Review) => Promise<{ added: number; updated: number }>;
    registerReviewListener?: () => () => void;
};

const modules = import.meta.glob<NotebookHooksModule>("../notebook/hooks.ts");

let loading: Promise<NotebookHooksModule | null> | null = null;

export function loadNotebookHooks(): Promise<NotebookHooksModule | null> {
    if (!loading) {
        const loader = Object.values(modules)[0];
        loading = loader
            ? loader().catch((e: unknown) => {
                  console.warn("review: notebook module failed to load", e);
                  return null;
              })
            : Promise.resolve(null);
    }
    return loading;
}

/** Adds the review's trainable moments to the notebook; `null` when the notebook is unavailable. */
export async function addReviewToNotebook(
    review: Review,
): Promise<{ added: number; updated: number } | null> {
    const hooks = await loadNotebookHooks();
    if (!hooks || typeof hooks.addCardsFromReview !== "function") return null;
    return hooks.addCardsFromReview(review);
}
