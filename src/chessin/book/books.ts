import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useEffect } from "react";
import { commands } from "@/chessin/bindings";
import { type BookSource, bookSource, titleFromBookPath } from "@/chessin/sources/sources";
import { getKv, setKv } from "@/chessin/store/libraryStore";

/**
 * The user's opening books (S4-4): a list in the library's kv table under
 * `sources.books`, mirrored into `bookListAtom` so the palette and the
 * explorer see it. A book is a Polyglot `.bin` file; `.ctg` files are
 * listed (with `format: "ctg"`) but cannot be read yet.
 */

export const BOOKS_KV_KEY = "sources.books";

export type BookFormat = "polyglot" | "ctg" | "unknown";

export type BookEntry = {
    path: string;
    title: string;
    format: BookFormat;
    /** Polyglot entries; null for CTG or when unknown. */
    entries: number | null;
    bytes: number;
    addedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function toFormat(value: unknown): BookFormat {
    return value === "polyglot" || value === "ctg" ? value : "unknown";
}

/** Reads the stored list, dropping anything that is not a usable entry. */
export function parseBookList(raw: string | null): BookEntry[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: BookEntry[] = [];
    for (const item of parsed) {
        if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0) continue;
        out.push({
            path: item.path,
            title:
                typeof item.title === "string" && item.title.length > 0
                    ? item.title
                    : titleFromBookPath(item.path),
            format: toFormat(item.format),
            entries: typeof item.entries === "number" ? item.entries : null,
            bytes: typeof item.bytes === "number" ? item.bytes : 0,
            addedAt: typeof item.addedAt === "number" ? item.addedAt : 0,
        });
    }
    return out;
}

export function serializeBookList(list: BookEntry[]): string {
    return JSON.stringify(list);
}

/** The list with `entry` added, or replacing the entry of the same path in place. */
export function withBook(list: BookEntry[], entry: BookEntry): BookEntry[] {
    const i = list.findIndex((b) => b.path === entry.path);
    if (i === -1) return [...list, entry];
    return list.map((b, j) => (j === i ? entry : b));
}

export function withoutBook(list: BookEntry[], path: string): BookEntry[] {
    return list.filter((b) => b.path !== path);
}

export function bookSourceOf(entry: BookEntry): BookSource {
    return bookSource(entry.path, entry.title);
}

/** The stored books; hydrated from kv by `loadBooks`. */
export const bookListAtom = atom<BookEntry[]>([]);

let loaded: Promise<BookEntry[]> | null = null;

/** Reads the list from kv once and publishes it to `bookListAtom`. */
export function loadBooks(): Promise<BookEntry[]> {
    if (!loaded) {
        loaded = getKv(BOOKS_KV_KEY)
            .then((raw) => {
                const list = parseBookList(raw);
                getDefaultStore().set(bookListAtom, list);
                return list;
            })
            .catch(() => {
                loaded = null;
                return [];
            });
    }
    return loaded;
}

async function saveBooks(list: BookEntry[]): Promise<void> {
    getDefaultStore().set(bookListAtom, list);
    loaded = Promise.resolve(list);
    await setKv(BOOKS_KV_KEY, serializeBookList(list));
}

/** Inspects the file with `book_info` and stores it (replacing a same-path entry). */
export async function addBook(path: string, now: number = Date.now()): Promise<BookEntry> {
    const info = await commands.bookInfo(path);
    if (info.status === "error") throw new Error(info.error);
    const entry: BookEntry = {
        path,
        title: titleFromBookPath(path),
        format: toFormat(info.data.format),
        entries: info.data.entries === null ? null : Number(info.data.entries),
        bytes: Number(info.data.bytes),
        addedAt: now,
    };
    const list = await loadBooks();
    await saveBooks(withBook(list, entry));
    return entry;
}

export async function removeBook(path: string): Promise<void> {
    const list = await loadBooks();
    await saveBooks(withoutBook(list, path));
}

/** The stored books, loading them on first use. */
export function useBooks(): BookEntry[] {
    const books = useAtomValue(bookListAtom);
    useEffect(() => {
        void loadBooks();
    }, []);
    return books;
}

/** Test hook: forgets the loaded list so the next `loadBooks` reads kv again. */
export function __resetBooksForTests(): void {
    loaded = null;
    getDefaultStore().set(bookListAtom, []);
}
