import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory stand-ins for the Tauri fs / path plugins (POSIX paths).

const fakeFs = vi.hoisted(() => {
    type FakeFile = { content: string; size: number };
    const files = new Map<string, FakeFile>();
    const dirs = new Set<string>();
    const copyLog: [string, string][] = [];
    const state = { failCopyOf: null as string | null };

    const norm = (p: string) => p.replace(/\/+$/, "") || "/";
    const parent = (p: string) => {
        const i = p.lastIndexOf("/");
        return i <= 0 ? "/" : p.slice(0, i);
    };
    const addDir = (p: string) => {
        let cur = norm(p);
        while (cur !== "/") {
            dirs.add(cur);
            cur = parent(cur);
        }
        dirs.add("/");
    };
    const addFile = (p: string, content: string, size = content.length) => {
        addDir(parent(norm(p)));
        files.set(norm(p), { content, size });
    };
    const reset = () => {
        files.clear();
        dirs.clear();
        copyLog.length = 0;
        state.failCopyOf = null;
    };
    const snapshot = (prefix: string) =>
        Array.from(files.entries())
            .filter(([p]) => p.startsWith(prefix))
            .map(([p, f]) => `${p}:${f.size}:${f.content}`)
            .sort();
    return { files, dirs, copyLog, state, norm, parent, addDir, addFile, reset, snapshot };
});

const paths = vi.hoisted(() => ({
    dataDir: "/home/u/.local/share",
    appDataDir: "/home/u/.local/share/cn.chessin.app",
}));

vi.mock("@tauri-apps/plugin-fs", () => {
    const { files, dirs, copyLog, state, norm, parent, addDir, addFile } = fakeFs;
    return {
        BaseDirectory: { AppData: 1 },
        exists: async (p: string) => files.has(norm(p)) || dirs.has(norm(p)),
        readDir: async (p: string) => {
            const d = norm(p);
            if (!dirs.has(d)) throw new Error(`ENOENT ${p}`);
            const names = new Map<string, { isDirectory: boolean; isFile: boolean }>();
            for (const f of files.keys()) {
                if (parent(f) === d) {
                    names.set(f.slice(d.length + 1), { isDirectory: false, isFile: true });
                }
            }
            for (const sub of dirs) {
                if (sub !== d && parent(sub) === d) {
                    names.set(sub.slice(d.length + 1), { isDirectory: true, isFile: false });
                }
            }
            return Array.from(names, ([name, flags]) => ({ name, ...flags, isSymlink: false }));
        },
        stat: async (p: string) => {
            const n = norm(p);
            const f = files.get(n);
            if (f) return { isFile: true, isDirectory: false, isSymlink: false, size: f.size };
            if (dirs.has(n)) return { isFile: false, isDirectory: true, isSymlink: false, size: 0 };
            throw new Error(`ENOENT ${p}`);
        },
        mkdir: async (p: string) => addDir(p),
        copyFile: async (from: string, to: string) => {
            if (state.failCopyOf && norm(from) === norm(state.failCopyOf)) {
                throw new Error("EACCES");
            }
            const f = files.get(norm(from));
            if (!f) throw new Error(`ENOENT ${from}`);
            if (!dirs.has(parent(norm(to)))) throw new Error(`ENOENT parent of ${to}`);
            copyLog.push([norm(from), norm(to)]);
            files.set(norm(to), { ...f });
        },
        readTextFile: async (p: string) => {
            const f = files.get(norm(p));
            if (!f) throw new Error(`ENOENT ${p}`);
            return f.content;
        },
        writeTextFile: async (p: string, data: string) => {
            addFile(p, data);
        },
        remove: async (p: string) => {
            files.delete(norm(p));
        },
    };
});

