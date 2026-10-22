import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    bookSource,
    isOnlineSource,
    localPathOf,
    localSource,
    sameSource,
    type Source,
    sourceKey,
    sourceLabel,
    sourceSchema,
    tablebaseSource,
    titleFromBookPath,
} from "@/chessin/sources/sources";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import {
    __resetBooksForTests,
    addBook,
    BOOKS_KV_KEY,
    type BookEntry,
    bookListAtom,
    bookSourceOf,
    loadBooks,
    parseBookList,
    removeBook,
    serializeBookList,
    withBook,
    withoutBook,
} from "./books";

const mocks = vi.hoisted(() => ({
    bookInfo: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/chessin/bindings", () => ({
    commands: {
        bookInfo: (path: string) => mocks.bookInfo(path),
    },
}));

const entry = (path: string, extra: Partial<BookEntry> = {}): BookEntry => ({
    path,
    title: titleFromBookPath(path),
    format: "polyglot",
    entries: 10,
    bytes: 160,
    addedAt: 1,
    ...extra,
});

describe("source kinds", () => {
    const t = (key: string) => `t:${key}`;

    it("maps a book path to a titled book source", () => {
        expect(titleFromBookPath("/books/Perfect2023.bin")).toBe("Perfect2023");
        expect(titleFromBookPath("C:\\Books\\Hiarcs.CTG")).toBe("Hiarcs");
        expect(titleFromBookPath("plain")).toBe("plain");
        expect(bookSource("/books/Perfect2023.bin")).toEqual({
            kind: "book",
            path: "/books/Perfect2023.bin",
            title: "Perfect2023",
        });
        expect(bookSource("/b.bin", "Mine").title).toBe("Mine");
        expect(tablebaseSource("/tb")).toEqual({ kind: "tablebase-local", dir: "/tb" });
    });

    it("gives the new kinds stable keys and keeps the old ones", () => {
        expect(sourceKey(bookSource("/a.bin"))).toBe("book:/a.bin");
        expect(sourceKey(tablebaseSource("/tb"))).toBe("tablebase-local:/tb");
        expect(sourceKey(localSource("/db.db3"))).toBe("local:/db.db3");
        expect(sourceKey({ kind: "lichess-masters" })).toBe("lichess-masters");
        expect(sourceKey({ kind: "lichess", ratings: [2000] })).toBe("lichess");
        expect(sameSource(bookSource("/a.bin", "x"), bookSource("/a.bin", "y"))).toBe(true);
        expect(sameSource(bookSource("/a.bin"), localSource("/a.bin"))).toBe(false);
    });

    it("is not a local database and not online", () => {
        expect(localPathOf(bookSource("/a.bin"))).toBeNull();
        expect(localPathOf(tablebaseSource("/tb"))).toBeNull();
        expect(isOnlineSource(bookSource("/a.bin"))).toBe(false);
        expect(isOnlineSource(tablebaseSource("/tb"))).toBe(false);
        expect(isOnlineSource({ kind: "lichess-masters" })).toBe(true);
        expect(isOnlineSource(localSource("/db.db3"))).toBe(false);
    });

    it("labels a book by its title and the tablebase dir by a key", () => {
        expect(sourceLabel(bookSource("/a.bin", "Perfect"), t)).toBe("Perfect");
        expect(sourceLabel(tablebaseSource("/tb"), t)).toBe("t:Tablebase.LocalSource");
        expect(sourceLabel({ kind: "lichess-masters" }, t)).toBe("t:Sources.LichessMasters");
    });

    it("parses persisted sources of every kind", () => {
        const stored: Source[] = [
            { kind: "local", path: "/db.db3", title: "DB" },
            { kind: "lichess-masters" },
            { kind: "lichess", speeds: ["blitz"] },
            { kind: "chessdb" },
            { kind: "book", path: "/a.bin", title: "A" },
            { kind: "tablebase-local", dir: "/tb" },
        ];
        for (const s of stored) expect(sourceSchema.parse(s)).toEqual(s);
        expect(sourceSchema.safeParse({ kind: "book", path: "", title: "" }).success).toBe(false);
        expect(sourceSchema.safeParse({ kind: "tablebase-local" }).success).toBe(false);
    });
});

