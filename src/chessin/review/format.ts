import { parseUci } from "chessops";
import { makeSan } from "chessops/san";
import { positionFromFen } from "@/utils/chessops";
import type { PlayerColor } from "./model";

/** Pure formatting helpers for the review panel (no i18n). */

/** `"12. Nf3"` for white, `"12... Nf3"` for black. */
export function moveLabel(ply: number, san: string): string {
    const moveNumber = Math.ceil(ply / 2);
    return ply % 2 === 1 ? `${moveNumber}. ${san}` : `${moveNumber}... ${san}`;
}

export function colorOfPly(ply: number): PlayerColor {
    return ply % 2 === 1 ? "white" : "black";
}

/** A UCI line from `fen` as numbered SAN (`"12. Nf3 Nc6 13. Bb5"`); stops at the first illegal move. */
export function lineToSan(fen: string, line: string[], maxPlies = 10): string {
    const [pos] = positionFromFen(fen);
    if (!pos) return line.slice(0, maxPlies).join(" ");
    const parts: string[] = [];
    for (const uci of line.slice(0, maxPlies)) {
        const move = parseUci(uci);
        if (!move || !pos.isLegal(move)) break;
        const san = makeSan(pos, move);
        const number = pos.fullmoves;
        if (pos.turn === "white") parts.push(`${number}. ${san}`);
        else if (parts.length === 0) parts.push(`${number}... ${san}`);
        else parts.push(san);
        pos.play(move);
    }
    return parts.join(" ");
}

/** `"1:05"`, `"0:07"`, `"1:02:03"`. */
export function formatClock(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function percent(x: number, digits = 0): string {
    return (x * 100).toFixed(digits);
}
