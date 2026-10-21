import { makeFen, parseFen } from "chessops/fen";

/**
 * Classifies what the user typed or pasted into the command palette.
 *
 * - `>` prefix           → commands only
 * - `:23`                → go to move 23
 * - a FEN                → open position in a new board
 * - PGN text             → import
 * - lichess / chess.com  → import that game
 * - anything else        → free search
 */
export type QueryIntent =
    | { kind: "commands"; query: string }
    | { kind: "search"; query: string }
    | { kind: "goToMove"; move: number }
    | { kind: "fen"; fen: string }
    | { kind: "pgn"; pgn: string }
    | { kind: "gameUrl"; url: string; site: "lichess" | "chesscom" };

/** Returns the normalised FEN when `text` is a syntactically valid FEN, else null. */
export function looksLikeFen(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.includes("\n")) return null;
    const board = trimmed.split(/\s+/)[0];
    if (board.split("/").length !== 8) return null;
    const res = parseFen(trimmed);
    if (res.isErr) return null;
    return makeFen(res.value);
}

// "1. e4", "1.e4", "1... c5" (black to move), "1. {comment}", "1. $1", "1. ("
const PGN_MOVE = /(^|[\s(])1\.(?:\.\.)?\s*(?:[a-hNBRQKO0]|\{|\$|\()/;
const PGN_HEADER = /^\s*\[(?:Event|Site|Date|Round|White|Black|Result|FEN|SetUp)\s+"/im;

/** True when `text` contains a PGN movetext (a "1." followed by a move) or PGN headers. */
export function looksLikePgn(text: string): boolean {
    if (text.trim().length < 4) return false;
    return PGN_MOVE.test(text) || PGN_HEADER.test(text);
}

/** Recognises a lichess.org or chess.com game URL. */
export function looksLikeGameUrl(
    text: string,
): { url: string; site: "lichess" | "chesscom" } | null {
    const trimmed = text.trim();
    if (/\s/.test(trimmed)) return null;
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "lichess.org" || host.endsWith(".lichess.org")) {
        // /abcdefgh, /abcdefghIJKL, /abcdefgh/black, /game/export/abcdefgh
        const segments = path.split("/").filter((s) => s.length > 0);
        const id = segments.find((s) => /^[A-Za-z0-9]{8}([A-Za-z0-9]{4})?$/.test(s));
        if (!id) return null;
        return { url: url.toString(), site: "lichess" };
    }
    if (host === "chess.com" || host.endsWith(".chess.com")) {
        if (!/^\/(?:game|live|daily|analysis)\//.test(path) && !/\/game\//.test(path)) {
            return null;
        }
        return { url: url.toString(), site: "chesscom" };
    }
    return null;
}

export function detectIntent(raw: string): QueryIntent {
    const text = raw ?? "";
    const trimmed = text.trim();

    if (trimmed.startsWith(">")) {
        return { kind: "commands", query: trimmed.slice(1).trim() };
    }

    const gotoMatch = /^:(\d{1,4})$/.exec(trimmed);
    if (gotoMatch) {
        return { kind: "goToMove", move: Number.parseInt(gotoMatch[1], 10) };
    }

    const gameUrl = looksLikeGameUrl(trimmed);
    if (gameUrl) {
        return { kind: "gameUrl", ...gameUrl };
    }

    const fen = looksLikeFen(trimmed);
    if (fen) {
        return { kind: "fen", fen };
    }

    if (looksLikePgn(text)) {
        return { kind: "pgn", pgn: text };
    }

    return { kind: "search", query: trimmed };
}