vi.mock("@tauri-apps/api/path", () => {
    const join = async (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
    return {
        dataDir: async () => paths.dataDir,
        appDataDir: async () => paths.appDataDir,
        documentDir: async () => "/home/u/Documents",
        homeDir: async () => "/home/u",
        resolve: join,
        join,
        basename: async (p: string) => p.split("/").pop() ?? p,
        dirname: async (p: string) => fakeFs.parent(p),
        sep: () => "/",
    };
});

vi.mock("@tauri-apps/plugin-log", () => ({
    trace: async () => {},
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {},
}));

import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import { enginesAtom } from "@/state/atoms";
import type { Engine, LocalEngine } from "@/utils/engines";
import {
    countLocalEngines,
    detectEnCroissant,
    EC_APP_IDENTIFIER,
    hasMigratableData,
    isInsideDir,
    joinPath,
    MIGRATE_DONE_KEY,
    mergeEngines,
    migrateEnCroissant,
    type MigrationProgress,
    parentOf,
    rewriteEnginePath,
    samePath,
    stripTrailingSeparators,
} from "./ecMigrator";

const DATA_DIR = "/home/u/.local/share";
const APP_DIR = `${DATA_DIR}/cn.chessin.app`;
const EC_DIR = `${DATA_DIR}/${EC_APP_IDENTIFIER}`;

function local(overrides: Partial<LocalEngine> & { path: string }): LocalEngine {
    return {
        type: "local",
        id: overrides.path,
        name: "Engine",
        version: "1",
        ...overrides,
    };
}

function seedEnCroissant() {
    fakeFs.addDir(EC_DIR);
    fakeFs.addFile(`${EC_DIR}/db/lichess.db3`, "L", 1000);
    fakeFs.addFile(`${EC_DIR}/db/masters.db3`, "M", 5000);
    fakeFs.addFile(`${EC_DIR}/db/masters.db3-journal`, "J", 10);
    fakeFs.addFile(`${EC_DIR}/db/notes.txt`, "N", 10);
    fakeFs.addFile(`${EC_DIR}/puzzles/lichess_puzzles.db3`, "P", 300);
    fakeFs.addFile(`${EC_DIR}/engines/stockfish/stockfish`, "S", 2000);
    fakeFs.addFile(`${EC_DIR}/engines/stockfish/nn.nnue`, "W", 4000);
    fakeFs.addFile(`${EC_DIR}/engines/lc0/lc0`, "C", 1500);
    fakeFs.addFile(`${EC_DIR}/engines/lc0/weights/t1.pb.gz`, "T", 2500);
    fakeFs.addFile(
        `${EC_DIR}/engines/engines.json`,
        JSON.stringify([
            {
                type: "local",
                id: "ec-sf",
                name: "Stockfish 17",
                version: "17",
                path: `${EC_DIR}/engines/stockfish/stockfish`,
                settings: [{ name: "Threads", value: 4 }],
                go: { t: "Depth", c: 24 },
            },
            {
                type: "local",
                id: "ec-lc0",
                name: "Leela",
                version: "0.31",
                path: `${EC_DIR}/engines/lc0/lc0`,
                elo: 3400,
                settings: [{ name: "Hash", value: 512 }],
                go: { t: "Time", c: 5 },
            },
            { type: "lichess", id: "ec-cloud", name: "Lichess Cloud", url: "https://lichess.org" },
            { type: "local", id: "broken", name: "No path" },
        ]),
    );
}

function seedChessin(engines: Engine[]) {
    fakeFs.addDir(APP_DIR);
    fakeFs.addFile(`${APP_DIR}/engines/engines.json`, JSON.stringify(engines));
}

function chessinEnginesFile(): Engine[] {
    const file = fakeFs.files.get(`${APP_DIR}/engines/engines.json`);
    return file ? (JSON.parse(file.content) as Engine[]) : [];
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    fakeFs.reset();
    paths.dataDir = DATA_DIR;
    paths.appDataDir = APP_DIR;
    localStorage.clear();
    __setLibraryBackendForTests(createMemoryBackend());
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    __setLibraryBackendForTests(null);
});

// ---------------------------------------------------------------------------

