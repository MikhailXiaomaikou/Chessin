import { makeUci } from "chessops";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { commands, events, type MoveAnalysis, type NormalizedGame } from "@/bindings";
import { toStandardUci } from "@/chessin/board/uci";
import { getDoc } from "@/chessin/store/libraryStore";
import { enginesAtom } from "@/state/atoms";
import { getMainLine, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { query_games } from "@/utils/db";
import type { LocalEngine } from "@/utils/engines";
import type { GameOrigin } from "@/utils/tabs";
import {
    ensureNodeIds,
    type GameHeaders,
    getGameName,
    type TreeNode,
    type TreeState,
    treeIteratorMainLine,
} from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { buildReview, explainInputFor, type ReviewPosition } from "./analysis";
import { type CachedEval, evalCacheGet, evalCachePut } from "./evalCache";
import {
    fenToEpd,
    gameKeyForOrigin,
    type PlayerColor,
    type Review,
    type ReviewHeaders,
    type ReviewPreset,
} from "./model";
import { reviewTitle, saveReview } from "./store";

export { gameKeyForOrigin } from "./model";
export { deleteReview, getReview, hasReview, listReviews } from "./store";
export { onReviewSaved } from "./events";

/**
 * Reviewing a game (S2-3): main line → engine (`analyzeGame`, eval cache first)
 * → `buildReview` → S2-4 explanations → library document `"review:" + gameKey`.
 *
 * `reviewGame` does the work in the calling context; `enqueueReview` runs it
 * as a background job (`kind: "review"`, handler in `jobHandler.ts`).
 */

export type ReviewSettings = {
    /** Engine id from `enginesAtom`; empty = first enabled local engine. */
    engine: string;
    depth: number;
    blunderCheckDepth: number;
};

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
    engine: "",
    depth: 16,
    blunderCheckDepth: 10,
};

export const reviewSettingsAtom = atomWithStorage<ReviewSettings>(
    "chessin.review.settings",
    DEFAULT_REVIEW_SETTINGS,
);

export type ReviewGameInput = {
    pgn?: string;
    tree?: TreeState;
    gameKey: string;
    playerColor?: PlayerColor | null;
    preset: ReviewPreset;
    engine?: LocalEngine;
    depth?: number;
    title?: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
};

export class ReviewError extends Error {
    constructor(
        public readonly key: string,
        message?: string,
    ) {
        super(message ?? key);
        this.name = "ReviewError";
    }
}

function store() {
    return getDefaultStore();
}

function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

/** The engine a review runs with: `reviewSettingsAtom.engine`, else the first enabled local engine. */
export function pickReviewEngine(engines?: readonly unknown[]): LocalEngine | null {
    const list = (engines ?? store().get(enginesAtom) ?? []) as { type: string }[];
    const locals = list.filter((e): e is LocalEngine => e.type === "local");
    if (locals.length === 0) return null;
    const wanted = store().get(reviewSettingsAtom).engine;
    const chosen = wanted ? locals.find((e) => e.id === wanted) : undefined;
    return chosen ?? locals.find((e) => e.enabled) ?? locals[0];
}

export function engineKey(engine: LocalEngine): string {
    return `${engine.name} ${engine.version}`.trim();
}

/** Main line of a tree as review positions (root first). */
export function mainLinePositions(tree: TreeState): ReviewPosition[] {
    const out: ReviewPosition[] = [];
    let previousFen: string | null = null;
    for (const { node } of treeIteratorMainLine(tree.root)) {
        let uci: string | null = null;
        if (node.move && previousFen) {
            const [pos] = positionFromFen(previousFen);
            uci = pos ? toStandardUci(pos, makeUci(node.move)) : makeUci(node.move);
        }
        out.push({
            fen: node.fen,
            san: node.san,
            uci,
            nodeId: node.id,
            clock: node.clock,
        });
        previousFen = node.fen;
    }
    return out;
}

export function headersOf(tree: TreeState): ReviewHeaders {
    const h = tree.headers;
    return { white: h.white, black: h.black, result: h.result, date: h.date ?? undefined };
}

function cachedToAnalysis(entry: CachedEval): MoveAnalysis {
    const pv = entry.pv.split(/\s+/).filter(Boolean);
    return {
        best: [
            {
                depth: entry.depth,
                score: {
                    value:
                        entry.score_type === "mate"
                            ? { type: "mate", value: entry.score_value }
                            : { type: "cp", value: entry.score_value },
                    wdl: null,
                },
                uciMoves: pv.length > 0 ? pv : [entry.best_uci],
                sanMoves: [],
                multipv: 1,
                nodes: 0,
                nps: 0,
            },
        ],
        novelty: false,
        is_sacrifice: false,
    };
}

