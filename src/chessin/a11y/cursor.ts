/**
 * Keyboard focus mode of the board (plan X-9): a square cursor moved with the
 * arrow keys; `Enter` / `Space` picks a piece up and drops it; `Esc` puts it
 * back or leaves the mode.
 *
 * Pure state machine: `reduceCursor` takes the current state, one normalised
 * input and the board context (position, chessground-style `dests`, which
 * colour may move) and returns the next state plus effects — things to say
 * through the live region, a move to play, or "leave focus mode". The React
 * side (`BoardA11y`) translates the messages and plays the move through the
 * board's own `makeMove`, so practice mode, clocks and engine games behave
 * exactly as for a dragged piece.
 *
 * Legality is the same check chessground uses: `dests` comes from
 * `chessgroundDests(pos)` (chessops), optionally narrowed by the forced
 * en-passant setting. The cursor never asks the tree store directly.
 */
import {
    type Chess,
    type Color,
    makeSquare,
    type NormalMove,
    parseSquare,
    type Role,
    type SquareName,
} from "chessops";

export type Orientation = "white" | "black";
export type CursorDirection = "up" | "down" | "left" | "right";

export type CursorPhase =
    | { kind: "idle" }
    | { kind: "picked"; from: SquareName; dests: SquareName[] }
    | { kind: "promotion"; from: SquareName; to: SquareName };

export type CursorState = { square: SquareName; phase: CursorPhase };

export type CursorInput =
    | { type: "move"; dir: CursorDirection }
    | { type: "select" }
    | { type: "cancel" }
    | { type: "promote"; role: Role };

export type CursorContext = {
    pos: Chess | null;
    /** Legal destinations per origin as chessground gets them; `null` when the board is locked. */
    dests: Map<SquareName, SquareName[]> | null;
    /** Which colour the user may move (`undefined` = none). */
    movable: Color | "both" | undefined;
    orientation: Orientation;
    /** Promote straight to a queen instead of asking (the board's "自动升变" setting). */
    autoPromote: boolean;
};

export type CursorEffect =
    | { type: "say"; message: "cursor"; square: SquareName }
    | {
          type: "say";
          message: "pickedUp";
          square: SquareName;
          piece: Role;
          color: Color;
          dests: SquareName[];
      }
    | { type: "say"; message: "noPiece" | "illegal"; square: SquareName }
    | { type: "say"; message: "cancelled" | "locked" | "promotion" }
    | { type: "move"; move: NormalMove }
    | { type: "exit" };

export type CursorResult = { state: CursorState; effects: CursorEffect[] };

const IDLE: CursorPhase = { kind: "idle" };

/** Where the cursor starts: the bottom side's king square, so the first announcement is familiar. */
export function initialCursor(orientation: Orientation): CursorState {
    return { square: orientation === "white" ? "e1" : "e8", phase: IDLE };
}

/**
 * Moves one square in *screen* direction, clamped at the edge: "up" is
 * towards the far side of the board whichever colour is at the bottom.
 */
export function moveCursor(
    square: SquareName,
    dir: CursorDirection,
    orientation: Orientation,
): SquareName {
    const sq = parseSquare(square);
    if (sq === undefined) return square;
    let file = sq & 7;
    let rank = sq >> 3;
    const flip = orientation === "black" ? -1 : 1;
    switch (dir) {
        case "up":
            rank += flip;
            break;
        case "down":
            rank -= flip;
            break;
        case "right":
            file += flip;
            break;
        case "left":
            file -= flip;
            break;
    }
    file = Math.min(7, Math.max(0, file));
    rank = Math.min(7, Math.max(0, rank));
    return makeSquare(rank * 8 + file);
}

/** Maps a `KeyboardEvent.key` to a cursor input; `null` for keys the cursor ignores. */
export function keyToInput(key: string, phase: CursorPhase): CursorInput | null {
    switch (key) {
        case "ArrowUp":
            return { type: "move", dir: "up" };
        case "ArrowDown":
            return { type: "move", dir: "down" };
        case "ArrowLeft":
            return { type: "move", dir: "left" };
        case "ArrowRight":
            return { type: "move", dir: "right" };
        case "Enter":
        case " ":
            return { type: "select" };
        case "Escape":
            return { type: "cancel" };
    }
    if (phase.kind === "promotion") {
        switch (key.toLowerCase()) {
            case "q":
                return { type: "promote", role: "queen" };
            case "r":
                return { type: "promote", role: "rook" };
            case "b":
                return { type: "promote", role: "bishop" };
            case "n":
                return { type: "promote", role: "knight" };
        }
    }
    return null;
}

