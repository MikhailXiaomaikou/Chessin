import { describe, expect, it, vi } from "vitest";
import type { TablebaseProbe } from "@/chessin/bindings";
import type { Engine } from "@/utils/engines";
import {
    applySyzygyPath,
    categoryOf,
    type ProbeDeps,
    probePlan,
    probeTablebase,
    SYZYGY_PATH_OPTION,
    type TablebaseData,
    toTablebaseData,
} from "./tablebase";

const FEN = "8/8/8/8/8/4k3/8/4K2Q w - - 0 1";

const probe: TablebaseProbe = {
    wdl: 2,
    dtz: 9,
    checkmate: false,
    stalemate: false,
    insufficient_material: false,
    best: [
        {
            uci: "h1h7",
            san: "Qh7",
            wdl: 2,
            dtz: 8,
            zeroing: false,
            checkmate: false,
            stalemate: false,
            insufficient_material: false,
        },
        {
            uci: "e1d1",
            san: "Kd1",
            wdl: 0,
            dtz: 0,
            zeroing: false,
            checkmate: false,
            stalemate: false,
            insufficient_material: false,
        },
        {
            uci: "h1e4",
            san: "Qe4+",
            wdl: -1,
            dtz: null,
            zeroing: false,
            checkmate: false,
            stalemate: false,
            insufficient_material: false,
        },
    ],
};

const remoteData: TablebaseData = {
    checkmate: false,
    stalemate: false,
    variant_win: false,
    variant_loss: false,
    insufficient_material: false,
    dtz: 3,
    precise_dtz: 3,
    dtm: 0,
    category: "draw",
    moves: [],
};

describe("probePlan", () => {
    it("chooses local first, local only when offline, lichess otherwise", () => {
        expect(probePlan({ dir: "/tb", offline: false })).toEqual(["local", "lichess"]);
        expect(probePlan({ dir: "/tb", offline: true })).toEqual(["local"]);
        expect(probePlan({ dir: null, offline: false })).toEqual(["lichess"]);
        expect(probePlan({ dir: null, offline: true })).toEqual([]);
        expect(probePlan({ dir: "", offline: false })).toEqual(["lichess"]);
    });
});

describe("toTablebaseData", () => {
    it("maps wdl to categories", () => {
        expect(categoryOf(2)).toBe("win");
        expect(categoryOf(1)).toBe("cursed-win");
        expect(categoryOf(0)).toBe("draw");
        expect(categoryOf(-1)).toBe("blessed-loss");
        expect(categoryOf(-2)).toBe("loss");
    });

    it("flips move values to the Lichess point of view (the side to move after)", () => {
        const data = toTablebaseData(probe);
        expect(data.category).toBe("win");
        expect(data.dtz).toBe(9);
        expect(data.moves.map((m) => [m.san, m.category, m.dtz])).toEqual([
            ["Qh7", "loss", -8],
            ["Kd1", "draw", 0],
            ["Qe4+", "cursed-win", 0],
        ]);
        expect(data.moves[0]).toMatchObject({
            uci: "h1h7",
            zeroing: false,
            checkmate: false,
            variant_win: false,
            dtm: 0,
        });
    });

    it("reports finished positions", () => {
        const mate = toTablebaseData({
            ...probe,
            wdl: -2,
            dtz: 0,
            checkmate: true,
            best: [],
        });
        expect(mate).toMatchObject({ category: "loss", checkmate: true, dtz: 0, moves: [] });
        const noDtz = toTablebaseData({ ...probe, dtz: null });
        expect(noDtz.dtz).toBe(0);
    });
});

