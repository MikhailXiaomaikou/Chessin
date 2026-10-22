import { open } from "@tauri-apps/plugin-dialog";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { registerCommands } from "@/chessin/commands/registry";
import { bookSource, tabSourceAtomFamily } from "@/chessin/sources/sources";
import { currentTabAtom } from "@/state/atoms";
import { addBook, type BookEntry, bookListAtom, loadBooks } from "./books";
import { tablebaseDirAtom } from "./tablebase";

type Store = ReturnType<typeof getDefaultStore>;

let unregister: (() => void) | null = null;
let unregisterBooks: (() => void) | null = null;

function useBookInCurrentTab(store: Store, entry: BookEntry): void {
    const tab = store.get(currentTabAtom);
    if (!tab) return;
    store.set(tabSourceAtomFamily(tab.value), bookSource(entry.path, entry.title));
}

/** One "使用开局书：X" command per stored book; replaced whenever the list changes. */
function syncBookCommands(store: Store): void {
    unregisterBooks?.();
    const books = store.get(bookListAtom);
    unregisterBooks =
        books.length === 0
            ? null
            : registerCommands(
                  books.map((book) => ({
                      id: `book.use:${book.path}`,
                      title: () => i18n.t("Book.Use", { title: book.title }),
                      section: "sources",
                      aliases: [book.title, "开局书", "opening book"],
                      enabled: () => store.get(currentTabAtom) !== undefined,
                      run: () => useBookInCurrentTab(store, book),
                  })),
              );
}

/**
 * Palette commands for books and tablebases (S4-4): `book.add` (file picker
 * → stored in kv `sources.books` and used by the current tab),
 * `book.use:<path>` per stored book, `tablebase.setDir` (directory picker →
 * `tablebaseDirAtom`). Idempotent; the first caller registers.
 */
export function registerBookCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();

    const base = registerCommands([
        {
            id: "book.add",
            title: () => i18n.t("Book.AddBook"),
            section: "sources",
            aliases: ["开局书", "添加开局书", "opening book", "polyglot", "bin", "ctg"],
            run: async () => {
                const selected = await open({
                    multiple: false,
                    directory: false,
                    filters: [{ name: i18n.t("Book.FileFilter"), extensions: ["bin", "ctg"] }],
                });
                if (!selected || typeof selected !== "string") return;
                const entry = await addBook(selected);
                useBookInCurrentTab(store, entry);
            },
        },
        {
            id: "tablebase.setDir",
            title: () => i18n.t("Tablebase.SetDir"),
            section: "sources",
            aliases: ["残局库", "残局库目录", "tablebase", "syzygy", "endgame"],
            run: async () => {
                const selected = await open({ multiple: false, directory: true });
                if (!selected || typeof selected !== "string") return;
                store.set(tablebaseDirAtom, selected);
            },
        },
    ]);
    const unsubscribe = store.sub(bookListAtom, () => syncBookCommands(store));
    void loadBooks().then(() => syncBookCommands(store));

    unregister = () => {
        base();
        unsubscribe();
        unregisterBooks?.();
        unregisterBooks = null;
        unregister = null;
    };
    return unregister;
}
