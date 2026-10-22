/**
 * `summarizeGame`: two or three template sentences about one player's game,
 * computed from S2-3's per-ply evaluations (no engine needed here).
 */
import i18n from "i18next";
import type { Chess } from "chessops";
import { getGamePhases } from "@/utils/phase";
import { positionFrom } from "./board";
import { winChance } from "./detectors";
import type { SummaryOptions, SummaryPly, Translate } from "./types";

export type Phase = "opening" | "middlegame" | "endgame";
const PHASES: Phase[] = ["opening", "middlegame", "endgame"];

export type PlyDrop = {
    index: number;
    ply: number;
    phase: Phase;
    /** expected-score drop of the mover, 0..1 */
    drop: number;
    /** mover's expected score before the move, 0..1 */
    winBefore: number;
    /** mover's expected score after the move, 0..1 */
    winAfter: number;
    clock?: number;
};

/** Thresholds on the expected-score drop, matching `getAnnotation` (20 / 10 / 5 points). */
export const BLUNDER_DROP = 0.2;
export const MISTAKE_DROP = 0.1;

const moverOf = (ply: SummaryPly, index: number): "white" | "black" => {
    const turn = ply.fenBefore?.split(" ")[1];
    if (turn === "w") return "white";
    if (turn === "b") return "black";
    return index % 2 === 0 ? "white" : "black";
};

/** Phase of every ply: Lichess' divider when all positions parse, otherwise ply thresholds. */
export function phasesOf(plies: SummaryPly[]): Phase[] {
    const boards: Chess[] = [];
    for (const ply of plies) {
        const pos = ply.fenBefore ? positionFrom(ply.fenBefore) : null;
        if (!pos) break;
        boards.push(pos);
    }
    if (boards.length === plies.length && plies.length > 0) {
        const { middlegamePly, endgamePly } = getGamePhases(boards);
        return plies.map((_, i) =>
            endgamePly !== null && i >= endgamePly
                ? "endgame"
                : middlegamePly !== null && i >= middlegamePly
                  ? "middlegame"
                  : "opening",
        );
    }
    return plies.map((_, i) => (i < 20 ? "opening" : i < 60 ? "middlegame" : "endgame"));
}

/** Per-ply drops for `color`'s moves. */
export function playerDrops(plies: SummaryPly[], color: "white" | "black"): PlyDrop[] {
    const phases = phasesOf(plies);
    const out: PlyDrop[] = [];
    for (let i = 0; i < plies.length; i++) {
        const ply = plies[i];
        if (moverOf(ply, i) !== color) continue;
        const sign = color === "white" ? 1 : -1;
        const prev = i > 0 ? plies[i - 1].score : 0;
        const reference = ply.bestScore ?? prev;
        const winBefore = winChance(sign * reference) / 100;
        const winAfter = winChance(sign * ply.score) / 100;
        let drop = Math.max(0, winBefore - winAfter);
        if (typeof ply.winChanceDrop === "number" && Number.isFinite(ply.winChanceDrop)) {
            drop = ply.winChanceDrop > 1 ? ply.winChanceDrop / 100 : ply.winChanceDrop;
        }
        out.push({
            index: i,
            ply: ply.ply,
            phase: phases[i],
            drop,
            winBefore,
            winAfter,
            clock: ply.clock,
        });
    }
    return out;
}

export type SummarySentence = { key: string; params: Record<string, string | number> };

/** The sentences as keys + params, so callers with their own translator can render them. */
export function summarizeGameKeys(
    plies: SummaryPly[],
    color: "white" | "black",
): SummarySentence[] {
    const drops = playerDrops(plies, color);
    if (drops.length === 0) return [];
    const out: SummarySentence[] = [];

    const lossByPhase: Record<Phase, number> = { opening: 0, middlegame: 0, endgame: 0 };
    const movesByPhase: Record<Phase, number> = { opening: 0, middlegame: 0, endgame: 0 };
    for (const d of drops) {
        lossByPhase[d.phase] += d.drop;
        movesByPhase[d.phase]++;
    }
    const played = PHASES.filter((p) => movesByPhase[p] > 0);
    const worst = played.reduce((a, b) => (lossByPhase[b] > lossByPhase[a] ? b : a));
    if (lossByPhase[worst] >= 0.05) {
        out.push({
            key: "Explain.Summary.WorstPhase",
            params: { phase: worst, loss: lossByPhase[worst].toFixed(1) },
        });
    } else {
        out.push({ key: "Explain.Summary.NoLoss", params: {} });
    }

    const blunders = drops.filter((d) => d.drop >= BLUNDER_DROP).length;
    const mistakes = drops.filter((d) => d.drop >= MISTAKE_DROP && d.drop < BLUNDER_DROP).length;
    if (blunders + mistakes > 0) {
        out.push({ key: "Explain.Summary.Mistakes", params: { blunders, mistakes } });
    } else if (lossByPhase[worst] >= 0.05) {
        out.push({ key: "Explain.Summary.Clean", params: {} });
    }

    const thrown = drops.filter((d) => d.winBefore >= 0.7 && d.winAfter < 0.5).length;
    const underClock = drops.filter(
        (d) => d.drop >= MISTAKE_DROP && d.clock !== undefined && d.clock <= 60,
    ).length;
    if (thrown > 0) {
        out.push({ key: "Explain.Summary.ThrewWins", params: { n: thrown } });
    } else if (underClock > 0) {
        out.push({ key: "Explain.Summary.TimePressure", params: { n: underClock } });
    } else if (played.length >= 2) {
        const bestPhase = played.reduce((a, b) => (lossByPhase[b] < lossByPhase[a] ? b : a));
        if (bestPhase !== worst)
            out.push({ key: "Explain.Summary.BestPhase", params: { phase: bestPhase } });
    }
    return out.slice(0, 3);
}

export function summarizeGame(
    plies: SummaryPly[],
    options?: SummaryOptions | "white" | "black" | null,
): string[] {
    const opts: SummaryOptions =
        typeof options === "string" ? { playerColor: options } : (options ?? {});
    const color = opts.playerColor ?? "white";
    const t = (opts.t ?? i18n.t.bind(i18n)) as Translate;
    return summarizeGameKeys(plies, color).map(({ key, params }) => {
        const vars: Record<string, unknown> = { ...params, interpolation: { escapeValue: false } };
        if (typeof params.phase === "string") vars.phase = t(`Explain.Phase.${params.phase}`);
        return String(t(key, vars));
    });
}
