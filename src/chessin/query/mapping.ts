import type { GameQuery, Sides } from "@/bindings";
import { type Chip, isSupportedKey, rangeOf } from "./parse";

/**
 * Chips → `GameQuery` (the `get_games` filter; the Rust side is untouched).
 *
 * What maps:
 * - player / bare text → `player1` / `player2` with `sides: "Any"`;
 *   white → player1 with `sides: "WhiteBlack"`, black → player1 with
 *   `sides: "BlackWhite"`; white + black → player1 / player2, `WhiteBlack`.
 *   A colour-less player next to a coloured one takes the other colour (the
 *   query cannot say "B as white, A either colour"). A third player is ignored.
 * - elo → `range1` and `range2` (the intersection of every elo chip). With a
 *   colour the ranges apply to both players; with `sides: "Any"` upstream
 *   matches when *either* player is in range.
 * - year → `start_date` / `end_date` as `YYYY.01.01` / `YYYY.12.31` (upstream
 *   compares the `Date` column as text; games dated `2020.??.??` fall outside
 *   `2020.12.31`, as with the date pickers).
 * - result → `outcome` (first chip wins; later ones are ignored).
 *
 * eco / event / tc are not filterable by `get_games` yet: they come back in
 * `unsupported` (dimmed in the bar) and are never sent.
 */

export const ELO_MIN = 0;
export const ELO_MAX = 3000;

/**
 * Sentinel `player1` / `player2` for a name no `Players` row matches. No game
 * can reference it, so the table and the hit count agree on "0 games" instead
 * of silently dropping the chip.
 */
export const NO_PLAYER_ID = -1;

export type UnsupportedReason = "key" | "extra_player" | "duplicate";
export type UnsupportedChip = { chip: Chip; reason: UnsupportedReason };

export type PlayerResolver = (name: string) => Promise<number | null>;

export type MappedQuery = {
    query: Partial<GameQuery>;
    /** Chips excluded from `query`, with why. */
    unsupported: UnsupportedChip[];
    /** Player chips whose name matched nobody (sent as `NO_PLAYER_ID`). */
    unresolved: Chip[];
};

/**
 * Synchronous part of the mapping: which chips are excluded and why. The bar
 * uses it to dim chips before any player lookup has finished.
 */
export function splitUnsupported(chips: Chip[]): UnsupportedChip[] {
    const out: UnsupportedChip[] = [];
    let whites = 0;
    let blacks = 0;
    let anys = 0;
    let results = 0;
    for (const chip of chips) {
        if (!isSupportedKey(chip.key)) {
            out.push({ chip, reason: "key" });
            continue;
        }
        if (chip.key === "white") {
            if (whites++ > 0) out.push({ chip, reason: "extra_player" });
        } else if (chip.key === "black") {
            if (blacks++ > 0) out.push({ chip, reason: "extra_player" });
        } else if (chip.key === "player" || chip.key === "text") {
            anys += 1;
        } else if (chip.key === "result") {
            if (results++ > 0) out.push({ chip, reason: "duplicate" });
        }
    }
    // Colour-less players fill the slots the coloured ones leave free.
    const freeSlots = 2 - Math.min(whites, 1) - Math.min(blacks, 1);
    if (anys > freeSlots) {
        let seen = 0;
        for (const chip of chips) {
            if (chip.key !== "player" && chip.key !== "text") continue;
            if (seen++ >= freeSlots) out.push({ chip, reason: "extra_player" });
        }
    }
    return out;
}

function clampElo(n: number): number {
    return Math.min(ELO_MAX, Math.max(ELO_MIN, n));
}

/** Intersection of every elo chip, clamped to [0, 3000]; `[0, 3000]` when unconstrained. */
export function eloRange(chips: Chip[]): [number, number] {
    let lo = ELO_MIN;
    let hi = ELO_MAX;
    for (const chip of chips) {
        if (chip.key !== "elo") continue;
        const n = Number.parseInt(chip.value, 10);
        switch (chip.op) {
            case ":":
                lo = Math.max(lo, n);
                hi = Math.min(hi, n);
                break;
            case ">":
                lo = Math.max(lo, n + 1);
                break;
            case "<":
                hi = Math.min(hi, n - 1);
                break;
            default: {
                const r = rangeOf(chip);
                if (r) {
                    lo = Math.max(lo, r[0]);
                    hi = Math.min(hi, r[1]);
                }
            }
        }
    }
    return [clampElo(lo), clampElo(hi)];
}

