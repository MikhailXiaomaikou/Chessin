/**
 * Pure chessops helpers shared by the X-1 detectors: position parsing, piece
 * values, attackers, a static-exchange evaluation ("SEE-lite"), absolute pins,
 * forks, skewers, mate finders, passed pawns, development and king shelter.
 *
 * Everything here is deterministic and engine-free. Squares are chessops
 * `Square` numbers (0 = a1 … 63 = h8); names are only produced at the edge
 * with `makeSquare`.
 */
import {
    attacks,
    between,
    bishopAttacks,
    type Board,
    Chess,
    type Color,
    kingAttacks,
    knightAttacks,
    type Move,
    makeSquare,
    type NormalMove,
    opposite,
    parseUci,
    pawnAttacks,
    type Piece,
    ray,
    type Role,
    rookAttacks,
    type Square,
    SquareSet,
    squareFile,
    squareRank,
} from "chessops";
import { castlingSide } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { squareFromCoords } from "chessops/util";

export const PIECE_VALUES: Record<Role, number> = {
    pawn: 1,
    knight: 3,
    bishop: 3,
    rook: 5,
    queen: 9,
    king: 100,
};

export const pieceValue = (role: Role): number => PIECE_VALUES[role];

const ROLE_ORDER: Role[] = ["pawn", "knight", "bishop", "rook", "queen", "king"];

export function positionFrom(fen: string): Chess | null {
    const setup = parseFen(fen);
    if (setup.isErr) return null;
    const pos = Chess.fromSetup(setup.unwrap());
    return pos.isErr ? null : pos.unwrap();
}

export const fenOf = (pos: Chess): string => makeFen(pos.toSetup());

/** Parses a UCI string into a legal normal move for `pos`, or null. */
export function parseLegalUci(pos: Chess, uci: string): NormalMove | null {
    const move = parseUci(uci);
    if (!move || !("from" in move)) return null;
    return pos.isLegal(move) ? move : null;
}

/** Plays `uci` on a clone of `pos`; null when the move is not legal. */
export function playUci(pos: Chess, uci: string): { pos: Chess; move: NormalMove } | null {
    const move = parseLegalUci(pos, uci);
    if (!move) return null;
    return { pos: playMove(pos, move), move };
}

export function playMove(pos: Chess, move: Move): Chess {
    const next = pos.clone();
    next.play(move);
    return next;
}

export const sanOf = (pos: Chess, move: Move): string => makeSan(pos, move);

export const uciOf = (move: NormalMove): string =>
    makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? move.promotion[0] : "");

export const isCapture = (pos: Chess, move: NormalMove): boolean =>
    pos.board.has(move.to) || (pos.board.getRole(move.from) === "pawn" && move.to === pos.epSquare);

export function capturedValue(pos: Chess, move: NormalMove): number {
    const victim = pos.board.getRole(move.to);
    if (victim) return pieceValue(victim);
    if (pos.board.getRole(move.from) === "pawn" && move.to === pos.epSquare) return 1;
    return 0;
}

export const givesCheck = (pos: Chess, move: Move): boolean => playMove(pos, move).isCheck();

export const isCastling = (pos: Chess, move: Move): boolean =>
    castlingSide(pos, move) !== undefined;

/** Pieces of `color` (within `occupied`) that attack `square`. X-rays are not counted. */
export function attackersTo(
    board: Board,
    square: Square,
    color: Color,
    occupied: SquareSet,
): SquareSet {
    return rookAttacks(square, occupied)
        .intersect(board.rooksAndQueens())
        .union(bishopAttacks(square, occupied).intersect(board.bishopsAndQueens()))
        .union(knightAttacks(square).intersect(board.knight))
        .union(kingAttacks(square).intersect(board.king))
        .union(pawnAttacks(opposite(color), square).intersect(board.pawn))
        .intersect(board[color])
        .intersect(occupied);
}

/** Least valuable piece of `color` attacking `square`, or undefined. */
export function leastValuableAttacker(
    board: Board,
    square: Square,
    color: Color,
    occupied: SquareSet,
): Square | undefined {
    const attackersSet = attackersTo(board, square, color, occupied);
    if (attackersSet.isEmpty()) return undefined;
    for (const role of ROLE_ORDER) {
        const sq = attackersSet.intersect(board[role]).first();
        if (sq !== undefined) return sq;
    }
    return undefined;
}

