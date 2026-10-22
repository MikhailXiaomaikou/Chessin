import { type Chess, makeUci, type Move, type NormalMove, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";

/**
 * UCI helpers shared by the review and the boards.
 *
 * chessops represents castling as "king takes own rook" (`e1h1`), engines
 * print the two-square king move (`e1g1`). Comparing moves therefore goes
 * through `canonicalUci`, and anything shown to the user or sent to an engine
 * goes through `standardUci`.
 */

/** Castling-agnostic key for a move (king-takes-rook form). `null` for drops / unparsable input. */
export function canonicalUci(pos: Chess, uci: string): string | null {
    const move = parseUci(uci.trim().toLowerCase());
    if (!move || !("from" in move)) return null;
    try {
        return makeUci(normalizeMove(pos, move));
    } catch {
        return null;
    }
}

/** True when `a` and `b` are the same move in `pos`, whatever their castling spelling. */
export function isSameUci(pos: Chess, a: string, b: string): boolean {
    const ca = canonicalUci(pos, a);
    return ca !== null && ca === canonicalUci(pos, b);
}

/** Standard UCI spelling (castling as a two-square king move), as engines print it. */
export function standardUci(pos: Chess, move: Move): string {
    if (!("from" in move)) return makeUci(move);
    const normalized = normalizeMove(pos, move) as NormalMove;
    const king = pos.board.get(normalized.from);
    const target = pos.board.get(normalized.to);
    if (
        king?.role === "king" &&
        target?.role === "rook" &&
        target.color === king.color &&
        normalized.from !== normalized.to
    ) {
        const rank = normalized.from >> 3;
        const kingside = (normalized.to & 7) > (normalized.from & 7);
        return makeUci({ from: normalized.from, to: rank * 8 + (kingside ? 6 : 2) });
    }
    return makeUci(move);
}

/** `standardUci` for a UCI string (normalises `e1h1` → `e1g1`; other moves pass through). */
export function toStandardUci(pos: Chess, uci: string): string {
    const move = parseUci(uci.trim().toLowerCase());
    if (!move) return uci;
    return standardUci(pos, move);
}