describe("path helpers", () => {
    it("joins with the separator style of the directory", () => {
        expect(joinPath("/a/b", "c", "d.db3")).toBe("/a/b/c/d.db3");
        expect(joinPath("/a/b/", "c")).toBe("/a/b/c");
        expect(joinPath("C:\\Users\\x\\AppData", "engines", "sf.exe")).toBe(
            "C:\\Users\\x\\AppData\\engines\\sf.exe",
        );
    });

    it("strips trailing separators but keeps a root", () => {
        expect(stripTrailingSeparators("/a/b//")).toBe("/a/b");
        expect(stripTrailingSeparators("C:\\x\\")).toBe("C:\\x");
        expect(stripTrailingSeparators("/")).toBe("/");
    });

    it("compares paths ignoring separator style", () => {
        expect(samePath("/a/b/", "/a/b")).toBe(true);
        expect(samePath("C:\\a\\b", "C:/a/b")).toBe(true);
        expect(samePath("/a/b", "/a/bc")).toBe(false);
        expect(isInsideDir("/a/b/c", "/a/b")).toBe(true);
        expect(isInsideDir("/a/b", "/a/b/")).toBe(true);
        expect(isInsideDir("/a/bc/d", "/a/b")).toBe(false);
        expect(parentOf("/a/b/c")).toBe("/a/b");
        expect(parentOf("C:\\a\\b")).toBe("C:\\a");
        expect(parentOf("file")).toBeNull();
    });
});

describe("rewriteEnginePath", () => {
    const from = `${EC_DIR}/engines`;
    const to = `${APP_DIR}/engines`;

    it("moves a path below EC's engines dir to Chessin's", () => {
        expect(rewriteEnginePath(`${from}/stockfish/stockfish`, from, to)).toBe(
            `${to}/stockfish/stockfish`,
        );
    });

    it("handles Windows separators and trailing separators", () => {
        const winFrom = "C:\\Users\\x\\AppData\\Roaming\\org.encroissant.app\\engines\\";
        const winTo = "C:\\Users\\x\\AppData\\Roaming\\cn.chessin.app\\engines";
        expect(rewriteEnginePath(`${winFrom}sf\\sf.exe`, winFrom, winTo)).toBe(
            `${winTo}\\sf\\sf.exe`,
        );
        expect(
            rewriteEnginePath(
                "C:/Users/x/AppData/Roaming/org.encroissant.app/engines/sf.exe",
                winFrom,
                winTo,
            ),
        ).toBe(`${winTo}/sf.exe`);
    });

    it("leaves paths outside EC's engines dir unchanged", () => {
        expect(rewriteEnginePath("/usr/bin/stockfish", from, to)).toBe("/usr/bin/stockfish");
        expect(rewriteEnginePath(`${EC_DIR}/enginesX/sf`, from, to)).toBe(`${EC_DIR}/enginesX/sf`);
    });

    it("maps the directory itself", () => {
        expect(rewriteEnginePath(from, from, to)).toBe(to);
        expect(rewriteEnginePath(`${from}/`, from, to)).toBe(`${to}/`);
    });
});

