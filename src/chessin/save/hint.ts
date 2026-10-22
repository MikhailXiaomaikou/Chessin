import { atomWithStorage } from "jotai/utils";

/**
 * Whether the one-time "read-only source" hint has been shown. It is shown
 * the first time the user edits a tab that was opened from an external file
 * or a .db3 game, and never again on this installation.
 */
export const readOnlyHintShownAtom = atomWithStorage<boolean>(
    "chessin.save.readOnlyHintShown",
    false,
    undefined,
    { getOnInit: true },
);
