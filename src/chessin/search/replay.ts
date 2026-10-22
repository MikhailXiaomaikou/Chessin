import type { Board } from "chessops/board";
import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { parsePgn } from "chessops/pgn";
import { parseSan } from "chessops/san";
import type { Color } from "chessops/types";
import {
    materialKey,
    materialKeyOfBoard,
    parseSetup,
    pawnKey,
    pawnKeyOfBoard,
    positionKey,
    positionKeyOfBoard,
} from "./fen";

/**
 * Replays a game's movetext with chessops to find the ply at which it
 * matches a query. This is what gives every row of the "查找相似" drawer a
 * `MiniBoard` at the matched ply, and what turns the superset candidates of
 * `search_position { type_: "partial" }` (see `similar.ts`) into exact
 * "same pawn structure" hits.
 */

export type SimilarMode = "position" | "pawns" | "pawnsMaterial";

export type MatchQuery = {
    mode: SimilarMode;
    positionKey: string;
    pawnKey: string;
    materialKey: string;
};

/** Replays stop after this many plies (`search_index` games are capped similarly). */
export const MAX_REPLAY_PLY = 600;

export function buildMatchQuery(fen: string, mode: SimilarMode): MatchQuery | null {
    const position = positionKey(fen);
    const pawns = pawnKey(fen);
    const material = materialKey(fen);
    if (position === null || pawns === null || material === null) return null;
    return { mode, positionKey: position, pawnKey: pawns, materialKey: material };
}

export function matchesBoard(board: Board, turn: Color, query: MatchQuery): boolean {
    switch (query.mode) {
        case "position":
            return positionKeyOfBoard(board, turn) === query.positionKey;
        case "pawns":
            return pawnKeyOfBoard(board) === query.pawnKey;
        case "pawnsMaterial":
            return (
                pawnKeyOfBoard(board) === query.pawnKey &&
                materialKeyOfBoard(board) === query.materialKey
            );
    }
}

function startPosition(startFen: string | null | undefined): Chess | null {
    const setup = parseSetup(startFen && startFen.trim() !== "" ? startFen : INITIAL_FEN);
    if (!setup) return null;
    const pos = Chess.fromSetup(setup);
    return pos.isOk ? pos.value : null;
}

/** SAN of the main line of `movetext` (a bare movetext or a full PGN game). */
function mainlineSan(movetext: string): string[] | null {
    let games: ReturnType<typeof parsePgn>;
    try {
        games = parsePgn(movetext);
    } catch {
        return null;
    }
    const game = games[0];
    if (!game) return null;
    const out: string[] = [];
    for (const node of game.moves.mainline()) out.push(node.san);
    return out;
}

export type ReplayHit = { ply: number; fen: string };

/**
 * The first ply (0 = the start position) of the main line of `movetext`,
 * played from `startFen` (empty / missing = the standard start), whose
 * position satisfies `query`; `null` when none does or the game cannot be
 * replayed (illegal SAN, unparsable FEN).
 */
export function findMatchedPly(
    movetext: string,
    startFen: string | null | undefined,
    query: MatchQuery,
    maxPly = MAX_REPLAY_PLY,
): ReplayHit | null {
    const pos = startPosition(startFen);
    if (!pos) return null;
    if (matchesBoard(pos.board, pos.turn, query)) return { ply: 0, fen: makeFen(pos.toSetup()) };
    const sans = mainlineSan(movetext);
    if (!sans) return null;
    let ply = 0;
    for (const san of sans) {
        if (ply >= maxPly) break;
        const move = parseSan(pos, san);
        if (!move) return null;
        pos.play(move);
        ply += 1;
        if (matchesBoard(pos.board, pos.turn, query)) {
            return { ply, fen: makeFen(pos.toSetup()) };
        }
    }
    return null;
}

/** The FEN after `ply` main-line moves of `movetext`; `null` when the game is shorter or invalid. */
export function fenAtPly(
    movetext: string,
    startFen: string | null | undefined,
    ply: number,
): string | null {
    const pos = startPosition(startFen);
    if (!pos) return null;
    if (ply <= 0) return makeFen(pos.toSetup());
    const sans = mainlineSan(movetext);
    if (!sans || sans.length < ply) return null;
    for (let i = 0; i < ply; i++) {
        const move = parseSan(pos, sans[i]);
        if (!move) return null;
        pos.play(move);
    }
    return makeFen(pos.toSetup());
}