describe("mergeEngines", () => {
    const from = `${EC_DIR}/engines`;
    const to = `${APP_DIR}/engines`;

    it("adds local engines with rewritten paths and keeps their settings", () => {
        const incoming = [
            {
                type: "local",
                id: "ec-1",
                name: "Stockfish",
                version: "17",
                path: `${from}/sf/sf`,
                elo: 3600,
                settings: [{ name: "Threads", value: 2 }],
                go: { t: "Depth", c: 30 },
                enabled: true,
                loaded: true,
            },
        ];
        const result = mergeEngines([], incoming, from, to);
        expect(result.added).toHaveLength(1);
        expect(result.skipped).toBe(0);
        expect(result.invalid).toBe(0);
        const engine = result.engines[0] as LocalEngine;
        expect(engine.path).toBe(`${to}/sf/sf`);
        expect(engine.id).toBe("ec-1");
        expect(engine.settings).toEqual([{ name: "Threads", value: 2 }]);
        expect(engine.go).toEqual({ t: "Depth", c: 30 });
        expect(engine.elo).toBe(3600);
        expect(engine.enabled).toBe(true);
    });

    it("skips engines whose path already exists and duplicates within the input", () => {
        const current: Engine[] = [local({ id: "c1", path: `${to}/sf/sf` })];
        const incoming = [
            { type: "local", id: "a", name: "A", version: "1", path: `${from}/sf/sf` },
            { type: "local", id: "b", name: "B", version: "1", path: `${from}/lc0/lc0` },
            { type: "local", id: "c", name: "C", version: "1", path: `${from}/lc0/lc0` },
            { type: "local", id: "d", name: "D", version: "1", path: "/usr/bin/sf" },
        ];
        const result = mergeEngines(current, incoming, from, to);
        expect(result.skipped).toBe(2);
        expect(result.added.map((e) => e.id)).toEqual(["b", "d"]);
        expect(result.engines.map((e) => e.id)).toEqual(["c1", "b", "d"]);
        expect((result.engines[1] as LocalEngine).path).toBe(`${to}/lc0/lc0`);
        expect((result.engines[2] as LocalEngine).path).toBe("/usr/bin/sf");
        expect(current).toHaveLength(1);
    });

    it("drops entries that do not match the schema and tolerates non-array input", () => {
        const incoming = [
            { type: "local", id: "x", name: "No path", version: "1" },
            "garbage",
            null,
            { type: "local", id: "ok", name: "Ok", version: "1", path: `${from}/ok` },
        ];
        const result = mergeEngines([], incoming, from, to);
        expect(result.invalid).toBe(3);
        expect(result.added.map((e) => e.id)).toEqual(["ok"]);
        expect(mergeEngines([], { not: "an array" }, from, to)).toEqual({
            engines: [],
            added: [],
            skipped: 0,
            invalid: 0,
        });
    });

    it("de-duplicates remote engines by url", () => {
        const current: Engine[] = [
            { type: "lichess", id: "r1", name: "Lichess", url: "https://lichess.org" },
        ];
        const incoming = [
            { type: "lichess", id: "r2", name: "Lichess Cloud", url: "https://lichess.org" },
            { type: "chessdb", id: "r3", name: "ChessDB", url: "https://chessdb.cn" },
        ];
        const result = mergeEngines(current, incoming, from, to);
        expect(result.skipped).toBe(1);
        expect(result.added.map((e) => e.id)).toEqual(["r3"]);
    });

    it("gives a colliding id a fresh uuid", () => {
        const current: Engine[] = [local({ id: "same", path: `${to}/a` })];
        const incoming = [
            { type: "local", id: "same", name: "B", version: "1", path: `${from}/b` },
        ];
        const result = mergeEngines(current, incoming, from, to);
        expect(result.added).toHaveLength(1);
        expect(result.added[0].id).not.toBe("same");
        expect(result.added[0].id).toMatch(/[0-9a-f-]{36}/);
    });

    it("counts local entries of an engines.json", () => {
        expect(
            countLocalEngines([
                { type: "local", id: "a", name: "A", version: "1", path: "/x" },
                { type: "lichess", id: "b", name: "B", url: "https://lichess.org" },
                { type: "local", id: "c", name: "C" },
            ]),
        ).toBe(1);
        expect(countLocalEngines("nope")).toBeNull();
    });
});