/**
 * Static exchange evaluation on `target` for the side to move in `pos`
 * (positive = the side to move wins that much material by capturing there,
 * in pawns). `from` forces the first capturer; otherwise the least valuable
 * attacker starts. Sliders behind the capturer are revealed as pieces are
 * removed (x-rays). A king only captures when the square is no longer
 * attacked. Pins and in-between moves are ignored — hence "lite".
 */
export function see(pos: Chess, target: Square, from?: Square): number {
    const board = pos.board;
    const victim = board.get(target);
    if (!victim) return 0;
    let side = pos.turn;
    let occupied = board.occupied;
    // a king may only capture when the square is not defended
    const kingMayCapture = (square: Square | undefined, by: Color): boolean =>
        square === undefined ||
        board.getRole(square) !== "king" ||
        attackersTo(board, target, opposite(by), occupied.without(square)).isEmpty();
    let attacker = from ?? leastValuableAttacker(board, target, side, occupied);
    if (attacker === undefined || !kingMayCapture(attacker, side)) return 0;
    const gain: number[] = [pieceValue(victim.role)];
    let d = 0;
    // No early pruning: the usual `max(-gain[d-1], gain[d]) < 0` cut drops the
    // recapture that improves the result (e.g. Rxd5 exd5 Qxd5 with an x-ray).
    while (attacker !== undefined) {
        const role = board.getRole(attacker);
        if (!role) break;
        d++;
        gain[d] = pieceValue(role) - gain[d - 1];
        occupied = occupied.without(attacker);
        side = opposite(side);
        attacker = leastValuableAttacker(board, target, side, occupied);
        if (!kingMayCapture(attacker, side)) attacker = undefined;
    }
    while (--d > 0) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
    return gain[0];
}

/** Pieces of the side to move that may legally capture on `target`. */
export function legalCapturers(pos: Chess, target: Square): SquareSet {
    let out = SquareSet.empty();
    for (const from of attackersTo(pos.board, target, pos.turn, pos.board.occupied)) {
        if (pos.dests(from).has(target)) out = out.with(from);
    }
    return out;
}

export type WinningCapture = {
    square: Square;
    piece: Piece;
    /** least valuable legal capturer */
    attacker: Square;
    /** SEE result in pawns for the capturing side */
    gain: number;
    /** true when the victim has no defender at all */
    undefended: boolean;
};

/**
 * Enemy pieces (never the king) that the side to move can win by capturing:
 * a legal first capture whose SEE is positive. Sorted by gain, descending.
 */
export function winningCaptures(pos: Chess): WinningCapture[] {
    const us = pos.turn;
    const them = opposite(us);
    const board = pos.board;
    const out: WinningCapture[] = [];
    for (const square of board[them].diff(board.king)) {
        const capturers = legalCapturers(pos, square);
        if (capturers.isEmpty()) continue;
        let attacker: Square | undefined;
        for (const role of ROLE_ORDER) {
            attacker = capturers.intersect(board[role]).first();
            if (attacker !== undefined) break;
        }
        if (attacker === undefined) continue;
        const gain = see(pos, square, attacker);
        if (gain <= 0) continue;
        const piece = board.get(square);
        if (!piece) continue;
        const undefended = attackersTo(
            board,
            square,
            them,
            board.occupied.without(attacker),
        ).isEmpty();
        out.push({ square, piece, attacker, gain, undefended });
    }
    return out.sort((a, b) => b.gain - a.gain);
}

export type Pin = { pinned: Square; pinner: Square; king: Square };

/** Pieces of `color` absolutely pinned to their own king. */
export function absolutePins(board: Board, color: Color): Pin[] {
    const king = board.kingOf(color);
    if (king === undefined) return [];
    const snipers = rookAttacks(king, SquareSet.empty())
        .intersect(board.rooksAndQueens())
        .union(bishopAttacks(king, SquareSet.empty()).intersect(board.bishopsAndQueens()))
        .intersect(board[opposite(color)]);
    const out: Pin[] = [];
    for (const pinner of snipers) {
        const blockers = between(king, pinner).intersect(board.occupied);
        const pinned = blockers.singleSquare();
        if (pinned !== undefined && board[color].has(pinned)) out.push({ pinned, pinner, king });
    }
    return out;
}

