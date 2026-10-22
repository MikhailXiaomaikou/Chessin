import { describe, expect, it } from "vitest";
import { finalize } from "./detectors";
import { explainMoment } from "./index";
import type { Explanation, ExplainInput } from "./types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type Partial = Omit<
    ExplainInput,
    "bestPv" | "scoreBefore" | "scoreAfterPlayed" | "scoreAfterBest" | "playerColor"
> &
    Partial2;
type Partial2 = {
    bestPv?: string[];
    scoreBefore?: number;
    scoreAfterPlayed?: number;
    scoreAfterBest?: number;
    playerColor?: "white" | "black" | null;
};

const explain = (input: Partial) =>
    explainMoment({
        bestPv: [],
        scoreBefore: 0,
        scoreAfterPlayed: -200,
        scoreAfterBest: 0,
        playerColor: "white",
        ...input,
    });

const byId = (list: Explanation[], id: string, variant?: string) =>
    list.find(
        (e) =>
            e.id === id &&
            (variant === undefined ? e.params.variant === undefined : e.params.variant === variant),
    );

describe("hanging_piece", () => {
    it("reports a piece moved to an unprotected square", () => {
        const out = explain({
            fenBefore: "rnbqkb1r/ppp2ppp/3p1n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 3",
            playedUci: "f3e5",
            bestUci: "e2e4",
        });
        const e = byId(out, "hanging_piece");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("likely");
        expect(e?.severity).toBe(2);
        expect(e?.params).toMatchObject({
            piece: "knight",
            square: "e5",
            played: "Ne5",
            best: "e4",
        });
        expect(e?.demo?.line).toEqual(["d6e5"]);
        expect(e?.demo?.arrows?.[0]).toEqual({ orig: "d6", dest: "e5", brush: "red" });
    });

    it("reports a piece left en prise elsewhere (variant left)", () => {
        const out = explain({
            fenBefore: "rnbqkb1r/ppp1pppp/3p1n2/4N3/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 4",
            playedUci: "a2a3",
            bestUci: "e5f3",
        });
        const e = byId(out, "hanging_piece", "left");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ piece: "knight", square: "e5", played: "a3" });
    });

    it("reports an under-defended piece (variant weak)", () => {
        const out = explain({
            fenBefore: "rnbqkb1r/ppp1pppp/3p1n2/4N3/3P4/8/PPP1PPPP/RNBQKB1R w KQkq - 0 4",
            playedUci: "a2a3",
            bestUci: "e5f3",
        });
        const e = byId(out, "hanging_piece", "weak");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ piece: "knight", square: "e5", value: 2 });
    });

    it("does not blame the played move when the same piece hangs after the best move too", () => {
        // the knight on e5 hangs either way; best (Kd1) does not save it, so it is not the explanation
        const out = explain({
            fenBefore: "rnbqkb1r/ppp1pppp/3p1n2/4N3/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 4",
            playedUci: "a2a3",
            bestUci: "h2h3",
        });
        expect(byId(out, "hanging_piece", "left")).toBeUndefined();
    });
});

describe("missed_hanging_piece", () => {
    it("reports an unprotected queen the best move takes", () => {
        const out = explain({
            fenBefore: "4k3/pppp1ppp/8/3q4/8/2N5/PPPP1PPP/4K3 w - - 0 1",
            playedUci: "a2a3",
            bestUci: "c3d5",
        });
        const e = byId(out, "missed_hanging_piece");
        expect(e).toBeDefined();
        expect(e?.severity).toBe(3);
        expect(e?.params).toMatchObject({ piece: "queen", square: "d5", best: "Nxd5", value: 9 });
        expect(e?.demo?.line).toEqual(["c3d5"]);
    });

    it("marks a defended but winnable piece as weak", () => {
        // the queen on d5 is defended by the pawn on e6, still Nxd5 wins 9 for 3
        const out = explain({
            fenBefore: "4k3/pppp1ppp/4p3/3q4/8/2N5/PPPP1PPP/4K3 w - - 0 1",
            playedUci: "a2a3",
            bestUci: "c3d5",
        });
        const e = byId(out, "missed_hanging_piece", "weak");
        expect(e).toBeDefined();
        expect(e?.params.value).toBe(6);
    });
});