describe("detectEnCroissant", () => {
    it("returns null outside Tauri", async () => {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        seedEnCroissant();
        expect(await detectEnCroissant()).toBeNull();
    });

    it("returns null when EC's data directory does not exist", async () => {
        fakeFs.addDir(APP_DIR);
        expect(await detectEnCroissant()).toBeNull();
    });

    it("returns null when EC's directory is this app's own data directory", async () => {
        seedEnCroissant();
        paths.appDataDir = EC_DIR;
        expect(await detectEnCroissant()).toBeNull();
    });

    it("counts engines, databases and puzzles with their sizes", async () => {
        seedEnCroissant();
        const install = await detectEnCroissant();
        expect(install).not.toBeNull();
        expect(install?.dataDir).toBe(EC_DIR);
        expect(install?.databases).toEqual({ count: 2, bytes: 6000 });
        expect(install?.puzzles).toEqual({ count: 1, bytes: 300 });
        // Two local entries in engines.json; bytes cover every file below engines/.
        const enginesJsonSize = fakeFs.files.get(`${EC_DIR}/engines/engines.json`)?.size ?? 0;
        expect(install?.engines).toEqual({ count: 2, bytes: 10000 + enginesJsonSize });
        expect(install?.enginesJsonPath).toBe(`${EC_DIR}/engines/engines.json`);
        expect(hasMigratableData(install!)).toBe(true);
    });

    it("falls back to top-level engine folders without an engines.json", async () => {
        seedEnCroissant();
        fakeFs.files.delete(`${EC_DIR}/engines/engines.json`);
        const install = await detectEnCroissant();
        expect(install?.engines.count).toBe(2);
        expect(install?.enginesJsonPath).toBeUndefined();
    });

    it("reports an empty installation as not migratable", async () => {
        fakeFs.addDir(EC_DIR);
        fakeFs.addDir(`${EC_DIR}/db`);
        const install = await detectEnCroissant();
        expect(install).toEqual({
            dataDir: EC_DIR,
            engines: { count: 0, bytes: 0 },
            databases: { count: 0, bytes: 0 },
            puzzles: { count: 0, bytes: 0 },
        });
        expect(hasMigratableData(install!)).toBe(false);
    });
});

