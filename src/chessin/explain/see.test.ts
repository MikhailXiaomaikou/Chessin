import { parseSquare } from "chessops";
import { describe, expect, it } from "vitest";
import {
    absolutePins,
    findForks,
    forcedMate,
    isBackRankMate,
    matingMoves,
    passedPawns,
    positionFrom,
    see,
    skewerBy,
    winningCaptures,
} from "./board";

const pos = (fen: string) => {
    const p = positionFrom(fen);
    if (!p) throw new Error(`bad fen ${fen}`);
    return p;
};
const sq = (name: string) => {
    const s = parseSquare(name);
    if (s === undefined) throw new Error(`bad square ${name}`);
    return s;
};

describe("SEE-lite", () => {
    it("wins an undefended pawn", () => {
        const p = pos("4k3/8/8/3p4/8/2N5/8/4K3 w - - 0 1");
        expect(see(p, sq("d5"))).toBe(1);
    });

    it("loses the knight when the pawn is defended by a pawn", () => {
        const p = pos("4k3/8/4p3/3p4/8/2N5/8/4K3 w - - 0 1");
        expect(see(p, sq("d5"))).toBe(-2);
    });

    it("sees the queen behind the rook (x-ray) but does not force the recapture", () => {
        // Rxd5 exd5 Qxd5: rook for knight and pawn = -1
        const p = pos("6k1/8/4p3/3n4/8/8/3R4/3Q2K1 w - - 0 1");
        expect(see(p, sq("d5"), sq("d2"))).toBe(-1);
    });

    it("does not let the king capture a defended piece", () => {
        const p = pos("4k3/8/8/4b3/8/8/7n/6K1 w - - 0 1");
        expect(see(p, sq("h2"))).toBe(0);
        expect(winningCaptures(p)).toEqual([]);
    });

    it("lets the king take an undefended piece", () => {
        const p = pos("4k3/8/8/8/8/8/7n/6K1 w - - 0 1");
        expect(see(p, sq("h2"))).toBe(3);
        const wins = winningCaptures(p);
        expect(wins).toHaveLength(1);
        expect(wins[0].square).toBe(sq("h2"));
        expect(wins[0].undefended).toBe(true);
    });

    it("ignores captures that are illegal because of a pin", () => {
        // the white knight on d2 is pinned by the rook on d8; it cannot take e4
        const p = pos("3rk3/8/8/8/4p3/8/3N4/3K4 w - - 0 1");
        expect(winningCaptures(p)).toEqual([]);
    });
});

describe("geometry helpers", () => {
    it("finds absolute pins with the pinner", () => {
        const p = pos("3rk3/8/8/8/8/8/3N4/3K4 w - - 0 1");
        const pins = absolutePins(p.board, "white");
        expect(pins).toHaveLength(1);
        expect(pins[0]).toEqual({ pinned: sq("d2"), pinner: sq("d8"), king: sq("d1") });
        expect(absolutePins(p.board, "black")).toEqual([]);
    });

    it("finds a royal knight fork", () => {
        const p = pos("r3k3/8/8/1N6/8/8/8/6K1 w - - 0 1");
        const forks = findForks(p);
        expect(forks.length).toBeGreaterThan(0);
        const royal = forks.find((f) => f.move.to === sq("c7"));
        expect(royal).toBeDefined();
        expect(royal?.targets.map((t) => t.piece.role).sort()).toEqual(["king", "rook"]);
    });

    it("rejects a fork when the forking piece can simply be taken", () => {
        // Nc7+ would fork, but the c7 square is covered by the black bishop on e5
        const p = pos("r3k3/8/8/1N2b3/8/8/8/6K1 w - - 0 1");
        expect(findForks(p).some((f) => f.move.to === sq("c7"))).toBe(false);
    });

    it("recognises a rook skewer through the king", () => {
        const p = pos("8/8/8/8/3k2q1/8/8/R6K w - - 0 1");
        const s = skewerBy(p, { from: sq("a1"), to: sq("a4") });
        expect(s).not.toBeNull();
        expect(s?.target).toBe(sq("g4"));
        expect(s?.piece.role).toBe("queen");
        expect(skewerBy(p, { from: sq("a1"), to: sq("b1") })).toBeNull();
    });

    it("finds mate in one and classifies a back-rank mate", () => {
        const p = pos("6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1");
        const mates = matingMoves(p);
        expect(mates).toHaveLength(1);
        expect(mates[0]).toEqual({ from: sq("e1"), to: sq("e8") });
        expect(isBackRankMate(p, mates[0])).toBe(true);
        expect(forcedMate(p)).toEqual({ moves: [mates[0]], length: 1 });
    });

    it("finds a forced mate in two through a check", () => {
        // Rd8+ Re8 Rxe8#
        const p = pos("6k1/4rppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1");
        const mate = forcedMate(p);
        expect(mate?.length).toBe(2);
        expect(mate?.moves[0]).toEqual({ from: sq("d2"), to: sq("d8") });
        expect(mate?.moves).toHaveLength(3);
    });

    it("detects passed pawns on both sides", () => {
        // e2 is passed; a2 is held by a3/b7, c2 would be stopped by b7, a3 by a2, b7 by a2
        const p = pos("6k1/1p6/8/8/8/p7/P1P1P3/6K1 w - - 0 1");
        expect([...passedPawns(p.board, "white")]).toEqual([sq("e2")]);
        expect([...passedPawns(p.board, "black")]).toEqual([]);
        const q = pos("6k1/8/8/8/8/p7/8/6K1 w - - 0 1");
        expect([...passedPawns(q.board, "black")]).toEqual([sq("a3")]);
    });
});
