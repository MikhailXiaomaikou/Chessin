import { atom, useAtom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import type { SyncStorage } from "jotai/vanilla/utils/atomWithStorage";
import { useCallback } from "react";
import { z } from "zod";
import { createZodStorage } from "@/state/utils";

/**
 * Chessin sources (IA-3 v0, UX problem #9).
 *
 * A *source* is where position statistics come from: a local database
 * ("collection"), the Lichess Masters explorer, the Lichess games explorer
 * filtered to the player's level, or (reserved, not offered in the UI yet)
 * chessdb.cn.
 *
 * En Croissant kept a hidden `referenceDbAtom`; while it was unset the
 * explorer, novelty detection and repertoire coverage silently stopped
 * working. Here there is always a resolved source: a persisted default
 * (`defaultSourceAtom`, Lichess Masters out of the box, no login needed)
 * that every board tab may override (`tabSourceAtomFamily`). Features that
 * need a *local* database degrade with a hint instead of blocking.
 */

export const sourceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("local"),
        path: z.string().min(1),
        title: z.string(),
    }),
    z.object({ kind: z.literal("lichess-masters") }),
    z.object({
        kind: z.literal("lichess"),
        ratings: z.array(z.number()).optional(),
        speeds: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal("chessdb") }),
    // S4-4: a Polyglot opening book (the explorer shows its weighted moves).
    z.object({
        kind: z.literal("book"),
        path: z.string().min(1),
        title: z.string(),
    }),
    // S4-4: a directory of Syzygy tables; probed by the tablebase panel, not the explorer.
    z.object({
        kind: z.literal("tablebase-local"),
        dir: z.string().min(1),
    }),
]);

export type Source = z.infer<typeof sourceSchema>;
export type SourceKind = Source["kind"];
export type LocalSource = Extract<Source, { kind: "local" }>;
export type BookSource = Extract<Source, { kind: "book" }>;
export type TablebaseSource = Extract<Source, { kind: "tablebase-local" }>;

export const DEFAULT_SOURCE_STORAGE_KEY = "chessin.defaultSource";

/** localStorage keys En Croissant used for the hidden reference database. */
const LEGACY_REFERENCE_DB_KEYS = ["reference-database", "reference-db"] as const;

/** What a fresh profile gets: anonymous Lichess Masters, no login required. */
export const DEFAULT_SOURCE: Source = { kind: "lichess-masters" };

export function titleFromPath(path: string): string {
    const name = path.split(/[\\/]/).pop() ?? path;
    return name.replace(/\.db3$/i, "") || path;
}

export function localSource(path: string, title?: string): LocalSource {
    return { kind: "local", path, title: title ?? titleFromPath(path) };
}

/** `Perfect2023.bin` → `Perfect2023`, `Book.ctg` → `Book`. */
export function titleFromBookPath(path: string): string {
    const name = path.split(/[\\/]/).pop() ?? path;
    return name.replace(/\.(bin|ctg)$/i, "") || path;
}

export function bookSource(path: string, title?: string): BookSource {
    return { kind: "book", path, title: title ?? titleFromBookPath(path) };
}

export function tablebaseSource(dir: string): TablebaseSource {
    return { kind: "tablebase-local", dir };
}

/** Stable identity. Two `lichess` sources with different filters are the same source. */
export function sourceKey(source: Source): string {
    switch (source.kind) {
        case "local":
            return `local:${source.path}`;
        case "book":
            return `book:${source.path}`;
        case "tablebase-local":
            return `tablebase-local:${source.dir}`;
        default:
            return source.kind;
    }
}

/** Sources that need the network (the offline badge applies to them). */
export function isOnlineSource(source: Source): boolean {
    return (
        source.kind === "lichess" || source.kind === "lichess-masters" || source.kind === "chessdb"
    );
}

export function sameSource(a: Source, b: Source): boolean {
    return sourceKey(a) === sourceKey(b);
}

export function localPathOf(source: Source): string | null {
    return source.kind === "local" ? source.path : null;
}

/**
 * The local database a feature that needs one (novelty detection, repertoire
 * coverage) should use: the tab's source when it is local, otherwise the
 * default when that is local, otherwise none.
 */