describe("fork", () => {
    it("reports an allowed royal knight fork with its targets", () => {
        const out = explain({
            fenBefore: "4k3/p6p/8/4n3/8/8/P2Q3P/6K1 w - - 0 1",
            playedUci: "h2h3",
            bestUci: "d2e2",
        });
        const e = byId(out, "fork", "allowed");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("likely");
        expect(e?.severity).toBe(3);
        expect(e?.params).toMatchObject({ reply: "Nf3+", piece: "knight", square: "f3" });
        expect(String(e?.params.targets).split(";").sort()).toEqual(["king@g1", "queen@d2"]);
        expect(e?.demo?.arrows?.map((a) => a.dest).sort()).toEqual(["d2", "g1"]);
    });

    it("reports a missed fork", () => {
        const out = explain({
            fenBefore: "r3k3/8/8/1N6/8/8/8/6K1 w - - 0 1",
            playedUci: "g1h1",
            bestUci: "b5c7",
        });
        const e = byId(out, "fork", "missed");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ best: "Nc7+", piece: "knight" });
        expect(String(e?.params.targets).split(";").sort()).toEqual(["king@e8", "rook@a8"]);
    });
});

describe("pin and skewer", () => {
    it("reports a missed pin of the queen", () => {
        const out = explain({
            fenBefore: "3k4/8/3q4/8/8/8/8/R3K3 w - - 0 1",
            playedUci: "a1b1",
            bestUci: "a1d1",
        });
        const e = byId(out, "pin", "missed");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("certain");
        expect(e?.severity).toBe(3);
        expect(e?.params).toMatchObject({
            pinned: "queen",
            pinner: "rook",
            square: "d6",
            best: "Rd1",
        });
    });

    it("reports a pin the played move allows", () => {
        const out = explain({
            fenBefore: "r3k3/8/8/8/8/3Q4/P7/3K4 w - - 0 1",
            playedUci: "a2a3",
            bestUci: "d3c3",
        });
        const e = byId(out, "pin", "allowed");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ reply: "Rd8", pinned: "queen", square: "d3" });
        expect(e?.demo?.line).toEqual(["a8d8"]);
    });

    it("reports a missed skewer", () => {
        const out = explain({
            fenBefore: "8/8/8/8/3k2q1/8/8/R6K w - - 0 1",
            playedUci: "a1b1",
            bestUci: "a1a4",
        });
        const e = byId(out, "skewer", "missed");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ best: "Ra4+", target: "queen", square: "g4" });
    });

    it("reports an allowed skewer and drops the duplicate fork", () => {
        const out = explain({
            fenBefore: "r6k/8/8/8/6Q1/3K4/8/8 w - - 0 1",
            playedUci: "d3d4",
            bestUci: "d3e3",
        });
        const e = byId(out, "skewer", "allowed");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ reply: "Ra4+", target: "queen", square: "g4" });
        expect(byId(out, "fork", "allowed")).toBeUndefined();
    });
});

describe("mates", () => {
    it("reports a back-rank mate in one instead of a generic allowed mate", () => {
        // the queen on d2 was the only guard of d1; Qb2 abandons it and cannot interpose on e1/f1
        const out = explain({
            fenBefore: "3r2k1/5ppp/8/8/8/8/3Q1PPP/6K1 w - - 0 1",
            playedUci: "d2b2",
            bestUci: "h2h3",
        });
        const e = byId(out, "back_rank");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("certain");
        expect(e?.severity).toBe(3);
        expect(e?.params).toMatchObject({ reply: "Rd1#", n: 1 });
        expect(e?.demo?.line).toEqual(["d8d1"]);
        expect(out.some((x) => x.id === "allowed_mate")).toBe(false);
    });

    it("reports a back-rank mate in two", () => {
        const out = explain({
            fenBefore: "3r2k1/3r1ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
            playedUci: "e1e2",
            bestUci: "h2h3",
        });
        const e = byId(out, "back_rank", "in2");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ reply: "Rd1+", n: 2 });
        expect(e?.demo?.line).toEqual(["d7d1", "e2e1", "d1e1"]);
    });

    it("reports an allowed mate that is not on the back rank", () => {
        const out = explain({
            fenBefore: "4k3/8/8/8/8/5n1q/P5PP/7K w - - 0 1",
            playedUci: "a2a3",
            bestUci: "g2h3",
        });
        const e = byId(out, "allowed_mate");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("certain");
        expect(String(e?.params.reply)).toMatch(/^Qx[gh]2#$/); // both captures mate
        expect(out.some((x) => x.id === "back_rank")).toBe(false);
    });

    it("falls back to the engine score for deeper mates (likely)", () => {
        const out = explain({
            fenBefore: START,
            playedUci: "e2e4",
            bestUci: "d2d4",
            scoreAfterPlayed: -10000,
            scoreAfterBest: 20,
        });
        const e = byId(out, "allowed_mate", "likely");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("likely");
    });

    it("reports a missed mate in one from the PV", () => {
        const out = explain({
            fenBefore: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
            playedUci: "h2h3",
            bestUci: "e1e8",
            bestPv: ["e1e8"],
            scoreAfterBest: 10000,
            scoreAfterPlayed: 300,
        });
        const e = byId(out, "missed_mate");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("certain");
        expect(e?.params).toMatchObject({ n: 1, best: "Re8#" });
        expect(e?.demo?.line).toEqual(["e1e8"]);
    });

    it("replays a mate in two itself when the PV is short", () => {
        const out = explain({
            fenBefore: "6k1/4rppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1",
            playedUci: "h2h3",
            bestUci: "d2d8",
            bestPv: ["d2d8"],
            scoreAfterBest: 10000,
            scoreAfterPlayed: 300,
        });
        const e = byId(out, "missed_mate");
        expect(e).toBeDefined();
        expect(e?.params.n).toBe(2);
        expect(e?.demo?.line).toEqual(["d2d8", "e7e8", "d8e8"]);
    });

    it("uses the engine mate score when nothing can be replayed (likely)", () => {
        const out = explain({
            fenBefore: START,
            playedUci: "e2e4",
            bestUci: "d2d4",
            scoreAfterBest: 10000,
            scoreAfterPlayed: 20,
        });
        expect(byId(out, "missed_mate", "likely")?.evidence).toBe("likely");
    });

    it("drops heuristic explanations when a mate decides the moment", () => {
        const out = explain({
            fenBefore: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
            playedUci: "h2h3",
            bestUci: "e1e8",
            bestPv: ["e1e8"],
            scoreAfterBest: 10000,
            scoreAfterPlayed: 300,
        });
        expect(out.every((e) => e.evidence !== "heuristic")).toBe(true);
    });
});

