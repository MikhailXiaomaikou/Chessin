import { describe, expect, it } from "vitest";
import { phasesOf, playerDrops, summarizeGame, summarizeGameKeys } from "./summary";
import type { SummaryPly, Translate } from "./types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A game of `n` plies with flat scores, except the overrides (ply index → score after the move, White's view). */
function game(
    n: number,
    overrides: Record<number, number> = {},
    clocks: Record<number, number> = {},
): SummaryPly[] {
    const plies: SummaryPly[] = [];
    let score = 0;
    for (let i = 0; i < n; i++) {
        if (i in overrides) score = overrides[i];
        plies.push({ ply: i + 1, score, ...(i in clocks ? { clock: clocks[i] } : {}) });
    }
    return plies;
}

const t: Translate = (key, options) => {
    const params = Object.entries(options ?? {})
        .filter(([k]) => k !== "interpolation")
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
    return params ? `${key}(${params})` : key;
};

describe("playerDrops", () => {
    it("attributes drops to the mover and measures them as expected-score loss", () => {
        // White blunders at ply index 2 (0 → -300), Black returns the favour at index 5 (-300 → +300)
        const drops = playerDrops(game(8, { 2: -300, 5: 300 }), "white");
        expect(drops.map((d) => d.index)).toEqual([0, 2, 4, 6]);
        const blunder = drops.find((d) => d.index === 2);
        expect(blunder?.drop).toBeGreaterThan(0.2);
        expect(drops.find((d) => d.index === 0)?.drop).toBe(0);
        expect(drops.find((d) => d.index === 4)?.drop).toBe(0); // Black's blunder is not White's loss
        const black = playerDrops(game(8, { 2: -300, 5: 300 }), "black");
        expect(black.find((d) => d.index === 5)?.drop).toBeGreaterThan(0.2);
        expect(black.find((d) => d.index === 3)?.drop).toBe(0);
    });

    it("reads the mover from fenBefore when present and prefers a precomputed drop", () => {
        const plies: SummaryPly[] = [
            { ply: 1, fenBefore: START, score: 0 },
            {
                ply: 2,
                fenBefore: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                score: 0,
                winChanceDrop: 0.3,
            },
            { ply: 3, fenBefore: START, score: 0, winChanceDrop: 25 },
        ];
        const white = playerDrops(plies, "white");
        expect(white.map((d) => d.index)).toEqual([0, 2]);
        expect(white[1].drop).toBe(0.25); // percent input is normalised
        expect(playerDrops(plies, "black")[0].drop).toBe(0.3);
    });

    it("uses bestScore as the reference when the review provides it", () => {
        const plies: SummaryPly[] = [{ ply: 1, score: -200, bestScore: 100 }];
        const [d] = playerDrops(plies, "white");
        expect(d.winBefore).toBeGreaterThan(0.5);
        expect(d.drop).toBeGreaterThan(0.1);
    });
});

describe("phasesOf", () => {
    it("falls back to ply thresholds without positions", () => {
        const phases = phasesOf(game(70));
        expect(phases[0]).toBe("opening");
        expect(phases[19]).toBe("opening");
        expect(phases[20]).toBe("middlegame");
        expect(phases[60]).toBe("endgame");
    });

    it("uses the Lichess divider when every position parses", () => {
        const plies: SummaryPly[] = [
            { ply: 1, fenBefore: START, score: 0 },
            { ply: 2, fenBefore: "4k3/8/8/8/8/8/8/4K2R b K - 0 1", score: 0 },
        ];
        expect(phasesOf(plies)).toEqual(["opening", "endgame"]);
    });
});

describe("summarizeGameKeys", () => {
    it("names the worst phase, counts mistakes and thrown-away wins", () => {
        // White: +300 from the opening, then a blunder in the middlegame (index 30) that throws the win
        const plies = game(50, { 4: 300, 30: -200, 31: -200 });
        const keys = summarizeGameKeys(plies, "white");
        expect(keys[0].key).toBe("Explain.Summary.WorstPhase");
        expect(keys[0].params.phase).toBe("middlegame");
        expect(keys[0].params.loss).toBe("0.4");
        expect(keys[1]).toEqual({
            key: "Explain.Summary.Mistakes",
            params: { blunders: 1, mistakes: 0 },
        });
        expect(keys[2]).toEqual({ key: "Explain.Summary.ThrewWins", params: { n: 1 } });
    });

    it("mentions time pressure when the mistakes came with a low clock", () => {
        const plies = game(30, { 22: -150, 23: -150 }, { 22: 30 });
        const keys = summarizeGameKeys(plies, "white");
        expect(keys.map((k) => k.key)).toEqual([
            "Explain.Summary.WorstPhase",
            "Explain.Summary.Mistakes",
            "Explain.Summary.TimePressure",
        ]);
        expect(keys[1].params).toEqual({ blunders: 0, mistakes: 1 });
        expect(keys[2].params).toEqual({ n: 1 });
    });

    it("praises a clean game", () => {
        expect(summarizeGameKeys(game(40), "white")).toEqual([
            { key: "Explain.Summary.NoLoss", params: {} },
        ]);
        const slightly = game(70, { 30: -60, 31: -60 });
        const keys = summarizeGameKeys(slightly, "white");
        expect(keys[0].key).toBe("Explain.Summary.WorstPhase");
        expect(keys[1].key).toBe("Explain.Summary.Clean");
        expect(keys[2]).toEqual({ key: "Explain.Summary.BestPhase", params: { phase: "opening" } });
    });

    it("summarises Black's moves when asked", () => {
        const plies = game(50, { 31: 400, 32: 400 });
        expect(summarizeGameKeys(plies, "white")).toEqual([
            { key: "Explain.Summary.NoLoss", params: {} },
        ]);
        const black = summarizeGameKeys(plies, "black");
        expect(black[0].params.phase).toBe("middlegame");
        expect(black[1].params).toEqual({ blunders: 1, mistakes: 0 });
    });

    it("returns nothing for an empty game", () => {
        expect(summarizeGameKeys([], "white")).toEqual([]);
        expect(summarizeGame([], { playerColor: "black", t })).toEqual([]);
    });
});

describe("summarizeGame", () => {
    it("renders through the given translator, localising the phase", () => {
        const plies = game(50, { 4: 300, 30: -200, 31: -200 });
        const lines = summarizeGame(plies, { playerColor: "white", t });
        expect(lines).toEqual([
            "Explain.Summary.WorstPhase(phase=Explain.Phase.middlegame,loss=0.4)",
            "Explain.Summary.Mistakes(blunders=1,mistakes=0)",
            "Explain.Summary.ThrewWins(n=1)",
        ]);
        expect(summarizeGame(plies, "white").length).toBe(3); // colour shorthand, global i18n fallback
    });
});