describe("book list", () => {
    it("parses a stored list tolerantly", () => {
        expect(parseBookList(null)).toEqual([]);
        expect(parseBookList("")).toEqual([]);
        expect(parseBookList("not json")).toEqual([]);
        expect(parseBookList('{"a":1}')).toEqual([]);
        const parsed = parseBookList(
            JSON.stringify([
                {
                    path: "/a.bin",
                    title: "A",
                    format: "polyglot",
                    entries: 5,
                    bytes: 80,
                    addedAt: 9,
                },
                { path: "/b.ctg", format: "ctg" },
                { path: "", title: "nope" },
                "junk",
                { title: "no path" },
            ]),
        );
        expect(parsed).toEqual([
            { path: "/a.bin", title: "A", format: "polyglot", entries: 5, bytes: 80, addedAt: 9 },
            { path: "/b.ctg", title: "b", format: "ctg", entries: null, bytes: 0, addedAt: 0 },
        ]);
        expect(parseBookList(serializeBookList(parsed))).toEqual(parsed);
    });

    it("adds, replaces and removes by path", () => {
        const a = entry("/a.bin");
        const b = entry("/b.bin");
        expect(withBook([], a)).toEqual([a]);
        expect(withBook([a], b)).toEqual([a, b]);
        const a2 = entry("/a.bin", { entries: 99 });
        expect(withBook([a, b], a2)).toEqual([a2, b]);
        expect(withoutBook([a, b], "/a.bin")).toEqual([b]);
        expect(withoutBook([a, b], "/zzz")).toEqual([a, b]);
        expect(bookSourceOf(a)).toEqual({ kind: "book", path: "/a.bin", title: "a" });
    });
});

describe("addBook / loadBooks", () => {
    const store = getDefaultStore();

    beforeEach(() => {
        __setLibraryBackendForTests(createMemoryBackend());
        __resetBooksForTests();
        mocks.bookInfo.mockReset();
    });

    afterEach(() => {
        __setLibraryBackendForTests(null);
        __resetBooksForTests();
    });

    it("inspects the file, stores it in kv and publishes the atom", async () => {
        mocks.bookInfo.mockResolvedValue({
            status: "ok",
            data: { format: "polyglot", entries: BigInt(1234), bytes: BigInt(19744) },
        });
        const added = await addBook("/books/Perfect.bin", 42);
        expect(added).toEqual({
            path: "/books/Perfect.bin",
            title: "Perfect",
            format: "polyglot",
            entries: 1234,
            bytes: 19744,
            addedAt: 42,
        });
        expect(mocks.bookInfo).toHaveBeenCalledWith("/books/Perfect.bin");
        expect(store.get(bookListAtom)).toEqual([added]);
        expect(parseBookList(await getKv(BOOKS_KV_KEY))).toEqual([added]);

        // A CTG file is listed, with no entry count; adding again replaces.
        mocks.bookInfo.mockResolvedValue({
            status: "ok",
            data: { format: "ctg", entries: null, bytes: BigInt(5) },
        });
        const ctg = await addBook("/books/Hiarcs.ctg", 43);
        expect(ctg.format).toBe("ctg");
        expect(ctg.entries).toBeNull();
        const again = await addBook("/books/Perfect.bin", 44);
        expect(store.get(bookListAtom).map((b) => b.path)).toEqual([
            "/books/Perfect.bin",
            "/books/Hiarcs.ctg",
        ]);
        expect(again.addedAt).toBe(44);

        await removeBook("/books/Hiarcs.ctg");
        expect(store.get(bookListAtom).map((b) => b.path)).toEqual(["/books/Perfect.bin"]);

        // A fresh load reads what was persisted.
        __resetBooksForTests();
        expect(store.get(bookListAtom)).toEqual([]);
        expect((await loadBooks()).map((b) => b.path)).toEqual(["/books/Perfect.bin"]);
        expect(store.get(bookListAtom)).toHaveLength(1);
    });

    it("surfaces a book_info error and stores nothing", async () => {
        mocks.bookInfo.mockResolvedValue({ status: "error", error: "missing.bin: not found" });
        await expect(addBook("/missing.bin")).rejects.toThrow("missing.bin");
        expect(store.get(bookListAtom)).toEqual([]);
        expect(await getKv(BOOKS_KV_KEY)).toBeNull();
    });
});
