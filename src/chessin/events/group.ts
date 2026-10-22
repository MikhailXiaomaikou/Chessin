import type { PlayerColor } from "@/chessin/repertoire/model";
import type { GameOrigin } from "@/utils/tabs";

/**
 * Event grouping (S4-3, teardown W3-3): the user's games grouped by
 * `(event, site, year)` from the local database rows. Online games carry a
 * per-game URL in `Site`, so a URL is reduced to its host before grouping
 * ("Rated Blitz game" on lichess.org in 2026 is one event). Pure.
 */

export type EventGameRow = {
    /** `originToString({ kind: "database", database, gameId })`. */
    key: string;
    origin: GameOrigin;
    database: string;
    gameId: number;
    event: string;
    site: string;
    round: string | null;
    /** PGN date (`YYYY.MM.DD`) as stored, or null. */
    date: string | null;
    timestamp: number | null;
    white: string;
    black: string;
    whiteElo: number | null;
    blackElo: number | null;
    result: string;
    playerColor: PlayerColor;
    timeControl: string | null;
};

export type Outcome = "win" | "draw" | "loss" | "unknown";

export type EventTally = { wins: number; draws: number; losses: number; unknown: number };

export type EventGroup = {
    /** `${year}|${site}|${event}` — stable across loads, usable as a search param. */
    id: string;
    /** Trimmed event name ("" when the PGN had none). */
    event: string;
    /** Host of a URL site, else the trimmed site ("" when none). */
    site: string;
    /** `YYYY` or `?`. */
    year: string;
    /** Rounds in playing order (round number, then date, then id). */
    games: EventGameRow[];
    earliest: number | null;
    latest: number | null;
    tally: EventTally;
};

/** Host of a URL site (without `www.`), else the trimmed site; "" for none / "?". */
export function normalizeSite(site: string | null | undefined): string {
    const s = (site ?? "").trim();
    if (!s || s === "?") return "";
    const m = /^https?:\/\/([^/\s?#]+)/i.exec(s);
    if (m) return m[1].toLowerCase().replace(/^www\./, "");
    return s;
}

/** Trimmed event name; "" for none / "?". */
export function eventName(event: string | null | undefined): string {
    const e = (event ?? "").trim();
    return !e || e === "?" ? "" : e;
}

/** `YYYY` of a PGN date, `?` when unknown. */
export function yearOf(date: string | null | undefined): string {
    const y = (date ?? "").trim().split(".")[0] ?? "";
    return /^\d{4}$/.test(y) ? y : "?";
}

export function eventId(
    event: string | null | undefined,
    site: string | null | undefined,
    year: string,
): string {
    return `${year}|${normalizeSite(site)}|${eventName(event)}`;
}

/** The group id a game's headers belong to; null when it has neither event nor site. */
export function eventIdForHeaders(headers: {
    event?: string | null;
    site?: string | null;
    date?: string | null;
}): string | null {
    const name = eventName(headers.event);
    const site = normalizeSite(headers.site);
    if (!name && !site) return null;
    return eventId(headers.event, headers.site, yearOf(headers.date));
}

export function outcomeFor(result: string | null | undefined, color: PlayerColor): Outcome {
    const r = (result ?? "").trim();
    if (r === "1/2-1/2") return "draw";
    if (r === "1-0") return color === "white" ? "win" : "loss";
    if (r === "0-1") return color === "black" ? "win" : "loss";
    return "unknown";
}

/** Numeric parts of a PGN round (`"3.1"` → `[3, 1]`, `"-"` → `[]`). */
export function roundParts(round: string | null | undefined): number[] {
    if (!round) return [];
    return round
        .split(/[.\-/]/)
        .map((p) => Number.parseInt(p, 10))
        .filter((n) => Number.isFinite(n));
}

/** Playing order: round parts (`"9"` before `"9.2"`, no round last), then date, then database id. */
export function compareRounds(a: EventGameRow, b: EventGameRow): number {
    const ra = roundParts(a.round);
    const rb = roundParts(b.round);
    if (ra.length === 0 || rb.length === 0) {
        if (ra.length !== rb.length) return ra.length === 0 ? 1 : -1;
    } else {
        const n = Math.min(ra.length, rb.length);
        for (let i = 0; i < n; i++) {
            if (ra[i] !== rb[i]) return ra[i] - rb[i];
        }
        if (ra.length !== rb.length) return ra.length - rb.length;
    }
    if (a.timestamp !== b.timestamp) {
        if (a.timestamp === null) return 1;
        if (b.timestamp === null) return -1;
        return a.timestamp - b.timestamp;
    }
    return a.gameId - b.gameId;
}

export function opponentOf(row: EventGameRow): { name: string; elo: number | null } {
    return row.playerColor === "white"
        ? { name: row.black, elo: row.blackElo }
        : { name: row.white, elo: row.whiteElo };
}

export function tallyOf(rows: readonly EventGameRow[]): EventTally {
    const tally: EventTally = { wins: 0, draws: 0, losses: 0, unknown: 0 };
    for (const row of rows) {
        switch (outcomeFor(row.result, row.playerColor)) {
            case "win":
                tally.wins++;
                break;
            case "draw":
                tally.draws++;
                break;
            case "loss":
                tally.losses++;
                break;
            default:
                tally.unknown++;
        }
    }
    return tally;
}

/** Groups by `(event, site, year)`; newest event first (undated last), rounds in playing order. */
export function groupGames(rows: readonly EventGameRow[]): EventGroup[] {
    const groups = new Map<string, EventGroup>();
    for (const row of rows) {
        const year = yearOf(row.date);
        const id = eventId(row.event, row.site, year);
        let group = groups.get(id);
        if (!group) {
            group = {
                id,
                event: eventName(row.event),
                site: normalizeSite(row.site),
                year,
                games: [],
                earliest: null,
                latest: null,
                tally: { wins: 0, draws: 0, losses: 0, unknown: 0 },
            };
            groups.set(id, group);
        }
        group.games.push(row);
        if (row.timestamp !== null) {
            group.earliest =
                group.earliest === null ? row.timestamp : Math.min(group.earliest, row.timestamp);
            group.latest =
                group.latest === null ? row.timestamp : Math.max(group.latest, row.timestamp);
        }
    }
    const out = Array.from(groups.values());
    for (const group of out) {
        group.games.sort(compareRounds);
        group.tally = tallyOf(group.games);
    }
    out.sort((a, b) => {
        if (a.latest !== b.latest) {
            if (a.latest === null) return 1;
            if (b.latest === null) return -1;
            return b.latest - a.latest;
        }
        return a.id.localeCompare(b.id);
    });
    return out;
}
