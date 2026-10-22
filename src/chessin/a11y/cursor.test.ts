import { Chess, makeUci, type NormalMove, parseSquare, type SquareName } from "chessops";
import { chessgroundDests } from "chessops/compat";
import { parseFen } from "chessops/fen";
import { describe, expect, it } from "vitest";
import {
    type CursorContext,
    type CursorInput,
    type CursorState,
    initialCursor,
    keyToInput,
    moveCursor,
    needsPromotion,
    reduceCursor,
} from "./cursor";

function contextFor(fen?: string, extra: Partial<CursorContext> = {}): CursorContext {
    const pos = fen ? Chess.fromSetup(parseFen(fen).unwrap()).unwrap() : Chess.default();
    return {
        pos,
        dests: chessgroundDests(pos),
        movable: pos.turn,
        orientation: "white",
        autoPromote: false,
        ...extra,
    };
}

function at(square: SquareName, phase: CursorState["phase"] = { kind: "idle" }): CursorState {
    return { square, phase };
}

function run(state: CursorState, inputs: CursorInput[], ctx: CursorContext) {
    let current = state;
    let effects: ReturnType<typeof reduceCursor>["effects"] = [];
    for (const input of inputs) {
        const result = reduceCursor(current, input, ctx);
        current = result.state;
        effects = result.effects;
    }
    return { state: current, effects };
}

const uci = (m: NormalMove) => makeUci(m);

describe("moveCursor", () => {
    it("moves in screen directions and stops at the edges", () => {
        expect(moveCursor("e1", "up", "white")).toBe("e2");
        expect(moveCursor("e1", "down", "white")).toBe("e1");
        expect(moveCursor("a1", "left", "white")).toBe("a1");
        expect(moveCursor("h8", "right", "white")).toBe("h8");
        expect(moveCursor("d4", "right", "white")).toBe("e4");
    });

    it("follows the flipped board when Black is at the bottom", () => {
        expect(moveCursor("e8", "up", "black")).toBe("e7");
        expect(moveCursor("e4", "right", "black")).toBe("d4");
        expect(moveCursor("a1", "left", "black")).toBe("b1");
        expect(moveCursor("e1", "down", "black")).toBe("e2");
        expect(initialCursor("black").square).toBe("e8");
        expect(initialCursor("white").square).toBe("e1");
    });
});

describe("keyToInput", () => {
    it("maps arrows, Enter / Space, Escape and the promotion letters", () => {
        expect(keyToInput("ArrowUp", { kind: "idle" })).toEqual({ type: "move", dir: "up" });
        expect(keyToInput("ArrowLeft", { kind: "idle" })).toEqual({ type: "move", dir: "left" });
        expect(keyToInput("Enter", { kind: "idle" })).toEqual({ type: "select" });
        expect(keyToInput(" ", { kind: "idle" })).toEqual({ type: "select" });
        expect(keyToInput("Escape", { kind: "idle" })).toEqual({ type: "cancel" });
        expect(keyToInput("q", { kind: "idle" })).toBeNull();
        expect(keyToInput("f", { kind: "idle" })).toBeNull();
        const promo = { kind: "promotion", from: "e7", to: "e8" } as const;
        expect(keyToInput("N", promo)).toEqual({ type: "promote", role: "knight" });
        expect(keyToInput("r", promo)).toEqual({ type: "promote", role: "rook" });
    });
});

