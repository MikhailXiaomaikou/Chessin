import { atom, useAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import { useCallback } from "react";

export type BoardColor = "white" | "black";

/**
 * View-only board orientation override, keyed by tab id.
 *
 * Flipping the board is a view action: it must not touch the game headers
 * (which would mark the tab dirty, trigger autosave and serialise an
 * `[Orientation]` tag into the PGN).
 *
 * `base` records the `Orientation` header the override was made against. When
 * that header changes (another game loaded, repertoire colour edited in the
 * game info, auto-flip while playing) the override no longer applies and the
 * header is used again, so the header stays the initial value on load.
 */
export type OrientationOverride = { base: BoardColor; value: BoardColor } | null;

export const orientationOverrideFamily = atomFamily((_tabId: string) =>
    atom<OrientationOverride>(null),
);

export function resolveOrientation(
    override: OrientationOverride,
    headerOrientation?: BoardColor | null,
): BoardColor {
    const base = headerOrientation ?? "white";
    return override !== null && override.base === base ? override.value : base;
}

export function flipOrientation(
    override: OrientationOverride,
    headerOrientation?: BoardColor | null,
): OrientationOverride {
    const base = headerOrientation ?? "white";
    const current = resolveOrientation(override, headerOrientation);
    return { base, value: current === "white" ? "black" : "white" };
}

/**
 * `[orientation, toggle]` for the board shown in `tabId`.
 * `headerOrientation` is the game's `Orientation` header (initial value).
 */
export function useBoardOrientation(
    tabId: string | null | undefined,
    headerOrientation?: BoardColor | null,
): [BoardColor, () => void] {
    const [override, setOverride] = useAtom(orientationOverrideFamily(tabId ?? ""));
    const orientation = resolveOrientation(override, headerOrientation);
    const toggle = useCallback(
        () => setOverride((prev) => flipOrientation(prev, headerOrientation)),
        [setOverride, headerOrientation],
    );
    return [orientation, toggle];
}