/**
 * Absolute pins on the opponent that exist after `move` but not before, where
 * the pinner cannot simply be captured for a profit.
 */
export function pinsCreated(pos: Chess, move: Move): { pin: Pin; piece: Piece; after: Chess }[] {
    const them = opposite(pos.turn);
    const before = new Set(absolutePins(pos.board, them).map((p) => p.pinned));
    const after = playMove(pos, move);
    const out: { pin: Pin; piece: Piece; after: Chess }[] = [];
    for (const pin of absolutePins(after.board, them)) {
        if (before.has(pin.pinned)) continue;
        const piece = after.board.get(pin.pinned);
        if (!piece || piece.role === "pawn") continue;
        if (see(after, pin.pinner) > 0) continue;
        out.push({ pin, piece, after });
    }
    return out;
}

export type Skewer = { checker: Square; king: Square; target: Square; piece: Piece; after: Chess };

/**
 * `move` gives a slider check with an enemy piece (worth at least a minor)
 * behind the king on the same line, and the checker cannot be won by a capture.
 */
export function skewerBy(pos: Chess, move: Move): Skewer | null {
    const after = playMove(pos, move);
    if (!after.isCheck()) return null;
    const ctx = after.ctx();
    const checker = ctx.checkers.singleSquare();
    const king = ctx.king;
    if (checker === undefined || king === undefined) return null;
    const role = after.board.getRole(checker);
    if (role !== "bishop" && role !== "rook" && role !== "queen") return null;
    if (see(after, checker) > 0) return null;
    const line = ray(checker, king);
    if (line.isEmpty()) return null;
    const step = stepBetween(checker, king);
    if (step === 0) return null;
    for (let sq = king + step; sq >= 0 && sq < 64 && line.has(sq); sq += step) {
        const piece = after.board.get(sq);
        if (!piece) continue;
        if (piece.color !== after.turn || piece.role === "king" || pieceValue(piece.role) < 3)
            return null;
        // a defended piece worth no more than the checker is a trade, not a skewer
        const defended = attackersTo(after.board, sq, after.turn, after.board.occupied).nonEmpty();
        if (defended && pieceValue(piece.role) <= pieceValue(role)) return null;
        return { checker, king, target: sq, piece, after };
    }
    return null;
}

/** Square increment that walks from `a` towards `b` along a rank, file or diagonal. */
function stepBetween(a: Square, b: Square): number {
    const df = Math.sign(squareFile(b) - squareFile(a));
    const dr = Math.sign(squareRank(b) - squareRank(a));
    return dr * 8 + df;
}

export type Fork = {
    move: NormalMove;
    forker: Piece;
    targets: { square: Square; piece: Piece }[];
    after: Chess;
};

const forkWorth = (f: Fork) =>
    f.targets.reduce((s, t) => s + (t.piece.role === "king" ? 50 : pieceValue(t.piece.role)), 0);

/**
 * Legal moves of the side to move after which the moved piece attacks at
 * least two enemy pieces that are each worth more than it, undefended, or the
 * king — and the forking piece itself cannot be won by a capture.
 * Best (by total target value) first.
 */
export function findForks(pos: Chess, limit = 3): Fork[] {
    const them = opposite(pos.turn);
    const forks: Fork[] = [];
    for (const [from, dests] of pos.allDests()) {
        const piece = pos.board.get(from);
        if (!piece || piece.role === "king") continue;
        for (const to of dests) {
            const occ = pos.board.occupied.without(from).with(to);
            const hit = attacks(piece, to, occ).intersect(pos.board[them]);
            if (hit.size() < 2) continue;
            const move: NormalMove = { from, to };
            if (piece.role === "pawn" && (squareRank(to) === 0 || squareRank(to) === 7)) {
                move.promotion = "queen";
            }
            const after = playMove(pos, move);
            const forker = after.board.get(to);
            if (!forker) continue;
            const targets: Fork["targets"] = [];
            for (const sq of attacks(forker, to, after.board.occupied).intersect(
                after.board[them],
            )) {
                const target = after.board.get(sq);
                if (!target) continue;
                const defended = attackersTo(
                    after.board,
                    sq,
                    them,
                    after.board.occupied,
                ).nonEmpty();
                if (
                    target.role === "king" ||
                    pieceValue(target.role) > pieceValue(forker.role) ||
                    !defended
                ) {
                    targets.push({ square: sq, piece: target });
                }
            }
            if (targets.length < 2) continue;
            if (see(after, to) > 0) continue;
            forks.push({ move, forker, targets, after });
        }
    }
    return forks.sort((a, b) => forkWorth(b) - forkWorth(a)).slice(0, limit);
}

