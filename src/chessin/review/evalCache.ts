import { commands } from "@/chessin/bindings";
import { hasTauri, unwrapResult } from "@/chessin/store/libraryStore";

/**
 * Typed wrappers over S2-1's `eval_cache_get` / `eval_cache_put` plugin
 * commands. They are looked up with `typeof` checks so the review works (without
 * caching) until the commands are part of `src/chessin/bindings.ts`, and in
 * vitest / the browser dev server.
 */

export type CachedEval = {
    epd: string;
    engine: string;
    depth: number;
    score_type: "cp" | "mate";
    score_value: number;
    best_uci: string;
    /** Space-separated UCI. */
    pv: string;
};

type EvalCacheCommands = {
    evalCacheGet?: (epds: string[], engine: string, minDepth: number) => Promise<unknown>;
    evalCachePut?: (entries: CachedEval[]) => Promise<unknown>;
};

function native(): EvalCacheCommands {
    return commands as unknown as EvalCacheCommands;
}

/** True inside Tauri when both commands exist on the generated bindings. */
export function hasEvalCache(): boolean {
    const c = native();
    return (
        hasTauri() && typeof c.evalCacheGet === "function" && typeof c.evalCachePut === "function"
    );
}

function normalize(raw: unknown): CachedEval | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const scoreType = r.score_type ?? r.scoreType;
    if (scoreType !== "cp" && scoreType !== "mate") return null;
    return {
        epd: String(r.epd ?? ""),
        engine: String(r.engine ?? ""),
        depth: Number(r.depth ?? 0),
        score_type: scoreType,
        score_value: Number(r.score_value ?? r.scoreValue ?? 0),
        best_uci: String(r.best_uci ?? r.bestUci ?? ""),
        pv: String(r.pv ?? ""),
    };
}

/** Cached evaluations with `depth ≥ minDepth`, keyed by epd. Empty when the cache is unavailable. */
export async function evalCacheGet(
    epds: string[],
    engine: string,
    minDepth: number,
): Promise<Map<string, CachedEval>> {
    const out = new Map<string, CachedEval>();
    const c = native();
    if (!hasEvalCache() || epds.length === 0) return out;
    try {
        const rows = unwrapResult<unknown>(await c.evalCacheGet!(epds, engine, minDepth));
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const entry = normalize(row);
                if (entry && entry.depth >= minDepth) out.set(entry.epd, entry);
            }
        }
    } catch (e) {
        console.warn("eval_cache_get failed", e);
    }
    return out;
}

/** Best-effort write; never throws. */
export async function evalCachePut(entries: CachedEval[]): Promise<void> {
    const c = native();
    if (!hasEvalCache() || entries.length === 0) return;
    try {
        unwrapResult<unknown>(await c.evalCachePut!(entries));
    } catch (e) {
        console.warn("eval_cache_put failed", e);
    }
}
