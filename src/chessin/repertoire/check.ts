import { atom, getDefaultStore } from "jotai";
import { atomFamily } from "jotai/utils";
import { evalCacheGet } from "@/chessin/review/evalCache";
import { getKv, setKv } from "@/chessin/store/libraryStore";
import { enginesAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import type { LocalEngine } from "@/utils/engines";
import { type ColdNode, coldNodesAtom, findColdNodes } from "./cold";
import { type Conflict, findConflicts } from "./conflicts";
import { computeCoverage, isCoverageAbortError } from "./coverage";
import { type ExplorerCache, explorerQueryFor, getExplorerCache } from "./explorerCache";
import { type EngineScore, type Gap, gapThreshold, rankGaps } from "./gaps";
import { DEFAULT_DEPTH_MOVES, type RepertoireMeta } from "./model";

/**
 * The repertoire check runner (S3-5): coverage → conflicts → gap ranking →
 * cold shelf, with per-repertoire progress state for the UI and the last
 * result persisted in the library kv store (`rep.check.<id>`) so it can be
 * shown again offline or after a restart.
 */

export type CheckStatus = "idle" | "running" | "done" | "error";

export type CoverageSummary = {
    covered: number;
    nodes: number;
    requests: number;
    cached: number;
    unknown: number;
    unknownMass: number;
    truncatedMass: number;
    prunedMass: number;
};

export type CheckSummary = {
    /** Unix milliseconds. */
    at: number;
    repertoireId: string;
    meta: RepertoireMeta;
    depthMoves: number;
    coverage: CoverageSummary;
    gaps: Gap[];
    conflicts: Conflict[];
    cold: { threshold: number; count: number; heads: ColdNode[]; epds: string[] };
    /** Offline mode was on: nothing was fetched, cached data only. */
    offline: boolean;
    /** Offline and some positions had no cached data. */
    partial: boolean;
};

export type CheckState = {
    status: CheckStatus;
    progress: { done: number; total: number };
    result: CheckSummary | null;
    error: string | null;
};

export const INITIAL_CHECK_STATE: CheckState = {
    status: "idle",
    progress: { done: 0, total: 0 },
    result: null,
    error: null,
};

export const checkStateFamily = atomFamily((_repertoireId: string) =>
    atom<CheckState>(INITIAL_CHECK_STATE),
);

export const CHECK_RESULT_PREFIX = "rep.check.";

export function checkResultKey(repertoireId: string): string {
    return `${CHECK_RESULT_PREFIX}${repertoireId}`;
}

export async function loadLastCheck(repertoireId: string): Promise<CheckSummary | null> {
    try {
        const raw = await getKv(checkResultKey(repertoireId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CheckSummary;
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.gaps)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export async function saveLastCheck(summary: CheckSummary): Promise<void> {
    try {
        await setKv(checkResultKey(summary.repertoireId), JSON.stringify(summary));
    } catch {
        // best effort
    }
}

/** Same key the review uses for `eval_cache` rows (`reviewGame.engineKey`). */
export function localEngineKey(engine: Pick<LocalEngine, "name" | "version">): string {
    return `${engine.name} ${engine.version}`.trim();
}

/**
 * Cached engine evaluations (white view) for the given EPDs, from any local
 * engine; the deepest entry per position wins. Empty outside Tauri.
 */
export async function lookupCachedEvals(
    epds: string[],
    store = getDefaultStore(),
): Promise<Map<string, EngineScore>> {
    const out = new Map<string, EngineScore>();
    const unique = Array.from(new Set(epds.filter((e) => e.length > 0)));
    if (unique.length === 0) return out;
    let engines: { type: string }[] = [];
    try {
        engines = (store.get(enginesAtom) ?? []) as { type: string }[];
    } catch {
        engines = [];
    }
    const depths = new Map<string, number>();
    for (const engine of engines) {
        if (engine.type !== "local") continue;
        const rows = await evalCacheGet(unique, localEngineKey(engine as LocalEngine), 0);
        for (const [epd, entry] of rows) {
            if ((depths.get(epd) ?? -1) >= entry.depth) continue;
            depths.set(epd, entry.depth);
            out.set(epd, { type: entry.score_type, value: entry.score_value });
        }
    }
    return out;
}

export type CheckDeps = {
    cache: ExplorerCache;
    lookupEvals: (epds: string[]) => Promise<Map<string, EngineScore | number>>;
    now: () => number;
    persist: (summary: CheckSummary) => Promise<void>;
};

export function defaultCheckDeps(): CheckDeps {
    return {
        cache: getExplorerCache(),
        lookupEvals: (epds) => lookupCachedEvals(epds),
        now: () => Date.now(),
        persist: saveLastCheck,
    };
}

const controllers = new Map<string, AbortController>();

/** Cancels the running check of a repertoire (its previous result is kept). */
export function cancelRepertoireCheck(repertoireId: string): void {
    controllers.get(repertoireId)?.abort();
}

export function isCheckRunning(repertoireId: string): boolean {
    return controllers.has(repertoireId);
}

export type RunCheckInput = {
    treeStore: TreeStore;
    repertoireId: string;
    meta: RepertoireMeta;
    deps?: CheckDeps;
    store?: ReturnType<typeof getDefaultStore>;
};

/**
 * Runs the full check for one repertoire and returns the summary; the state
 * atom of `repertoireId` follows along (running → done / error). A second run
 * for the same repertoire cancels the first. Returns null when cancelled.
 */
export async function runRepertoireCheck({
    treeStore,
    repertoireId,
    meta,
    deps = defaultCheckDeps(),
    store = getDefaultStore(),
}: RunCheckInput): Promise<CheckSummary | null> {
    controllers.get(repertoireId)?.abort();
    const controller = new AbortController();
    controllers.set(repertoireId, controller);
    const stateAtom = checkStateFamily(repertoireId);
    const setState = (patch: Partial<CheckState>) =>
        store.set(stateAtom, { ...store.get(stateAtom), ...patch });

    const tree = treeStore.getState();
    const color = meta.color;
    const startPath = tree.headers.start ?? [];
    const depthMoves = meta.depth ?? DEFAULT_DEPTH_MOVES;
    const query = explorerQueryFor(meta);
    let offline = false;
    let cached = 0;

    setState({ status: "running", progress: { done: 0, total: 0 }, error: null });
    try {
        const coverage = await computeCoverage(
            tree.root,
            async (fen) => {
                const lookup = await deps.cache.lookup(fen, query);
                if (lookup.offline) offline = true;
                if (lookup.fromCache) cached++;
                return lookup.stats;
            },
            {
                color,
                startPath,
                depthMoves,
                pruneBelow: Math.min(meta.coldThreshold, gapThreshold(meta.coverageTarget)) / 10,
                signal: controller.signal,
                onProgress: (done, total) => setState({ progress: { done, total } }),
            },
        );
        const conflicts = findConflicts(tree.root, color, startPath);
        const evals = await deps.lookupEvals(coverage.gaps.map((g) => g.childEpd));
        if (controller.signal.aborted)
            throw Object.assign(new Error(), { name: "CoverageAbortError" });
        const gaps = rankGaps(coverage.gaps, {
            coverageTarget: meta.coverageTarget,
            color,
            evals,
        });
        const cold = findColdNodes(tree.root, coverage.reach, {
            color,
            coldThreshold: meta.coldThreshold,
            startPath,
        });
        const summary: CheckSummary = {
            at: deps.now(),
            repertoireId,
            meta,
            depthMoves,
            coverage: {
                covered: coverage.covered,
                nodes: coverage.nodes,
                requests: coverage.requests,
                cached,
                unknown: coverage.unknown,
                unknownMass: coverage.unknownMass,
                truncatedMass: coverage.truncatedMass,
                prunedMass: coverage.prunedMass,
            },
            gaps,
            conflicts,
            cold: {
                threshold: cold.threshold,
                count: cold.nodes.length,
                heads: cold.heads,
                epds: Array.from(cold.epds),
            },
            offline,
            partial: offline && coverage.unknown > 0,
        };
        store.set(coldNodesAtom, {
            repertoireId,
            threshold: cold.threshold,
            epds: cold.epds,
            count: cold.nodes.length,
        });
        setState({ status: "done", result: summary, error: null });
        await deps.persist(summary);
        return summary;
    } catch (error) {
        if (isCoverageAbortError(error)) {
            setState({ status: store.get(stateAtom).result ? "done" : "idle" });
            return null;
        }
        setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    } finally {
        if (controllers.get(repertoireId) === controller) controllers.delete(repertoireId);
    }
}

/** Shows a stored result in the state atom when nothing newer is there. */
export async function restoreLastCheck(
    repertoireId: string,
    store = getDefaultStore(),
): Promise<CheckSummary | null> {
    const stateAtom = checkStateFamily(repertoireId);
    const current = store.get(stateAtom);
    if (current.result || current.status === "running") return current.result;
    const last = await loadLastCheck(repertoireId);
    if (!last) return null;
    const again = store.get(stateAtom);
    if (again.result || again.status === "running") return again.result;
    store.set(stateAtom, { ...again, status: "done", result: last });
    if (store.get(coldNodesAtom).repertoireId === null) {
        store.set(coldNodesAtom, {
            repertoireId,
            threshold: last.cold.threshold,
            epds: new Set(last.cold.epds),
            count: last.cold.count,
        });
    }
    return last;
}