function toCached(epd: string, engine: string, analysis: MoveAnalysis): CachedEval | null {
    const best = analysis.best[0];
    if (!best) return null;
    const value = best.score.value;
    if (value.type !== "cp" && value.type !== "mate") return null;
    return {
        epd,
        engine,
        depth: best.depth,
        score_type: value.type,
        score_value: value.value,
        best_uci: best.uciMoves[0] ?? "",
        pv: best.uciMoves.join(" "),
    };
}

let reviewCounter = 0;

async function runEngine(
    id: string,
    engine: LocalEngine,
    depth: number,
    fen: string,
    moves: string[],
    onProgress: ((p: number) => void) | undefined,
    signal: AbortSignal | undefined,
): Promise<MoveAnalysis[]> {
    const engineSettings = (engine.settings ?? []).map((s) => ({
        name: s.name,
        value: s.value?.toString() ?? "",
    }));
    const unlisten = events.progressEvent.listen(({ payload }) => {
        if (payload.id === id) onProgress?.(Math.max(0, Math.min(1, payload.progress / 100)));
    });
    const onAbort = () => {
        void commands.cancelAnalysis(id);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (signal?.aborted) throw new ReviewError("Review.Cancelled");
        const result = await commands.analyzeGame(
            id,
            engine.path,
            { t: "Depth", c: depth },
            { fen, moves, annotateNovelties: false, referenceDb: null, reversed: true },
            engineSettings,
        );
        if (result.status === "error") {
            throw new ReviewError(
                signal?.aborted ? "Review.Cancelled" : "Review.EngineFailed",
                result.error,
            );
        }
        return result.data;
    } finally {
        signal?.removeEventListener("abort", onAbort);
        unlisten.then((f) => f()).catch(() => undefined);
    }
}

/**
 * Reviews one game and stores the result (replacing any previous review of
 * the same game). Resolves with the stored review.
 */
export async function reviewGame(input: ReviewGameInput): Promise<Review> {
    const tree = input.tree ?? (input.pgn !== undefined ? await parsePGN(input.pgn) : null);
    if (!tree) throw new ReviewError("Review.NoGame");
    const root = ensureNodeIds(tree.root);
    const positions = mainLinePositions({ ...tree, root });
    if (positions.length < 2) throw new ReviewError("Review.NoMoves");

    const engine = input.engine ?? pickReviewEngine();
    if (!engine) throw new ReviewError("Review.NoEngine");
    const settings = store().get(reviewSettingsAtom);
    const depth =
        input.depth ??
        (input.preset === "blunder_check" ? settings.blunderCheckDepth : settings.depth);
    const engineName = engineKey(engine);
    const playerColor = input.playerColor ?? null;

    // Terminal positions are not analysed (same rule as `analyze_game`).
    const analysable = positions.map((p) => {
        const [pos] = positionFromFen(p.fen);
        return pos !== null && !pos.isEnd();
    });
    const epds = positions.map((p) => fenToEpd(p.fen));
    const cached = await evalCacheGet(
        epds.filter((_, i) => analysable[i]),
        engineName,
        depth,
    );
    const allCached = analysable.every((ok, i) => !ok || cached.has(epds[i]));

    const analysis: (MoveAnalysis | undefined)[] = [];
    if (allCached) {
        for (let i = 0; i < positions.length; i++) {
            const entry = cached.get(epds[i]);
            analysis.push(analysable[i] && entry ? cachedToAnalysis(entry) : undefined);
        }
        input.onProgress?.(1);
    } else {
        const id = `review_${Date.now().toString(36)}_${reviewCounter++}`;
        const moves = getMainLine(root);
        const results = await runEngine(
            id,
            engine,
            depth,
            root.fen,
            moves,
            input.onProgress,
            input.signal,
        );
        let k = 0;
        for (let i = 0; i < positions.length; i++) {
            analysis.push(analysable[i] ? results[k++] : undefined);
        }
        const entries: CachedEval[] = [];
        for (let i = 0; i < positions.length; i++) {
            const a = analysis[i];
            if (!a) continue;
            const entry = toCached(epds[i], engineName, a);
            if (entry) entries.push(entry);
        }
        await evalCachePut(entries);
    }
    if (input.signal?.aborted) throw new ReviewError("Review.Cancelled");

    const review = buildReview({
        gameKey: input.gameKey,
        engine: engineName,
        depth,
        playerColor,
        preset: input.preset,
        positions,
        analysis,
        headers: headersOf(tree),
    });

    await attachExplanations(review);
    await saveReview(review, input.title ?? reviewTitle(review));
    return review;
}

