/**
 * Pure path helpers for the trash flow (no Tauri imports so they can be unit
 * tested).
 *
 * A "trash item" is one logical thing the user asked to delete; moving it may
 * involve several on-disk paths (the entry itself plus its side files).
 */

export type TrashItemKind = "file" | "directory" | "database";

export type TrashItem = {
    kind: TrashItemKind;
    /** Absolute path of the primary entry. */
    path: string;
    /** Display name used in notices and confirm dialogs. */
    name: string;
};

/** SQLite side files that must leave together with the database. */
export const DATABASE_SIDE_SUFFIXES = ["-wal", "-shm"] as const;

/** `foo.pgn` -> `foo.info` (only a trailing `.pgn` is replaced). */
export function pgnSidecarPath(path: string): string | null {
    return path.endsWith(".pgn") ? `${path.slice(0, -".pgn".length)}.info` : null;
}

/**
 * `foo.db3` -> `foo.ecsi`: the search index the backend keeps next to a
 * database (mirrors Rust `Path::with_extension("ecsi")`).
 */
export function databaseIndexPath(path: string): string {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dot = path.lastIndexOf(".");
    // A leading dot in the basename is not an extension (`.hidden` -> `.hidden.ecsi`).
    const base = dot > slash + 1 ? path.slice(0, dot) : path;
    return `${base}.ecsi`;
}

/**
 * Side files that travel with the primary path. They may not exist on disk;
 * the runtime wrapper filters them with `exists()` before calling the backend.
 */
export function sidePathsFor(item: TrashItem): string[] {
    switch (item.kind) {
        case "file": {
            const sidecar = pgnSidecarPath(item.path);
            return sidecar ? [sidecar] : [];
        }
        case "database":
            return [
                ...DATABASE_SIDE_SUFFIXES.map((suffix) => `${item.path}${suffix}`),
                databaseIndexPath(item.path),
            ];
        case "directory":
            return [];
    }
}

/** Primary paths first, then every side path, without duplicates. */
export function expandTrashPaths(items: TrashItem[]): { primary: string[]; side: string[] } {
    const primary = [...new Set(items.map((item) => item.path))];
    const primarySet = new Set(primary);
    const side = [...new Set(items.flatMap(sidePathsFor).filter((path) => !primarySet.has(path)))];
    return { primary, side };
}
