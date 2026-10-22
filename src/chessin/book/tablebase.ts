import { atomWithStorage } from "jotai/utils";
import { commands, type TablebaseMove, type TablebaseProbe } from "@/chessin/bindings";
import type { Engine } from "@/utils/engines";
import type {
    getTablebaseInfo,
    TablebaseCategory,
    TablebaseMove as LichessTablebaseMove,
} from "@/utils/lichess/api";

/**
 * Local Syzygy tablebases (S4-4).
 *
 * `tablebaseDirAtom` is the directory of `.rtbw`/`.rtbz` files. When it is
 * set, the tablebase panel probes it first and asks Lichess only for
 * positions the local tables do not cover; when the app is offline the
 * local tables are the only source. `probeTablebase` turns a local probe
 * into the shape the Lichess API returns, so `TablebaseInfo.tsx` renders
 * both the same way.
 *
 * "引擎使用本地残局库" (`engineSyzygyAtom`) writes a `SyzygyPath` option
 * into every local engine's stored UCI settings (`applySyzygyPath`): those
 * settings become the `extraOptions` of every analysis request, which the
 * Rust side sends as `setoption name SyzygyPath value <dir>`.
 */

export const TABLEBASE_DIR_KEY = "chessin.tablebaseDir";
export const ENGINE_SYZYGY_KEY = "chessin.engineSyzygy";

/** Directory of the local Syzygy tables; null when not configured. */
export const tablebaseDirAtom = atomWithStorage<string | null>(TABLEBASE_DIR_KEY, null, undefined, {
    getOnInit: true,
});

/** Whether local engines get `SyzygyPath` (the Settings toggle). */
export const engineSyzygyAtom = atomWithStorage<boolean>(ENGINE_SYZYGY_KEY, false, undefined, {
    getOnInit: true,
});

export type ProbeSource = "local" | "lichess";

/** Which probes to try, in order, for the given configuration. */
export function probePlan(opts: { dir: string | null; offline: boolean }): ProbeSource[] {
    if (opts.dir) return opts.offline ? ["local"] : ["local", "lichess"];
    return opts.offline ? [] : ["lichess"];
}

/** The Lichess API's result shape (its type is not exported). */
export type TablebaseData = NonNullable<Awaited<ReturnType<typeof getTablebaseInfo>>>;

export type TablebaseResult = TablebaseData & {
    /** True when the local tables answered. */
    local: boolean;
};

/** `wdl` of the Rust probe (−2 … 2) as the Lichess category of the side to move. */
export function categoryOf(wdl: number): TablebaseCategory {
    if (wdl >= 2) return "win";
    if (wdl === 1) return "cursed-win";
    if (wdl === 0) return "draw";
    if (wdl === -1) return "blessed-loss";
    return "loss";
}

function toLichessMove(m: TablebaseMove): LichessTablebaseMove {
    // Lichess describes a move from the point of view of the side to move
    // after it; the probe describes it for the mover, so both flip.
    const dtz = m.dtz ? -m.dtz : 0;
    return {
        uci: m.uci,
        san: m.san,
        zeroing: m.zeroing,
        checkmate: m.checkmate,
        stalemate: m.stalemate,
        variant_win: false,
        variant_loss: false,
        insufficient_material: m.insufficient_material,
        dtz,
        precise_dtz: dtz,
        dtm: 0,
        category: categoryOf(-m.wdl),
    };
}

/** A local probe in the Lichess API's shape. */
export function toTablebaseData(probe: TablebaseProbe): TablebaseData {
    const dtz = probe.dtz ?? 0;
    return {
        checkmate: probe.checkmate,
        stalemate: probe.stalemate,
        variant_win: false,
        variant_loss: false,
        insufficient_material: probe.insufficient_material,
        dtz,
        precise_dtz: dtz,
        dtm: 0,
        category: categoryOf(probe.wdl),
        moves: probe.best.map(toLichessMove),
    };
}

export type ProbeDeps = {
    /** The local probe; resolves to null when the tables do not cover the position. */
    local: (dir: string, fen: string) => Promise<TablebaseProbe | null>;
    /** The Lichess API; resolves to null when offline. */
    remote: (fen: string) => Promise<TablebaseData | null>;
};

export async function localProbe(dir: string, fen: string): Promise<TablebaseProbe | null> {
    const r = await commands.tablebaseProbe(dir, fen);
    if (r.status === "error") throw new Error(r.error);
    return r.data;
}

/**
 * Probes `fen` following `probePlan`: the local tables first when a
 * directory is set, Lichess when they do not cover the position and the
 * app is online. A local error (a corrupt table) is thrown, not hidden.
 */
export async function probeTablebase(
    fen: string,
    opts: { dir: string | null; offline: boolean; remote: ProbeDeps["remote"] },
    deps: Pick<ProbeDeps, "local"> = { local: localProbe },
): Promise<TablebaseResult | null> {
    for (const step of probePlan(opts)) {
        if (step === "local") {
            const probe = await deps.local(opts.dir!, fen);
            if (probe) return { ...toTablebaseData(probe), local: true };
        } else {
            const data = await opts.remote(fen);
            if (data) return { ...data, local: false };
        }
    }
    return null;
}

export const SYZYGY_PATH_OPTION = "SyzygyPath";

/**
 * The engines list with `SyzygyPath` set to `dir` in every local engine's
 * UCI settings, or removed from them when `dir` is null. Remote engines
 * and other options are untouched; objects are only copied where they
 * change.
 */
export function applySyzygyPath(engines: Engine[], dir: string | null): Engine[] {
    return engines.map((engine) => {
        if (engine.type !== "local") return engine;
        const settings = engine.settings ?? [];
        const others = settings.filter((s) => s.name !== SYZYGY_PATH_OPTION);
        const current = settings.find((s) => s.name === SYZYGY_PATH_OPTION)?.value ?? null;
        if (current === dir) return engine;
        return {
            ...engine,
            settings: dir === null ? others : [...others, { name: SYZYGY_PATH_OPTION, value: dir }],
        };
    });
}