function canMove(color: Color, movable: CursorContext["movable"]): boolean {
    return movable === "both" || movable === color;
}

/** True when the pawn on `from` reaches its last rank on `to`. */
export function needsPromotion(pos: Chess | null, from: SquareName, to: SquareName): boolean {
    if (!pos) return false;
    const fromSq = parseSquare(from);
    const toSq = parseSquare(to);
    if (fromSq === undefined || toSq === undefined) return false;
    const piece = pos.board.get(fromSq);
    if (piece?.role !== "pawn") return false;
    const rank = toSq >> 3;
    return (piece.color === "white" && rank === 7) || (piece.color === "black" && rank === 0);
}

function makeMove(from: SquareName, to: SquareName, promotion?: Role): NormalMove {
    return { from: parseSquare(from)!, to: parseSquare(to)!, promotion };
}

function tryPickUp(state: CursorState, ctx: CursorContext): CursorResult {
    const { square } = state;
    if (!ctx.dests || !ctx.pos) {
        return { state, effects: [{ type: "say", message: "locked" }] };
    }
    const piece = ctx.pos.board.get(parseSquare(square)!);
    const dests = ctx.dests.get(square) ?? [];
    if (!piece || !canMove(piece.color, ctx.movable) || dests.length === 0) {
        return { state, effects: [{ type: "say", message: "noPiece", square }] };
    }
    return {
        state: { square, phase: { kind: "picked", from: square, dests } },
        effects: [
            {
                type: "say",
                message: "pickedUp",
                square,
                piece: piece.role,
                color: piece.color,
                dests,
            },
        ],
    };
}

function drop(
    state: CursorState,
    from: SquareName,
    to: SquareName,
    ctx: CursorContext,
): CursorResult {
    if (needsPromotion(ctx.pos, from, to)) {
        if (ctx.autoPromote) {
            return {
                state: { square: to, phase: IDLE },
                effects: [{ type: "move", move: makeMove(from, to, "queen") }],
            };
        }
        return {
            state: { square: to, phase: { kind: "promotion", from, to } },
            effects: [{ type: "say", message: "promotion" }],
        };
    }
    return {
        state: { square: to, phase: IDLE },
        effects: [{ type: "move", move: makeMove(from, to) }],
    };
}

export function reduceCursor(
    state: CursorState,
    input: CursorInput,
    ctx: CursorContext,
): CursorResult {
    const { phase } = state;
    switch (input.type) {
        case "move": {
            const square = moveCursor(state.square, input.dir, ctx.orientation);
            return {
                state: { ...state, square },
                effects: [{ type: "say", message: "cursor", square }],
            };
        }
        case "select": {
            if (phase.kind === "promotion") {
                return {
                    state: { square: state.square, phase: IDLE },
                    effects: [{ type: "move", move: makeMove(phase.from, phase.to, "queen") }],
                };
            }
            if (phase.kind === "picked") {
                if (state.square === phase.from) {
                    return {
                        state: { square: state.square, phase: IDLE },
                        effects: [{ type: "say", message: "cancelled" }],
                    };
                }
                if (phase.dests.includes(state.square)) {
                    return drop(state, phase.from, state.square, ctx);
                }
                // Another own piece: switch to it instead of refusing.
                const other = ctx.pos?.board.get(parseSquare(state.square)!);
                if (
                    other &&
                    canMove(other.color, ctx.movable) &&
                    ctx.dests?.get(state.square)?.length
                ) {
                    return tryPickUp({ square: state.square, phase: IDLE }, ctx);
                }
                return {
                    state,
                    effects: [{ type: "say", message: "illegal", square: state.square }],
                };
            }
            return tryPickUp(state, ctx);
        }
        case "cancel": {
            if (phase.kind === "idle") {
                return { state, effects: [{ type: "exit" }] };
            }
            return {
                state: { square: state.square, phase: IDLE },
                effects: [{ type: "say", message: "cancelled" }],
            };
        }
        case "promote": {
            if (phase.kind !== "promotion") return { state, effects: [] };
            return {
                state: { square: state.square, phase: IDLE },
                effects: [{ type: "move", move: makeMove(phase.from, phase.to, input.role) }],
            };
        }
    }
}