/** Whether `move` by the side to move is itself a fork (see `findForks`). */
export function forkOf(pos: Chess, move: NormalMove): Fork | null {
    return (
        findForks(pos, 64).find((f) => f.move.from === move.from && f.move.to === move.to) ?? null
    );
}

/** All legal moves that checkmate immediately. */
export function matingMoves(pos: Chess): NormalMove[] {
    const out: NormalMove[] = [];
    for (const [from, dests] of pos.allDests()) {
        const role = pos.board.getRole(from);
        for (const to of dests) {
            const promo = role === "pawn" && (squareRank(to) === 0 || squareRank(to) === 7);
            const move: NormalMove = promo ? { from, to, promotion: "queen" } : { from, to };
            if (playMove(pos, move).isCheckmate()) out.push(move);
        }
    }
    return out;
}

export type MateLine = { moves: NormalMove[]; length: 1 | 2 };

/**
 * Forced mate within two moves for the side to move: a mate in one, or a
 * checking move after which every legal reply allows a mate in one. Returns
 * one sample line (first move, a reply, the mate).
 */
export function forcedMate(pos: Chess): MateLine | null {
    const m1 = matingMoves(pos);
    if (m1.length > 0) return { moves: [m1[0]], length: 1 };
    for (const [from, dests] of pos.allDests()) {
        for (const to of dests) {
            const move: NormalMove = { from, to };
            const after = playMove(pos, move);
            if (!after.isCheck()) continue;
            const replies: NormalMove[] = [];
            for (const [rf, rd] of after.allDests()) {
                for (const rt of rd) replies.push({ from: rf, to: rt });
            }
            if (replies.length === 0) continue;
            let sample: NormalMove[] | null = null;
            let forced = true;
            for (const reply of replies) {
                const next = playMove(after, reply);
                const mates = matingMoves(next);
                if (mates.length === 0) {
                    forced = false;
                    break;
                }
                sample ??= [move, reply, mates[0]];
            }
            if (forced && sample) return { moves: sample, length: 2 };
        }
    }
    return null;
}

/** The mated king sits on its back rank and a rook or queen mates along that rank. */
export function isBackRankMate(pos: Chess, move: NormalMove): boolean {
    const after = playMove(pos, move);
    if (!after.isCheckmate()) return false;
    const king = after.board.kingOf(after.turn);
    if (king === undefined) return false;
    const backRank = after.turn === "white" ? 0 : 7;
    if (squareRank(king) !== backRank) return false;
    const piece = after.board.get(move.to);
    if (!piece || (piece.role !== "rook" && piece.role !== "queen")) return false;
    return squareRank(move.to) === backRank;
}

/** Squares with passed pawns of `color`. */
export function passedPawns(board: Board, color: Color): SquareSet {
    const enemyPawns = board.pieces(opposite(color), "pawn");
    let out = SquareSet.empty();
    for (const sq of board.pieces(color, "pawn")) {
        const file = squareFile(sq);
        const rank = squareRank(sq);
        let front = SquareSet.empty();
        for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
            for (
                let r = rank + (color === "white" ? 1 : -1);
                r >= 0 && r < 8;
                r += color === "white" ? 1 : -1
            ) {
                const s = squareFromCoords(f, r);
                if (s !== undefined) front = front.with(s);
            }
        }
        if (front.isDisjoint(enemyPawns)) out = out.with(sq);
    }
    return out;
}

/** Ranks advanced from the pawn's starting rank (0 … 5). */
export const pawnAdvancement = (sq: Square, color: Color): number =>
    color === "white" ? squareRank(sq) - 1 : 6 - squareRank(sq);

