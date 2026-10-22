import { type Chess, makeUci, parseUci } from "chessops";
import { makeSan, parseSan } from "chessops/san";
import { canonicalUci, standardUci } from "@/chessin/board/uci";
import { positionFromFen } from "@/utils/chessops";

/**
 * Small chess helpers for the mistake notebook (pure, chessops only).
 *
 * Cards are keyed by EPD (the first four FEN fields) and store answers as
 * standard UCI; everything shown to the user is SAN.
 */

export type PlayerColor = "white" | "black";

/** First four FEN fields (board, turn, castling, en passant). */
export function epdOf(fen: string): string {
    return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/** A full FEN for an EPD (move counters `0 1`); a FEN passes through. */
export function fenFromEpd(epd: string): string {
    const fields = epd.trim().split(/\s+/);
    if (fields.length >= 6) return fields.join(" ");
    const base = fields.slice(0, 4);
    while (base.length < 4) base.push("-");
    return `${base.join(" ")} 0 1`;
}

export function sideToMove(fenOrEpd: string): PlayerColor {
    return fenOrEpd.trim().split(/\s+/)[1] === "b" ? "black" : "white";
}

/** 1-based half-move index of the position (the ply that is about to be played). */
export function plyFromFen(fen: string): number {
    const fields = fen.trim().split(/\s+/);
    const fullmove = Number(fields[5] ?? 1);
    const base = (Number.isFinite(fullmove) && fullmove >= 1 ? fullmove - 1 : 0) * 2;
    return base + (fields[1] === "b" ? 2 : 1);
}

/** `"12."` / `"12…"` style prefix for the move played at `ply` (1-based). */
export function moveNumberLabel(ply: number): string {
    const n = Math.max(1, Math.ceil(ply / 2));
    return ply % 2 === 1 ? `${n}.` : `${n}…`;
}

export function positionOf(fenOrEpd: string): Chess | null {
    const [pos] = positionFromFen(fenFromEpd(fenOrEpd));
    return pos;
}

/** SAN of a UCI move in `fenOrEpd`; `null` when either is invalid. */
export function sanFromUci(fenOrEpd: string, uci: string): string | null {
    const pos = positionOf(fenOrEpd);
    const move = parseUci(uci.trim().toLowerCase());
    if (!pos || !move || !("from" in move) || !pos.isLegal(move)) return null;
    try {
        return makeSan(pos, move);
    } catch {
        return null;
    }
}

/** Standard UCI of a SAN (or UCI) move in `fenOrEpd`; `null` when illegal. */
export function uciFromSan(fenOrEpd: string, san: string): string | null {
    const pos = positionOf(fenOrEpd);
    if (!pos) return null;
    const text = san.trim();
    if (!text) return null;
    const parsed = parseSan(pos, text) ?? parseUci(text.toLowerCase());
    if (!parsed || !("from" in parsed) || !pos.isLegal(parsed)) return null;
    return standardUci(pos, parsed);
}

/** True when `uci` is one of `answers` in `fenOrEpd` (castling spelling agnostic). */
export function matchesAnswer(fenOrEpd: string, uci: string, answers: string[]): boolean {
    const pos = positionOf(fenOrEpd);
    if (!pos) return answers.includes(uci);
    const key = canonicalUci(pos, uci);
    if (key === null) return false;
    return answers.some((a) => canonicalUci(pos, a) === key);
}

/** De-duplicates UCI answers (castling spelling agnostic), keeping the first spelling. */
export function uniqueAnswers(fenOrEpd: string, answers: string[]): string[] {
    const pos = positionOf(fenOrEpd);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of answers) {
        const uci = raw.trim().toLowerCase();
        if (!uci) continue;
        const key = pos ? (canonicalUci(pos, uci) ?? uci) : uci;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(pos ? standardizeUci(pos, uci) : uci);
    }
    return out;
}

function standardizeUci(pos: Chess, uci: string): string {
    const move = parseUci(uci);
    if (!move || !("from" in move)) return uci;
    try {
        return standardUci(pos, move);
    } catch {
        return makeUci(move);
    }
}