describe("material and structure", () => {
    it("reports trading pieces while behind", () => {
        const out = explain({
            fenBefore: "r5k1/8/4p3/3n4/8/2N5/8/6K1 w - - 0 1",
            playedUci: "c3d5",
            bestUci: "c3e4",
        });
        const e = byId(out, "trade_when_behind");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("heuristic");
        expect(e?.params).toMatchObject({ piece: "knight", diff: 6, played: "Nxd5" });
        expect(byId(out, "hanging_piece")).toBeUndefined();
    });

    it("reports avoiding a trade while ahead", () => {
        const out = explain({
            fenBefore: "6k1/8/4p3/3n4/8/2N5/8/R5K1 w - - 0 1",
            playedUci: "c3b1",
            bestUci: "c3d5",
        });
        const e = byId(out, "avoid_trade_when_ahead");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ piece: "knight", diff: 4, best: "Nxd5" });
    });

    it("reports a pawn pushed out of the king's shelter", () => {
        const out = explain({
            fenBefore: "r1bq1rk1/pppp1ppp/2n5/8/8/8/PPPPPPPP/RNBQ1RK1 w - - 0 1",
            playedUci: "g2g4",
            bestUci: "a2a3",
        });
        const e = byId(out, "king_exposure", "shield");
        expect(e).toBeDefined();
        expect(e?.evidence).toBe("heuristic");
        expect(e?.params).toMatchObject({ square: "g2", played: "g4" });
    });

    it("reports a king walk while the enemy queen is on the board", () => {
        const out = explain({
            fenBefore: "3q2k1/8/5n2/2b5/8/8/4K3/3Q3R w - - 0 1",
            playedUci: "e2f3",
            bestUci: "d1d2",
        });
        const e = byId(out, "king_exposure", "walk");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ square: "f3", played: "Kf3" });
    });

    it("reports a missed passed pawn", () => {
        const out = explain({
            fenBefore: "6k1/8/p7/1P6/8/8/8/6K1 w - - 0 1",
            playedUci: "g1h1",
            bestUci: "b5a6",
        });
        const e = byId(out, "passed_pawn", "missed");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ square: "a6", best: "bxa6" });
    });

    it("reports an ignored advanced passed pawn", () => {
        const out = explain({
            fenBefore: "6k1/8/8/8/8/p7/6K1/7R w - - 0 1",
            playedUci: "g2f2",
            bestUci: "h1a1",
        });
        const e = byId(out, "passed_pawn", "ignored");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ square: "a3", best: "Ra1" });
    });
});

