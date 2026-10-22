/**
 * Loaders for sibling modules that may not exist in every checkout.
 *
 * `import.meta.glob` is resolved by Vite at build time: when the file is
 * missing the map is empty and the loader returns `null`, when it lands the
 * next build picks it up without a code change. Nothing here is required
 * for the notebook to work; every caller has a fallback.
 */

export type ReviewGameModule = {
    hasReview?: (gameKey: string) => Promise<boolean>;
    listReviews?: () => Promise<unknown[]>;
};

const reviewGameModules = import.meta.glob<ReviewGameModule>("../review/reviewGame.ts");

let reviewGame: Promise<ReviewGameModule | null> | null = null;

/** S2-3's `reviewGame.ts` (`hasReview`, `listReviews`) or `null`. */
export function loadReviewGameModule(): Promise<ReviewGameModule | null> {
    if (!reviewGame) {
        const loader = Object.values(reviewGameModules)[0];
        reviewGame = loader
            ? loader().catch((e: unknown) => {
                  console.warn("notebook: review module failed to load", e);
                  return null;
              })
            : Promise.resolve(null);
    }
    return reviewGame;
}