describe("reduceCursor", () => {
    it("refuses empty squares and the opponent's pieces", () => {
        const ctx = contextFor();
        expect(reduceCursor(at("e4"), { type: "select" }, ctx).effects).toEqual([
            { type: "say", message: "noPiece", square: "e4" },
        ]);
        const black = reduceCursor(at("e7"), { type: "select" }, ctx);
        expect(black.effects[0]).toMatchObject({ message: "noPiece", square: "e7" });
        expect(black.state.phase.kind).toBe("idle");
    });

    it("picks up an own piece and lists its legal squares", () => {
        const { state, effects } = reduceCursor(at("e2"), { type: "select" }, contextFor());
        expect(state.phase).toEqual({ kind: "picked", from: "e2", dests: ["e3", "e4"] });
        expect(effects).toEqual([
            {
                type: "say",
                message: "pickedUp",
                square: "e2",
                piece: "pawn",
                color: "white",
                dests: ["e3", "e4"],
            },
        ]);
    });

    it("plays a legal drop through a move effect and refuses an illegal one", () => {
        const ctx = contextFor();
        const illegal = run(
            at("e2"),
            [
                { type: "select" },
                { type: "move", dir: "up" },
                { type: "move", dir: "up" },
                { type: "move", dir: "up" },
                { type: "select" },
            ],
            ctx,
        );
        expect(illegal.effects).toEqual([{ type: "say", message: "illegal", square: "e5" }]);
        expect(illegal.state.phase.kind).toBe("picked");

        const legal = run(
            at("e2"),
            [
                { type: "select" },
                { type: "move", dir: "up" },
                { type: "move", dir: "up" },
                { type: "select" },
            ],
            ctx,
        );
        expect(legal.effects).toHaveLength(1);
        expect(legal.effects[0].type).toBe("move");
        expect(uci((legal.effects[0] as { move: NormalMove }).move)).toBe("e2e4");
        expect(legal.state).toEqual({ square: "e4", phase: { kind: "idle" } });
    });

    it("puts a piece back on Enter over its own square or on Escape; Escape when idle leaves", () => {
        const ctx = contextFor();
        const back = run(at("g1"), [{ type: "select" }, { type: "select" }], ctx);
        expect(back.effects).toEqual([{ type: "say", message: "cancelled" }]);
        expect(back.state.phase.kind).toBe("idle");

        const esc = run(at("g1"), [{ type: "select" }, { type: "cancel" }], ctx);
        expect(esc.effects).toEqual([{ type: "say", message: "cancelled" }]);
        expect(esc.state.phase.kind).toBe("idle");

        expect(reduceCursor(at("g1"), { type: "cancel" }, ctx).effects).toEqual([{ type: "exit" }]);
    });

    it("switches to another own piece instead of refusing it", () => {
        const { state, effects } = run(
            at("e2"),
            [{ type: "select" }, { type: "move", dir: "left" }, { type: "select" }],
            contextFor(),
        );
        expect(state.phase).toMatchObject({ kind: "picked", from: "d2" });
        expect(effects[0]).toMatchObject({ message: "pickedUp", square: "d2" });
    });

    it("says the board is locked when no moves are allowed", () => {
        const locked = contextFor(undefined, { dests: null, movable: undefined });
        expect(reduceCursor(at("e2"), { type: "select" }, locked).effects).toEqual([
            { type: "say", message: "locked" },
        ]);
        const notMyTurn = contextFor(undefined, { movable: "black" });
        expect(reduceCursor(at("e2"), { type: "select" }, notMyTurn).effects[0]).toMatchObject({
            message: "noPiece",
        });
    });

    it("asks for the promotion piece, or queens at once with auto-promotion", () => {
        const fen = "8/4P3/8/8/8/8/8/k6K w - - 0 1";
        const ctx = contextFor(fen);
        expect(needsPromotion(ctx.pos, "e7", "e8")).toBe(true);
        expect(needsPromotion(ctx.pos, "h1", "h2")).toBe(false);
        expect(parseSquare("e8")).toBe(60);

        const asked = run(
            at("e7"),
            [{ type: "select" }, { type: "move", dir: "up" }, { type: "select" }],
            ctx,
        );
        expect(asked.state.phase).toEqual({ kind: "promotion", from: "e7", to: "e8" });
        expect(asked.effects).toEqual([{ type: "say", message: "promotion" }]);

        const knight = reduceCursor(asked.state, { type: "promote", role: "knight" }, ctx);
        expect(uci((knight.effects[0] as { move: NormalMove }).move)).toBe("e7e8n");
        expect(knight.state.phase.kind).toBe("idle");

        const enter = reduceCursor(asked.state, { type: "select" }, ctx);
        expect(uci((enter.effects[0] as { move: NormalMove }).move)).toBe("e7e8q");

        const auto = run(
            at("e7"),
            [{ type: "select" }, { type: "move", dir: "up" }, { type: "select" }],
            contextFor(fen, { autoPromote: true }),
        );
        expect(uci((auto.effects[0] as { move: NormalMove }).move)).toBe("e7e8q");
        expect(auto.state.phase.kind).toBe("idle");

        // A promotion letter outside the promotion phase does nothing.
        expect(reduceCursor(at("e7"), { type: "promote", role: "queen" }, ctx).effects).toEqual([]);
    });

    it("announces the square under the cursor after every arrow key", () => {
        const { effects, state } = reduceCursor(
            at("e1"),
            { type: "move", dir: "up" },
            contextFor(),
        );
        expect(state.square).toBe("e2");
        expect(effects).toEqual([{ type: "say", message: "cursor", square: "e2" }]);
    });
});