describe("development", () => {
    it("reports a missed developing move in the opening", () => {
        const out = explain({ fenBefore: START, playedUci: "a2a3", bestUci: "g1f3" });
        const e = byId(out, "piece_activity", "develop");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ best: "Nf3", played: "a3" });
        expect(e?.demo?.line).toEqual(["g1f3"]);
    });

    it("reports missed castling", () => {
        const out = explain({
            fenBefore: "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQK2R w KQkq - 0 1",
            playedUci: "a2a3",
            bestUci: "e1g1",
        });
        expect(byId(out, "piece_activity", "castle")?.params.best).toBe("O-O");
    });

    it("reports a rim knight that should be centralised", () => {
        const out = explain({
            fenBefore: "6k1/8/8/8/8/N7/7P/6K1 w - - 0 1",
            playedUci: "h2h3",
            bestUci: "a3c4",
        });
        const e = byId(out, "piece_activity", "centralize");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ piece: "knight", square: "c4", best: "Nc4" });
    });

    it("reports a tempo loss and suppresses the generic activity hint", () => {
        const out = explain({
            fenBefore: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 2",
            playedUci: "f3g5",
            bestUci: "b1c3",
        });
        const e = byId(out, "tempo_loss");
        expect(e).toBeDefined();
        expect(e?.params).toMatchObject({ piece: "knight", square: "f3", played: "Ng5" });
        expect(out.some((x) => x.id === "piece_activity")).toBe(false);
    });

    it("does not call a forced retreat a tempo loss", () => {
        // the knight on e5 is attacked; moving it is not a wasted tempo
        const out = explain({
            fenBefore: "rnbqkb1r/ppp1pppp/3p1n2/4N3/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 4",
            playedUci: "e5f3",
            bestUci: "b1c3",
        });
        expect(byId(out, "tempo_loss")).toBeUndefined();
    });
});

describe("time_pressure", () => {
    it("is certain and severe with seconds on the clock", () => {
        const out = explain({
            fenBefore: START,
            playedUci: "e2e4",
            bestUci: "d2d4",
            clockBefore: 15,
        });
        const e = byId(out, "time_pressure");
        expect(e).toMatchObject({ evidence: "certain", severity: 3, params: { seconds: 15 } });
        const later = explain({
            fenBefore: START,
            playedUci: "e2e4",
            bestUci: "d2d4",
            clockBefore: 45,
        });
        expect(byId(later, "time_pressure")?.severity).toBe(2);
    });

    it("flags a snap move at a critical moment", () => {
        const out = explain({
            fenBefore: START,
            playedUci: "e2e4",
            bestUci: "d2d4",
            clockBefore: 300,
            clockAfter: 299,
            scoreAfterBest: 0,
            scoreAfterPlayed: -300,
        });
        const e = byId(out, "time_pressure", "rushed");
        expect(e).toBeDefined();
        expect(e?.params.used).toBe(1);
        expect(e?.evidence).toBe("likely");
    });

    it("stays silent without clock data or with plenty of time", () => {
        expect(
            byId(
                explain({ fenBefore: START, playedUci: "e2e4", bestUci: "d2d4" }),
                "time_pressure",
            ),
        ).toBeUndefined();
        expect(
            byId(
                explain({ fenBefore: START, playedUci: "e2e4", bestUci: "d2d4", clockBefore: 600 }),
                "time_pressure",
            ),
        ).toBeUndefined();
    });
});

describe("explainMoment plumbing", () => {
    it("returns nothing when the played move is the best move or the input is invalid", () => {
        expect(explain({ fenBefore: START, playedUci: "e2e4", bestUci: "e2e4" })).toEqual([]);
        expect(explain({ fenBefore: "not a fen", playedUci: "e2e4", bestUci: "d2d4" })).toEqual([]);
        expect(explain({ fenBefore: START, playedUci: "e2e5", bestUci: "d2d4" })).toEqual([]);
    });

    it("accepts scores from White's view and flips them for Black", () => {
        const out = explainMoment({
            fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            playedUci: "e7e5",
            bestUci: "c7c5",
            bestPv: [],
            scoreBefore: 30,
            scoreAfterPlayed: 10000,
            scoreAfterBest: 30,
            playerColor: "black",
            scoreView: "white",
        });
        expect(byId(out, "allowed_mate", "likely")).toBeDefined();
    });

    it("always carries the played and best SAN in params", () => {
        const out = explain({ fenBefore: START, playedUci: "a2a3", bestUci: "g1f3" });
        expect(out.length).toBeGreaterThan(0);
        for (const e of out) expect(e.params).toMatchObject({ played: "a3", best: "Nf3" });
    });
});

describe("finalize", () => {
    const mk = (
        id: string,
        evidence: Explanation["evidence"],
        severity: Explanation["severity"],
        params = {},
    ) => ({ id, evidence, severity, params }) as Explanation;

    it("sorts by severity then evidence and caps the list", () => {
        const out = finalize([
            mk("passed_pawn", "heuristic", 1),
            mk("hanging_piece", "likely", 2),
            mk("pin", "certain", 2),
            mk("time_pressure", "certain", 3),
            mk("king_exposure", "heuristic", 2),
            mk("tempo_loss", "heuristic", 1),
        ]);
        expect(out.map((e) => e.id)).toEqual([
            "time_pressure",
            "pin",
            "hanging_piece",
            "king_exposure",
        ]);
    });

    it("lets tempo_loss replace piece_activity", () => {
        const out = finalize([
            mk("piece_activity", "heuristic", 1),
            mk("tempo_loss", "heuristic", 1),
        ]);
        expect(out.map((e) => e.id)).toEqual(["tempo_loss"]);
    });
});