/** Year bounds of every year chip (intersection); `undefined` sides are open. */
export function yearBounds(chips: Chip[]): { from?: number; to?: number } {
    let from: number | undefined;
    let to: number | undefined;
    const raise = (n: number) => {
        from = from === undefined ? n : Math.max(from, n);
    };
    const lower = (n: number) => {
        to = to === undefined ? n : Math.min(to, n);
    };
    for (const chip of chips) {
        if (chip.key !== "year") continue;
        const n = Number.parseInt(chip.value, 10);
        switch (chip.op) {
            case ":":
                raise(n);
                lower(n);
                break;
            case ">":
                raise(n + 1);
                break;
            case "<":
                lower(n - 1);
                break;
            default: {
                const r = rangeOf(chip);
                if (r) {
                    raise(r[0]);
                    lower(r[1]);
                }
            }
        }
    }
    return { from, to };
}

function pad4(n: number): string {
    return String(Math.max(0, n)).padStart(4, "0");
}

export function yearToDates(bounds: { from?: number; to?: number }): {
    start_date: string | undefined;
    end_date: string | undefined;
} {
    return {
        start_date: bounds.from === undefined ? undefined : `${pad4(bounds.from)}.01.01`,
        end_date: bounds.to === undefined ? undefined : `${pad4(bounds.to)}.12.31`,
    };
}

/**
 * Builds the `GameQuery` fields the bar owns. Every owned field is present
 * (possibly `undefined`) so spreading the result over the table's query
 * clears filters whose chip was removed; the defaults match the store's
 * initial state (`sides: "WhiteBlack"`, ranges `[0, 3000]`).
 */
export async function toGameQuery(
    chips: Chip[],
    resolvePlayer: PlayerResolver,
): Promise<MappedQuery> {
    const unsupported = splitUnsupported(chips);
    const excluded = new Set(unsupported.map((u) => u.chip));
    const active = chips.filter((chip) => !excluded.has(chip));
    const unresolved: Chip[] = [];

    const white = active.find((c) => c.key === "white");
    const black = active.find((c) => c.key === "black");
    const anys = active.filter((c) => c.key === "player" || c.key === "text");

    const resolve = async (chip: Chip): Promise<number> => {
        const id = await resolvePlayer(chip.value);
        if (id === null) {
            unresolved.push(chip);
            return NO_PLAYER_ID;
        }
        return id;
    };

    let player1: number | undefined;
    let player2: number | undefined;
    let sides: Sides = "WhiteBlack";
    if (white && black) {
        player1 = await resolve(white);
        player2 = await resolve(black);
    } else if (white) {
        player1 = await resolve(white);
        if (anys[0]) player2 = await resolve(anys[0]);
    } else if (black) {
        sides = "BlackWhite";
        player1 = await resolve(black);
        if (anys[0]) player2 = await resolve(anys[0]);
    } else if (anys.length > 0) {
        sides = "Any";
        player1 = await resolve(anys[0]);
        if (anys[1]) player2 = await resolve(anys[1]);
    }

    const elo = eloRange(active);
    const dates = yearToDates(yearBounds(active));
    const result = active.find((c) => c.key === "result");

    const query: Partial<GameQuery> = {
        player1,
        player2,
        sides,
        range1: elo,
        range2: elo,
        outcome: result?.value,
        start_date: dates.start_date,
        end_date: dates.end_date,
    };
    return { query, unsupported, unresolved };
}

/** True when the mapped query filters nothing (every chip was excluded or there were none). */
export function isUnconstrained(mapped: MappedQuery): boolean {
    const q = mapped.query;
    return (
        q.player1 === undefined &&
        q.player2 === undefined &&
        q.outcome === undefined &&
        q.start_date === undefined &&
        q.end_date === undefined &&
        (!q.range1 || (q.range1[0] === ELO_MIN && q.range1[1] === ELO_MAX))
    );
}
