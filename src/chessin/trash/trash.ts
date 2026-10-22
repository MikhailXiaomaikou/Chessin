/**
 * Runtime wrapper around the `move_to_trash` plugin command (S1b-1).
 *
 * Contract: `commands.moveToTrash(paths: string[]): Promise<string[]>` from
 * `@/chessin/bindings`, returning the paths that could NOT be moved. The
 * binding is looked up dynamically so this module compiles and runs before
 * the command lands; when it is absent at runtime the old permanent delete is
 * used instead and the result says so (`mode: "permanent"`).
 */
import { exists, remove } from "@tauri-apps/plugin-fs";
import { commands as appCommands } from "@/bindings";
import { commands as chessinCommands } from "@/chessin/bindings";
import type { TrashMode, TrashResult } from "./notice";
import { expandTrashPaths, sidePathsFor, type TrashItem } from "./paths";

type MoveToTrashCommand = (paths: string[]) => Promise<unknown>;

function resolveMoveToTrash(): MoveToTrashCommand | null {
    const candidate = (chessinCommands as unknown as Partial<Record<string, unknown>>).moveToTrash;
    return typeof candidate === "function" ? (candidate as MoveToTrashCommand) : null;
}

/** True when this build can move files to the OS recycle bin. */
export function isTrashAvailable(): boolean {
    return resolveMoveToTrash() !== null;
}

/** The mode `trashItems` will use right now. */
export function currentTrashMode(): TrashMode {
    return isTrashAvailable() ? "trash" : "permanent";
}

/**
 * Accepts both the contract shape (`string[]`) and a specta `Result`
 * wrapper, in case the command is declared fallible.
 */
function normalizeFailedPaths(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw.filter((path): path is string => typeof path === "string");
    }
    if (raw && typeof raw === "object" && "status" in raw) {
        const result = raw as { status: string; data?: unknown; error?: unknown };
        if (result.status === "ok") return normalizeFailedPaths(result.data);
        throw new Error(typeof result.error === "string" ? result.error : String(result.error));
    }
    return [];
}

/**
 * Moves `paths` to the OS recycle bin and returns the paths that failed.
 * Throws when the command is not available (check `isTrashAvailable()`).
 */
export async function moveToTrash(paths: string[]): Promise<string[]> {
    const command = resolveMoveToTrash();
    if (!command) {
        throw new Error("move_to_trash is not available in this build");
    }
    if (paths.length === 0) return [];
    return normalizeFailedPaths(await command(paths));
}

async function existingPaths(paths: string[]): Promise<string[]> {
    const checks = await Promise.all(
        paths.map(async (path) => {
            try {
                return await exists(path);
            } catch {
                return false;
            }
        }),
    );
    return paths.filter((_, index) => checks[index]);
}

async function deletePermanently(items: TrashItem[]): Promise<TrashResult> {
    const moved: TrashItem[] = [];
    const failed: TrashItem[] = [];
    for (const item of items) {
        try {
            if (item.kind === "database") {
                // Closes the pooled connection and removes the side files too.
                const result = await appCommands.deleteDatabase(item.path);
                if (result.status === "error") throw new Error(result.error);
            } else if (item.kind === "directory") {
                await remove(item.path, { recursive: true });
            } else {
                await remove(item.path);
                for (const side of sidePathsFor(item)) {
                    await remove(side).catch(() => {});
                }
            }
            moved.push(item);
        } catch (error) {
            console.error("Permanent delete failed", item.path, error);
            failed.push(item);
        }
    }
    return { mode: "permanent", moved, failed, leftovers: [] };
}

/**
 * Moves every item (plus its existing side files) to the OS recycle bin, or
 * deletes them permanently when the command is unavailable. Never throws;
 * failures are reported in the result.
 */
export async function trashItems(items: TrashItem[]): Promise<TrashResult> {
    if (!isTrashAvailable()) {
        return deletePermanently(items);
    }
    if (items.length === 0) {
        return { mode: "trash", moved: [], failed: [], leftovers: [] };
    }

    const { primary, side } = expandTrashPaths(items);
    const sideOnDisk = await existingPaths(side);
    const paths = [...primary, ...sideOnDisk];

    let failedPaths: Set<string>;
    try {
        failedPaths = new Set(await moveToTrash(paths));
    } catch (error) {
        console.error("move_to_trash failed", error);
        failedPaths = new Set(paths);
    }

    const failedSide = new Set(sideOnDisk.filter((path) => failedPaths.has(path)));
    const moved = items.filter((item) => !failedPaths.has(item.path));
    const failed = items.filter((item) => failedPaths.has(item.path));
    // A side file counts as a leftover only when its own item moved; when the
    // item itself failed, the side file staying put is the expected outcome.
    const leftovers = [
        ...new Set(
            moved.flatMap((item) => sidePathsFor(item).filter((path) => failedSide.has(path))),
        ),
    ];

    return { mode: "trash", moved, failed, leftovers };
}
