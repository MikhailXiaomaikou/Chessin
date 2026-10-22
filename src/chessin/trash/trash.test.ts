import { describe, expect, it } from "vitest";
import { buildTrashNotices, capLines, NOTICE_MAX_LINES, type TrashResult } from "./notice";
import {
    databaseIndexPath,
    expandTrashPaths,
    pgnSidecarPath,
    sidePathsFor,
    type TrashItem,
} from "./paths";

// Fake translator: returns the key, with `{{number}}` appended so the
// collapsed tail is checkable.
const t = (key: string, options?: Record<string, unknown>) =>
    options && "number" in options ? `${key}:${options.number}` : key;

const file = (path: string, name = path): TrashItem => ({ kind: "file", path, name });
const db = (path: string, name = path): TrashItem => ({ kind: "database", path, name });
const dir = (path: string, name = path): TrashItem => ({ kind: "directory", path, name });

describe("trash side-file expansion", () => {
    it("pairs a .pgn with its .info sidecar, replacing only the trailing extension", () => {
        expect(pgnSidecarPath("/docs/my.pgn.games.pgn")).toBe("/docs/my.pgn.games.info");
        expect(pgnSidecarPath("/docs/notes.txt")).toBeNull();
        expect(sidePathsFor(file("/docs/a.pgn"))).toEqual(["/docs/a.info"]);
        expect(sidePathsFor(file("/docs/a.txt"))).toEqual([]);
    });

    it("expands a database into -wal, -shm and the .ecsi search index", () => {
        expect(sidePathsFor(db("/dbs/master.db3"))).toEqual([
            "/dbs/master.db3-wal",
            "/dbs/master.db3-shm",
            "/dbs/master.ecsi",
        ]);
    });

    it("derives the index path like Rust's with_extension", () => {
        expect(databaseIndexPath("C:\\Users\\me\\x.y.db3")).toBe("C:\\Users\\me\\x.y.ecsi");
        expect(databaseIndexPath("/dbs/noext")).toBe("/dbs/noext.ecsi");
        expect(databaseIndexPath("/dbs/.hidden")).toBe("/dbs/.hidden.ecsi");
        expect(databaseIndexPath("/dbs.d/plain")).toBe("/dbs.d/plain.ecsi");
    });

    it("directories have no side files", () => {
        expect(sidePathsFor(dir("/docs/openings"))).toEqual([]);
    });

    it("lists primary paths first and side paths without duplicates", () => {
        const items = [file("/docs/a.pgn"), file("/docs/a.pgn"), db("/dbs/m.db3")];
        expect(expandTrashPaths(items)).toEqual({
            primary: ["/docs/a.pgn", "/dbs/m.db3"],
            side: ["/docs/a.info", "/dbs/m.db3-wal", "/dbs/m.db3-shm", "/dbs/m.ecsi"],
        });
    });
});

describe("trash notice text", () => {
    const base: TrashResult = { mode: "trash", moved: [], failed: [], leftovers: [] };

    it("says the items went to the system recycle bin and lists them", () => {
        const notices = buildTrashNotices(
            { ...base, moved: [file("/docs/a.pgn", "a"), dir("/docs/b", "b")] },
            t,
        );
        expect(notices).toEqual([{ title: "Trash.Moved", lines: ["a", "b"], color: "green" }]);
    });

    it("says it when the fallback deleted permanently", () => {
        const notices = buildTrashNotices(
            { ...base, mode: "permanent", moved: [db("/dbs/m.db3", "Masters")] },
            t,
        );
        expect(notices).toEqual([
            { title: "Trash.DeletedPermanently", lines: ["Masters"], color: "yellow" },
        ]);
    });

    it("adds a red notice for failures and leftover side files", () => {
        const notices = buildTrashNotices(
            {
                ...base,
                moved: [file("/docs/a.pgn", "a")],
                failed: [file("/docs/b.pgn", "b")],
                leftovers: ["/docs/a.info"],
            },
            t,
        );
        expect(notices).toHaveLength(2);
        expect(notices[1]).toEqual({
            title: "Trash.Failed",
            lines: ["b", "/docs/a.info"],
            color: "red",
        });
    });

    it("emits nothing for an empty result", () => {
        expect(buildTrashNotices(base, t)).toEqual([]);
    });

    it("collapses long lists into '...and N more'", () => {
        const names = Array.from({ length: NOTICE_MAX_LINES + 3 }, (_, i) => `f${i}`);
        const lines = capLines(names, t);
        expect(lines).toHaveLength(NOTICE_MAX_LINES + 1);
        expect(lines.at(-1)).toBe("Trash.MoreItems:3");
        expect(capLines(names.slice(0, NOTICE_MAX_LINES), t)).toEqual(
            names.slice(0, NOTICE_MAX_LINES),
        );
    });
});
