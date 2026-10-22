/**
 * Chessin save model (pure helpers, no React / Tauri imports).
 *
 * Where a tab's game came from decides what "save" means:
 *
 * - `file` / `database`: an external source (PGN file, .db3 game). Chessin
 *   mounts it **read-only**: the document is edited freely, but nothing is
 *   ever written back unless the user explicitly asks (Ctrl/Cmd+S opens a
 *   choice between "save to source" and "copy into library").
 * - `library`: a Chessin-owned document in `library.sqlite`. It is the only
 *   origin that autosave applies to (the workspace store writes it ≤ 500 ms
 *   after each change); Ctrl/Cmd+S creates a named checkpoint instead.
 * - `temp_file` / `none`: scratch tabs. Never auto-saved; Ctrl/Cmd+S asks
 *   for a PGN path (unchanged behaviour).
 */
import type { GameOrigin, Tab } from "@/utils/tabs";

export type ReadOnlySourceKind = "file" | "database";

/** True when the tab's game comes from an external file or a .db3 game. */
export function isReadOnlySource(tab: Tab | null | undefined): boolean {
    const kind = tab?.gameOrigin.kind;
    return kind === "file" || kind === "database";
}

/** True when the tab is a Chessin-owned library document. */
export function isLibraryOrigin(tab: Tab | null | undefined): boolean {
    return tab?.gameOrigin.kind === "library";
}

/**
 * Whether the autosave toggle has any effect on this tab. Only library
 * documents are written automatically; every other origin needs an explicit
 * save.
 */
export function shouldAutoSave(tab: Tab | null | undefined, autoSave: boolean): boolean {
    return autoSave && isLibraryOrigin(tab);
}

/** Returns a copy of `tab` whose origin points at the library document `docId`. */
export function retargetTabToLibrary(tab: Tab, docId: string): Tab {
    return {
        ...tab,
        gameOrigin: { kind: "library", docId },
    };
}

/**
 * The library document id a tab is (or would be) stored under. The workspace
 * store persists every tab's tree as `doc_put(id = tab.value)`, so copying a
 * tab into the library keeps that id and only re-targets the origin; a tab
 * already in the library keeps its `docId`.
 */
export function libraryDocIdFor(tab: Tab): string {
    return tab.gameOrigin.kind === "library" ? tab.gameOrigin.docId : tab.value;
}

/**
 * Stable text form of an origin for the `documents.origin` column, so the
 * library can show where a copied document came from. `null` for scratch
 * tabs and for documents that already live in the library.
 */
export function originToString(origin: GameOrigin): string | null {
    switch (origin.kind) {
        case "file":
        case "temp_file":
            return `file:${origin.file.path}#${origin.gameNumber}`;
        case "database":
            return `database:${origin.database}#${origin.gameId}`;
        case "library":
        case "none":
            return null;
    }
}

/** What the Save dialog describes as the source, independent of i18n. */
export type SourceDescription =
    | { kind: "file"; name: string; path: string; gameNumber: number }
    | { kind: "database"; name: string; path: string; gameId: number }
    | null;

export function describeSource(tab: Tab | null | undefined): SourceDescription {
    const origin = tab?.gameOrigin;
    if (!origin) return null;
    if (origin.kind === "file") {
        return {
            kind: "file",
            name: baseName(origin.file.path),
            path: origin.file.path,
            gameNumber: origin.gameNumber,
        };
    }
    if (origin.kind === "database") {
        return {
            kind: "database",
            name: baseName(origin.database),
            path: origin.database,
            gameId: origin.gameId,
        };
    }
    return null;
}

function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}