/** S2-4's deterministic explanations; a missing or failing module leaves moments unexplained. */
async function attachExplanations(review: Review): Promise<void> {
    let explain: typeof import("@/chessin/explain") | null = null;
    try {
        explain = await import("@/chessin/explain");
    } catch {
        return;
    }
    if (typeof explain?.explainMoment !== "function") return;
    for (const moment of review.moments) {
        try {
            moment.explanations = explain.explainMoment(explainInputFor(moment, review.plies));
        } catch (e) {
            console.warn("explainMoment failed", e);
        }
    }
}

// ---------------------------------------------------------------------------
// Loading games from their origin

export type LoadedGame = { tree: TreeState; title: string };

function titleOf(headers: GameHeaders, fallback: string): string {
    const name = getGameName(headers);
    return name === "Unknown" ? fallback : name;
}

/** Scans the database (newest id first) for `gameId`. */
export async function findDatabaseGame(
    database: string,
    gameId: number,
    pageSize = 200,
    maxPages = 50,
): Promise<NormalizedGame | null> {
    for (let page = 1; page <= maxPages; page++) {
        const res = await query_games(database, {
            options: { page, pageSize, sort: "id", direction: "desc", skipCount: true },
        });
        const found = res.data.find((g) => g.id === gameId);
        if (found) return found;
        if (res.data.length < pageSize) break;
    }
    return null;
}

export async function loadGameFromOrigin(origin: GameOrigin): Promise<LoadedGame> {
    switch (origin.kind) {
        case "file":
        case "temp_file": {
            const pgns = unwrap(
                await commands.readGames(origin.file.path, origin.gameNumber, origin.gameNumber),
            );
            const pgn = pgns[0];
            if (!pgn) throw new ReviewError("Review.NoGame");
            const tree = await parsePGN(pgn);
            return { tree, title: titleOf(tree.headers, origin.file.name) };
        }
        case "database": {
            const game = await findDatabaseGame(origin.database, origin.gameId);
            if (!game) throw new ReviewError("Review.NoGame");
            const tree = await parsePGN(game.moves, game.fen);
            tree.headers = { ...tree.headers, ...game };
            return { tree, title: `${game.white} – ${game.black}` };
        }
        case "library": {
            const doc = await getDoc(origin.docId);
            if (!doc) throw new ReviewError("Review.NoGame");
            const parsed = JSON.parse(doc.data) as { state?: TreeState } | TreeState;
            const state = ("state" in parsed && parsed.state ? parsed.state : parsed) as TreeState;
            if (!state || !(state as { root?: TreeNode }).root)
                throw new ReviewError("Review.NoGame");
            return { tree: state, title: doc.title || titleOf(state.headers, origin.docId) };
        }
        case "none":
            throw new ReviewError("Review.NoOrigin");
    }
}

// ---------------------------------------------------------------------------
// Background jobs

export type ReviewJobPayload = {
    gameKey: string;
    source: GameOrigin;
    playerColor?: PlayerColor | null;
    preset: ReviewPreset;
    title?: string;
};

export type EnqueueReviewOptions = {
    playerColor?: PlayerColor | null;
    preset?: ReviewPreset;
    title?: string;
};

/**
 * Queues a background review of the game at `source` (deduplicated per game
 * key while queued / running). Resolves with the job id.
 */
export async function enqueueReview(
    source: GameOrigin,
    opts: EnqueueReviewOptions = {},
): Promise<{ id: string; gameKey: string }> {
    const gameKey = gameKeyForOrigin(source);
    if (!gameKey) throw new ReviewError("Review.NoOrigin");
    const preset = opts.preset ?? "full";
    const payload: ReviewJobPayload = {
        gameKey,
        source,
        playerColor: opts.playerColor ?? null,
        preset,
        title: opts.title,
    };
    const [{ enqueueJob }, { registerReviewJobHandler }] = await Promise.all([
        import("@/chessin/jobs/queue"),
        import("./jobHandler"),
    ]);
    registerReviewJobHandler();
    const job = await enqueueJob({
        kind: "review",
        title: tr(preset === "blunder_check" ? "Review.Job.BlunderCheck" : "Review.Job.Full", {
            name: opts.title ?? gameKey,
        }),
        payload,
        dedupeKey: `review:${gameKey}`,
    });
    return { id: job.id, gameKey };
}
