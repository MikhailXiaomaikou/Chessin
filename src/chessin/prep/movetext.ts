import type { Chess } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { standardUci } from "@/chessin/board/uci";
import { toEpd } from "@/chessin/repertoire/model";
import { positionFromFen } from "@/utils/chessops";

/**
 * SAN movetext → positions, without Tauri (`parsePGN` needs the Rust lexer).
 *
 * The database rows carry the main line as movetext ("1. e4 e5 2. Nf3 … 1-0",
 * possibly with `{comments}`, `(variations)` and NAGs). Only the main line
 * is replayed; the walk stops at the first token chessops cannot play.
 */

export type ReplayPly = {
    /** 1-based half-move index. */
    ply: number;
    san: string;
    /** Standard UCI (castling as `e1g1`). */
    uci: string;
    fenBefore: string;
    epdBefore: string;
    fenAfter: string;
    epdAfter: string;
    color: "white" | "black";
};

const RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

/** The main-line SAN tokens of a movetext (numbers, NAGs, comments, variations and the result dropped). */
export function sanTokens(movetext: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let inComment = false;
    let token = "";
    const flush = () => {
        if (token) {
            if (depth === 0) pushToken(out, token);
            token = "";
        }
    };
    for (let i = 0; i < movetext.length; i++) {
        const ch = movetext[i];
        if (inComment) {
            if (ch === "}") inComment = false;
            continue;
        }
        if (ch === "{") {
            flush();
            inComment = true;
            continue;
        }
        if (ch === ";") {
            // Rest-of-line comment.
            flush();
            while (i < movetext.length && movetext[i] !== "\n") i++;
            continue;
        }
        if (ch === "(") {
            flush();
            depth++;
            continue;
        }
        if (ch === ")") {
            flush();
            if (depth > 0) depth--;
            continue;
        }
        if (/\s/.test(ch)) {
            flush();
            continue;
        }
        token += ch;
    }
    flush();
    return out;
}

function pushToken(out: string[], raw: string): void {
    let token = raw;
    if (RESULT_TOKENS.has(token)) return;
    if (token.startsWith("$")) return;
    // "12." / "12..." / "12.e4"
    const numbered = /^\d+\.+(.*)$/.exec(token);
    if (numbered) {
        token = numbered[1];
        if (!token) return;
    }
    token = token.replace(/[!?]+$/, "");
    if (!token || RESULT_TOKENS.has(token)) return;
    if (/^0-0(-0)?[+#]?$/.test(token)) token = token.replace(/0/g, "O");
    out.push(token);
}

export type Replay = {
    plies: ReplayPly[];
    /** SAN tokens that were found (the replay may have stopped earlier). */
    tokens: number;
    /** The start position could not be parsed. */
    invalidStart: boolean;
};

/**
 * Replays the main line of `movetext` from `startFen` (the initial position
 * when empty). `maxPlies` caps the work for opening trees.
 */
export function replayMovetext(
    movetext: string,
    startFen?: string | null,
    maxPlies: number = Number.POSITIVE_INFINITY,
): Replay {
    const tokens = sanTokens(movetext);
    const [start] = positionFromFen(startFen && startFen.trim() ? startFen : INITIAL_FEN);
    if (!start) return { plies: [], tokens: tokens.length, invalidStart: true };
    const pos: Chess = start;
    const plies: ReplayPly[] = [];
    let fenBefore = makeFen(pos.toSetup());
    for (let i = 0; i < tokens.length && i < maxPlies; i++) {
        const move = parseSan(pos, tokens[i]);
        if (!move || !("from" in move)) break;
        const color = pos.turn;
        const uci = standardUci(pos, move);
        pos.play(move);
        const fenAfter = makeFen(pos.toSetup());
        plies.push({
            ply: i + 1,
            san: tokens[i],
            uci,
            fenBefore,
            epdBefore: toEpd(fenBefore),
            fenAfter,
            epdAfter: toEpd(fenAfter),
            color,
        });
        fenBefore = fenAfter;
    }
    return { plies, tokens: tokens.length, invalidStart: false };
}

/** "1.e4 c5 2.Nf3" for SAN moves starting at `startPly` (1-based). */
export function formatSanLine(sans: readonly string[], startPly = 1): string {
    const parts: string[] = [];
    sans.forEach((san, i) => {
        const ply = startPly + i;
        const moveNumber = Math.ceil(ply / 2);
        if (ply % 2 === 1) parts.push(`${moveNumber}.${san}`);
        else if (i === 0) parts.push(`${moveNumber}...${san}`);
        else parts.push(san);
    });
    return parts.join(" ");
}

/** Number of leading plies of `game` that follow `line` (both SAN). */
export function followedPlies(line: readonly string[], game: readonly string[]): number {
    let n = 0;
    while (n < line.length && n < game.length && sameSan(line[n], game[n])) n++;
    return n;
}

function sameSan(a: string, b: string): boolean {
    return a.replace(/[+#!?]+$/, "") === b.replace(/[+#!?]+$/, "");
}
