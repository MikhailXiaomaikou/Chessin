import type { Directory, FileMetadata } from "@/components/files/file";

export type FileEntry = FileMetadata | Directory;

/**
 * Chessin shell (S3-6): the repertoire files of the document folder.
 *
 * A repertoire is still an En Croissant PGN file whose `.info` sidecar says
 * `type: "repertoire"` (`src/utils/repertoire.ts`, `CreateRepertoireModal`).
 * This flattens the directory tree the files page reads, keeps those files
 * and lists the most recently modified first (ties by name).
 */
export function collectRepertoires(entries: readonly FileEntry[]): FileMetadata[] {
    const found: FileMetadata[] = [];
    const walk = (list: readonly FileEntry[]) => {
        for (const entry of list) {
            if (entry.type === "directory") {
                walk(entry.children);
            } else if (entry.metadata.type === "repertoire") {
                found.push(entry);
            }
        }
    };
    walk(entries);
    return found.sort(
        (a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name, undefined),
    );
}