describe("probeTablebase", () => {
    it("uses the local tables when they cover the position and never calls lichess", async () => {
        const local = vi.fn<ProbeDeps["local"]>(async () => probe);
        const remote = vi.fn<ProbeDeps["remote"]>(async () => remoteData);
        const result = await probeTablebase(FEN, { dir: "/tb", offline: false, remote }, { local });
        expect(result?.local).toBe(true);
        expect(result?.category).toBe("win");
        expect(local).toHaveBeenCalledWith("/tb", FEN);
        expect(remote).not.toHaveBeenCalled();
    });

    it("falls back to lichess when the local tables do not cover the position", async () => {
        const local = vi.fn<ProbeDeps["local"]>(async () => null);
        const remote = vi.fn<ProbeDeps["remote"]>(async () => remoteData);
        const result = await probeTablebase(FEN, { dir: "/tb", offline: false, remote }, { local });
        expect(result).toEqual({ ...remoteData, local: false });
        expect(remote).toHaveBeenCalledWith(FEN);
    });

    it("stays local when offline, even for an uncovered position", async () => {
        const local = vi.fn<ProbeDeps["local"]>(async () => null);
        const remote = vi.fn<ProbeDeps["remote"]>(async () => remoteData);
        expect(
            await probeTablebase(FEN, { dir: "/tb", offline: true, remote }, { local }),
        ).toBeNull();
        expect(remote).not.toHaveBeenCalled();
    });

    it("asks only lichess without a directory, and nothing when offline", async () => {
        const local = vi.fn<ProbeDeps["local"]>(async () => probe);
        const remote = vi.fn<ProbeDeps["remote"]>(async () => remoteData);
        expect(await probeTablebase(FEN, { dir: null, offline: false, remote }, { local })).toEqual(
            { ...remoteData, local: false },
        );
        expect(local).not.toHaveBeenCalled();
        expect(
            await probeTablebase(FEN, { dir: null, offline: true, remote }, { local }),
        ).toBeNull();
        expect(remote).toHaveBeenCalledTimes(1);
    });

    it("surfaces a local error instead of silently going online", async () => {
        const local = vi.fn<ProbeDeps["local"]>(async () => {
            throw new Error("tablebase probe failed: bad magic");
        });
        const remote = vi.fn<ProbeDeps["remote"]>(async () => remoteData);
        await expect(
            probeTablebase(FEN, { dir: "/tb", offline: false, remote }, { local }),
        ).rejects.toThrow("bad magic");
        expect(remote).not.toHaveBeenCalled();
    });
});

describe("applySyzygyPath", () => {
    const local: Engine = {
        type: "local",
        id: "sf",
        name: "Stockfish",
        version: "17",
        path: "/engines/sf",
        settings: [
            { name: "MultiPV", value: 2 },
            { name: "Threads", value: 4 },
        ],
    };
    const remote: Engine = {
        type: "lichess",
        id: "li",
        name: "Lichess",
        url: "https://lichess.org",
        settings: [{ name: "MultiPV", value: 1 }],
    };

    it("adds SyzygyPath to local engines only, keeping other options", () => {
        const next = applySyzygyPath([local, remote], "/tb");
        expect(next[0].settings).toEqual([
            { name: "MultiPV", value: 2 },
            { name: "Threads", value: 4 },
            { name: SYZYGY_PATH_OPTION, value: "/tb" },
        ]);
        expect(next[1]).toBe(remote);
        expect(local.settings).toHaveLength(2);
    });

    it("replaces an existing SyzygyPath and is a no-op when unchanged", () => {
        const withPath = applySyzygyPath([local], "/old")[0];
        const changed = applySyzygyPath([withPath], "/new")[0];
        expect(changed.settings?.filter((s) => s.name === SYZYGY_PATH_OPTION)).toEqual([
            { name: SYZYGY_PATH_OPTION, value: "/new" },
        ]);
        expect(applySyzygyPath([changed], "/new")[0]).toBe(changed);
    });

    it("removes SyzygyPath when the toggle is off", () => {
        const withPath = applySyzygyPath([local], "/tb")[0];
        const cleared = applySyzygyPath([withPath], null)[0];
        expect(cleared.settings).toEqual([
            { name: "MultiPV", value: 2 },
            { name: "Threads", value: 4 },
        ]);
        expect(applySyzygyPath([local], null)[0]).toBe(local);
        const bare: Engine = { ...local, settings: null };
        expect(applySyzygyPath([bare], "/tb")[0].settings).toEqual([
            { name: SYZYGY_PATH_OPTION, value: "/tb" },
        ]);
    });
});
