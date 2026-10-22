import type { Board } from "chessops/board";
import { makeBoardFen, makeFen, parseFen } from "chessops/fen";
import type { Setup } from "chessops/setup";
import { SquareSet } from "chessops/squareSet";
import type { Color } from "chessops/types";

/**
 * Pure FEN helpers for the position index and the "查找相似" drawer (S3-2).
 *
 * Nothing here touches Tauri or React; everything is unit-tested in
 * `fen.test.ts`.
 */

/** What a reduced FEN keeps: the pawns only, or pawns and both kings. */
export type ReduceMode = "pawns" | "pawnsKings";

/**
 * Plies played since the game's start as implied by the FEN's side to move and
 * fullmove number (ply 0 = the standard start position, 1 = after 1. e4, …).
 * The index only covers the first `MAX_INDEX_PLY` plies of each game.
 */
export function plyFromFen(fen: string): number {
    const parts = fen.trim().split(/\s+/);
    const turn = parts[1] === "b" ? 1 : 0;
    const fullmove = Number.parseInt(parts[5] ?? "1", 10);
    const n = Number.isFinite(fullmove) && fullmove >= 1 ? fullmove : 1;
    return (n - 1) * 2 + turn;
}

/** `null` when the FEN does not parse. */
export function parseSetup(fen: string): Setup | null {
    const result = parseFen(fen.trim());
    return result.isOk ? result.value : null;
}

/**
 * The FEN with every piece removed except the pawns (and, with `pawnsKings`,
 * the kings). Castling rights and the en-passant square are cleared; side to
 * move and the move counters stay. This is the query En Croissant's own
 * "相似结构" button sends to `search_position` with `type_: "partial"`.
 */
export function reduceFen(fen: string, mode: ReduceMode): string | null {
    const setup = parseSetup(fen);
    if (!setup) return null;
    const keep = mode === "pawns" ? setup.board.pawn : setup.board.pawn.union(setup.board.king);
    for (const square of setup.board.occupied.diff(keep)) {
        setup.board.take(square);
    }
    setup.castlingRights = SquareSet.empty();
    setup.epSquare = undefined;
    return makeFen(setup);
}

function squares(set: SquareSet): string {
    return Array.from(set).join(",");
}

/** Pawn placement of both colours; equal keys = the same pawn structure. */
export function pawnKeyOfBoard(board: Board): string {
    return `${squares(board.pawn.intersect(board.white))}/${squares(board.pawn.intersect(board.black))}`;
}

const MATERIAL_ROLES = ["queen", "rook", "bishop", "knight"] as const;

/**
 * Piece counts per colour (queens, rooks, bishops, knights — pawns are the
 * structure, kings are always one), e.g. `"w1221/b1212"`.
 */
export function materialKeyOfBoard(board: Board): string {
    const count = (color: Color) =>
        MATERIAL_ROLES.map((role) => board.pieces(color, role).size()).join("");
    return `w${count("white")}/b${count("black")}`;
}

/** Piece placement plus side to move: what `search_position` calls an exact match. */
export function positionKeyOfBoard(board: Board, turn: Color): string {
    return `${makeBoardFen(board)} ${turn}`;
}

export function pawnKey(fen: string): string | null {
    const setup = parseSetup(fen);
    return setup ? pawnKeyOfBoard(setup.board) : null;
}

export function materialKey(fen: string): string | null {
    const setup = parseSetup(fen);
    return setup ? materialKeyOfBoard(setup.board) : null;
}

export function positionKey(fen: string): string | null {
    const setup = parseSetup(fen);
    return setup ? positionKeyOfBoard(setup.board, setup.turn) : null;
}

/** Tree path of the main-line node reached after `ply` moves (for `openInWorkspace`'s `position`). */
export function mainLinePathToPly(ply: number): number[] {
    const n = Math.max(0, Math.floor(ply));
    return Array.from({ length: n }, () => 0);
}