export const squareInFront = (sq: Square, color: Color): Square | undefined =>
    squareFromCoords(squareFile(sq), squareRank(sq) + (color === "white" ? 1 : -1));

export function material(board: Board, color: Color): number {
    let sum = 0;
    for (const role of ROLE_ORDER) {
        if (role === "king") continue;
        sum += board.pieces(color, role).size() * pieceValue(role);
    }
    return sum;
}

/** `color`'s material minus the opponent's, in pawns. */
export const materialBalance = (board: Board, color: Color): number =>
    material(board, color) - material(board, opposite(color));

export const nonPawnPieces = (board: Board, color: Color): number =>
    board[color].diff(board.pawn).diff(board.king).size();

const HOME_MINORS: Record<Color, SquareSet> = {
    white: SquareSet.empty().with(1).with(2).with(5).with(6),
    black: SquareSet.empty().with(57).with(58).with(61).with(62),
};

/** Knights and bishops of `color` still on their starting squares. */
export const undevelopedMinors = (board: Board, color: Color): SquareSet =>
    HOME_MINORS[color].intersect(board[color]).intersect(board.knight.union(board.bishop));

export type Development = "minor" | "castle" | null;

/** A knight/bishop leaving its home square towards the board, or castling. */
export function developmentOf(pos: Chess, move: NormalMove): Development {
    if (isCastling(pos, move)) return "castle";
    const piece = pos.board.get(move.from);
    if (!piece || (piece.role !== "knight" && piece.role !== "bishop")) return null;
    if (!HOME_MINORS[piece.color].has(move.from)) return null;
    const backRank = piece.color === "white" ? 0 : 7;
    return squareRank(move.to) === backRank ? null : "minor";
}

/** Opening by a cheap proxy: early and at least two minor pieces still at home. */
export const isOpening = (pos: Chess): boolean =>
    pos.fullmoves <= 15 &&
    undevelopedMinors(pos.board, "white").size() + undevelopedMinors(pos.board, "black").size() >=
        2;

export const isRimSquare = (sq: Square): boolean =>
    squareFile(sq) === 0 || squareFile(sq) === 7 || squareRank(sq) === 0 || squareRank(sq) === 7;

const BIG_CENTER = (() => {
    let s = SquareSet.empty();
    for (let f = 2; f <= 5; f++) for (let r = 2; r <= 5; r++) s = s.with(f + 8 * r);
    return s;
})();

export const isCentralSquare = (sq: Square): boolean => BIG_CENTER.has(sq);

export type KingShelter = { king: Square; pawns: SquareSet };

/**
 * The king's pawn shelter: when the king sits on its back rank, the own pawns
 * on the three adjacent files up to two ranks ahead.
 */
export function kingShelter(board: Board, color: Color): KingShelter | null {
    const king = board.kingOf(color);
    if (king === undefined) return null;
    const backRank = color === "white" ? 0 : 7;
    if (squareRank(king) !== backRank) return null;
    const dir = color === "white" ? 1 : -1;
    const kf = squareFile(king);
    let zone = SquareSet.empty();
    for (let f = Math.max(0, kf - 1); f <= Math.min(7, kf + 1); f++) {
        for (let d = 1; d <= 2; d++) {
            const s = squareFromCoords(f, backRank + d * dir);
            if (s !== undefined) zone = zone.with(s);
        }
    }
    return { king, pawns: zone.intersect(board.pieces(color, "pawn")) };
}

/** Attacking potential of `color`: queen plus at least one more piece. */
export const hasAttackingForce = (board: Board, color: Color): boolean =>
    board.pieces(color, "queen").nonEmpty() && nonPawnPieces(board, color) >= 2;

/** Squares of `color`'s pieces attacked by the opponent, ignoring the king. */
export function attackedPieces(pos: Chess, color: Color): SquareSet {
    let out = SquareSet.empty();
    for (const sq of pos.board[color].diff(pos.board.king)) {
        if (attackersTo(pos.board, sq, opposite(color), pos.board.occupied).nonEmpty())
            out = out.with(sq);
    }
    return out;
}

export const squareName = makeSquare;