describe("migrateEnCroissant", () => {
    it("copies everything selected, merges engines.json and records the run", async () => {
        seedEnCroissant();
        const existing = local({
            id: "chessin-sf",
            name: "Stockfish 17",
            path: `${APP_DIR}/engines/stockfish/stockfish`,
        });
        seedChessin([existing]);
        const before = fakeFs.snapshot(EC_DIR);
        const progress: MigrationProgress[] = [];

        const report = await migrateEnCroissant({
            engines: true,
            databases: true,
            puzzles: true,
            onProgress: (p) => progress.push(p),
        });
        await flush();

        expect(report.failed).toEqual([]);
        // 2 db3 + 1 puzzle + 4 engine files (engines.json is merged, not copied)
        expect(report.copied).toBe(7);
        expect(report.skipped).toBe(0);
        expect(report.enginesAdded).toBe(2);

        const targets = fakeFs.copyLog.map(([, to]) => to).sort();
        expect(targets).toEqual(
            [
                `${APP_DIR}/db/lichess.db3`,
                `${APP_DIR}/db/masters.db3`,
                `${APP_DIR}/puzzles/lichess_puzzles.db3`,
                `${APP_DIR}/engines/stockfish/stockfish`,
                `${APP_DIR}/engines/stockfish/nn.nnue`,
                `${APP_DIR}/engines/lc0/lc0`,
                `${APP_DIR}/engines/lc0/weights/t1.pb.gz`,
            ].sort(),
        );
        expect(fakeFs.files.has(`${APP_DIR}/db/masters.db3-journal`)).toBe(false);
        expect(fakeFs.files.has(`${APP_DIR}/db/notes.txt`)).toBe(false);
        // EC's files are untouched and every write went below Chessin's dir.
        expect(fakeFs.snapshot(EC_DIR)).toEqual(before);
        expect(fakeFs.copyLog.every(([, to]) => to.startsWith(`${APP_DIR}/`))).toBe(true);

        // Progress: one call per file, then a final "done" call.
        expect(progress).toHaveLength(8);
        expect(progress[0]).toEqual({ file: "lichess.db3", done: 0, total: 7 });
        expect(progress[7]).toEqual({ file: "", done: 7, total: 7 });
        expect(progress.map((p) => p.file)).toContain("lc0/weights/t1.pb.gz");

        // engines.json merged into the atom: the duplicate (same rewritten path) is
        // skipped, Leela gets Chessin's path, the remote entry comes along, the
        // broken entry is dropped.
        const engines = getDefaultStore().get(enginesAtom) ?? [];
        expect(engines.map((e) => e.id)).toEqual(["chessin-sf", "ec-lc0", "ec-cloud"]);
        const leela = engines[1] as LocalEngine;
        expect(leela.path).toBe(`${APP_DIR}/engines/lc0/lc0`);
        expect(leela.settings).toEqual([{ name: "Hash", value: 512 }]);
        expect(leela.go).toEqual({ t: "Time", c: 5 });
        expect(chessinEnginesFile().map((e) => e.id)).toEqual(["chessin-sf", "ec-lc0", "ec-cloud"]);

        const done = await getKv(MIGRATE_DONE_KEY);
        expect(done).toBeTruthy();
        expect(Number.isNaN(new Date(done!).getTime())).toBe(false);
    });

    it("skips files that already exist with the same size", async () => {
        seedEnCroissant();
        seedChessin([]);
        fakeFs.addFile(`${APP_DIR}/db/lichess.db3`, "L", 1000);
        fakeFs.addFile(`${APP_DIR}/db/masters.db3`, "old", 4000);
        fakeFs.addFile(`${APP_DIR}/engines/stockfish/nn.nnue`, "W", 4000);

        const report = await migrateEnCroissant({ engines: true, databases: true, puzzles: true });
        await flush();

        expect(report.skipped).toBe(2);
        expect(report.copied).toBe(5);
        expect(report.failed).toEqual([]);
        expect(fakeFs.files.get(`${APP_DIR}/db/masters.db3`)?.size).toBe(5000);

        const again = await migrateEnCroissant({ engines: true, databases: true, puzzles: true });
        await flush();
        expect(again.copied).toBe(0);
        expect(again.skipped).toBe(7);
        expect(again.enginesAdded).toBe(0);
        expect(chessinEnginesFile().map((e) => e.id)).toEqual(["ec-sf", "ec-lc0", "ec-cloud"]);
    });

    it("records a failed copy and carries on", async () => {
        seedEnCroissant();
        seedChessin([]);
        fakeFs.state.failCopyOf = `${EC_DIR}/engines/lc0/lc0`;

        const report = await migrateEnCroissant({
            engines: true,
            databases: false,
            puzzles: false,
        });
        await flush();

        expect(report.failed).toEqual([{ path: `${EC_DIR}/engines/lc0/lc0`, error: "EACCES" }]);
        expect(report.copied).toBe(3);
        expect(fakeFs.files.has(`${APP_DIR}/engines/lc0/weights/t1.pb.gz`)).toBe(true);
        expect(await getKv(MIGRATE_DONE_KEY)).toBeTruthy();
    });

    it("only touches the selected categories", async () => {
        seedEnCroissant();
        seedChessin([]);

        const report = await migrateEnCroissant({
            engines: false,
            databases: true,
            puzzles: false,
        });
        await flush();

        expect(report.copied).toBe(2);
        expect(report.enginesAdded).toBe(0);
        expect(fakeFs.copyLog.map(([, to]) => to).sort()).toEqual([
            `${APP_DIR}/db/lichess.db3`,
            `${APP_DIR}/db/masters.db3`,
        ]);
        expect(chessinEnginesFile()).toEqual([]);
    });

    it("skips copying when Chessin already uses EC's folders", async () => {
        seedEnCroissant();
        seedChessin([]);
        localStorage.setItem("databases-dir", JSON.stringify(`${EC_DIR}/db`));

        const report = await migrateEnCroissant({
            engines: false,
            databases: true,
            puzzles: false,
        });
        expect(report).toEqual({ copied: 0, skipped: 2, failed: [], enginesAdded: 0 });
        expect(fakeFs.copyLog).toEqual([]);
    });

    it("throws when there is nothing to migrate from", async () => {
        fakeFs.addDir(APP_DIR);
        await expect(
            migrateEnCroissant({ engines: true, databases: true, puzzles: true }),
        ).rejects.toThrow(/not found/);
    });
});