export function resolveLocalPath(tabSource: Source, defaultSource: Source): string | null {
    return localPathOf(tabSource) ?? localPathOf(defaultSource);
}

export function sourceLabel(source: Source, t: (key: string) => string): string {
    switch (source.kind) {
        case "local":
            return source.title;
        case "lichess-masters":
            return t("Sources.LichessMasters");
        case "lichess":
            return t("Sources.LichessMyLevel");
        case "chessdb":
            return "chessdb.cn";
        case "book":
            return source.title;
        case "tablebase-local":
            return t("Tablebase.LocalSource");
    }
}

/**
 * Reads En Croissant's hidden reference database (a JSON-encoded path) so an
 * upgraded profile keeps its source. Returns null when nothing usable is stored.
 */
export function readLegacyReferenceDb(
    storage: Pick<Storage, "getItem"> = localStorage,
): LocalSource | null {
    for (const key of LEGACY_REFERENCE_DB_KEYS) {
        try {
            const raw = storage.getItem(key);
            if (raw === null) continue;
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === "string" && parsed.length > 0) {
                return localSource(parsed);
            }
        } catch {
            // not JSON / storage unavailable: ignore and try the next key
        }
    }
    return null;
}

function createDefaultSourceStorage(): SyncStorage<Source> {
    const base = createZodStorage(sourceSchema, localStorage);
    return {
        getItem(key, initialValue) {
            if (localStorage.getItem(key) === null) {
                const migrated = readLegacyReferenceDb();
                if (migrated) {
                    base.setItem(key, migrated);
                    return migrated;
                }
                return initialValue;
            }
            return base.getItem(key, initialValue);
        },
        setItem(key, value) {
            base.setItem(key, value);
        },
        removeItem(key) {
            base.removeItem(key);
        },
    };
}

/** The app-wide default source. Persisted; seeded from the legacy reference database once. */
export const defaultSourceAtom = atomWithStorage<Source>(
    DEFAULT_SOURCE_STORAGE_KEY,
    DEFAULT_SOURCE,
    createDefaultSourceStorage(),
    { getOnInit: true },
);

/** Path of the default source when it is a local database, else null. */
export const defaultLocalPathAtom = atom((get) => localPathOf(get(defaultSourceAtom)));

const tabSourceOverrideFamily = atomFamily((_tab: string) => atom<Source | null>(null));

/**
 * The source of one board tab. Reads the tab's own choice, falling back to the
 * default. Writing `null` makes the tab follow the default again.
 */
export const tabSourceAtomFamily = atomFamily((tab: string) =>
    atom(
        (get) => get(tabSourceOverrideFamily(tab)) ?? get(defaultSourceAtom),
        (_get, set, value: Source | null) => set(tabSourceOverrideFamily(tab), value),
    ),
);

/** Local database for a tab's local-only features; see `resolveLocalPath`. */
export const tabLocalPathAtomFamily = atomFamily((tab: string) =>
    atom((get) => resolveLocalPath(get(tabSourceAtomFamily(tab)), get(defaultSourceAtom))),
);

export function useResolvedSource(tabId: string) {
    const [source, setTabSource] = useAtom(tabSourceAtomFamily(tabId));
    const [defaultSource, setDefaultSource] = useAtom(defaultSourceAtom);
    const isDefault = sameSource(source, defaultSource);

    /** Picks a source for this tab; choosing the default again un-pins the tab. */
    const setSource = useCallback(
        (next: Source) => setTabSource(sameSource(next, defaultSource) ? null : next),
        [defaultSource, setTabSource],
    );

    /** Makes this tab's source the app-wide default and un-pins the tab. */
    const setAsDefault = useCallback(() => {
        setDefaultSource(source);
        setTabSource(null);
    }, [source, setDefaultSource, setTabSource]);

    const useDefault = useCallback(() => setTabSource(null), [setTabSource]);

    return {
        source,
        defaultSource,
        isDefault,
        setSource,
        setDefault: setDefaultSource,
        setAsDefault,
        useDefault,
    };
}
