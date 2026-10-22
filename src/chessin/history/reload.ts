import { getTreeStore } from "@/chessin/keymap/treeStores";
import {
    createCheckpoint,
    getDoc,
    type LibraryDocument,
    listDocVersions,
    restoreDocVersion,
} from "@/chessin/store/libraryStore";
import { flushDocWrites } from "@/chessin/store/treePersist";
import { readSessionMirror, writeSessionMirror } from "@/state/store/debouncedStorage";
import type { TreeStore, TreeStoreState } from "@/state/store/tree";
import type { TreeNode, TreeState } from "@/utils/treeReducer";
import { parseTreeDocData, rememberVersionData, sortVersions } from "./versions";

/**
 * Reloading a tab's tree from its library document (S3-7).
 *
 * The tree store persists itself as `doc_put(id = tab id, kind = "game")`
 * (see `@/chessin/store/treePersist`), so a tab id is also its document id.
 * `reloadTabFromDoc(tabId)` pushes the document's payload the other way:
 *
 * - a mounted tab (its store is registered in `treeStores`) gets the payload
 *   through the store's own `setState` action, which re-ids the nodes and
 *   resets the history flags;
 * - an unmounted tab gets its session mirror replaced, so the store hydrates
 *   from the document when the tab mounts next.
 *
 * Undo: the store's undo stack holds immer patches recorded by the store's
 * private `commit`; a wholesale root swap cannot be expressed as such a patch
 * from outside the store, and `TreeStoreState.setState` deliberately clears
 * the stack (inverse patches would not apply to a different tree). The reload
 * is therefore made reversible here instead: the state before each reload is
 * kept per tab and `undoReload(tabId)` swaps it back (a second call re-applies
 * the reload). The library side keeps the pre-restore payload as well: the
 * plugin appends the restored payload as a new version, and
 * `restoreVersionAndReload` first writes a labelled checkpoint when the
 * newest version is an unlabelled autosave.
 */

export type ReloadResult =
    | { applied: "store"; tabId: string }
    | { applied: "mirror"; tabId: string }
    | { applied: "none"; tabId: string; reason: "no-document" | "bad-data" };

export type ReloadOptions = {
    /** The document to apply; fetched with `getDoc(tabId)` when omitted. */
    doc?: LibraryDocument | null;
    /** Keep the board where it is when that path still exists in the reloaded tree (default true). */
    keepPosition?: boolean;
};

/** Serialised `StorageValue` (`{ version, state }`) of a tab before its last reload. */
const snapshots = new Map<string, string>();

/** True when `path` addresses a node of `root`. */
export function isValidPath(root: TreeNode, path: readonly number[]): boolean {
    let node: TreeNode | undefined = root;
    for (const index of path) {
        node = node?.children[index];
        if (!node) return false;
    }
    return true;
}

/** `preferred` when it exists in `root`, else `stored` when it does, else the root. */
export function pickPosition(
    root: TreeNode,
    preferred: readonly number[] | null,
    stored: readonly number[],
): number[] {
    if (preferred && isValidPath(root, preferred)) return [...preferred];
    if (isValidPath(root, stored)) return [...stored];
    return [];
}

/** The persisted shape of a store (what `treePersist` writes), as a string. */
export function snapshotOfStore(store: TreeStore): string {
    const { canUndo: _canUndo, canRedo: _canRedo, ...state } = store.getState();
    // JSON.stringify drops the action functions, leaving the `TreeState` fields.
    return JSON.stringify({ version: 0, state });
}

/**
 * Applies a parsed tree to a live store through its `setState` action
 * (node ids are ensured there; the history flags reset).
 */
export function applyTreeToStore(
    store: TreeStore,
    tree: TreeState,
    { keepPosition = true }: { keepPosition?: boolean } = {},
): void {
    const current = store.getState();
    const position = pickPosition(tree.root, keepPosition ? current.position : null, tree.position);
    const next: TreeState = { ...tree, position, report: { inProgress: false } };
    current.setState(next);
}

function applyPayload(
    tabId: string,
    data: string,
    tree: TreeState,
    options: ReloadOptions,
    remember: boolean,
): ReloadResult {
    const store = getTreeStore(tabId);
    if (store) {
        if (remember) snapshots.set(tabId, snapshotOfStore(store));
        applyTreeToStore(store, tree, options);
        return { applied: "store", tabId };
    }
    if (remember) {
        const previous = readSessionMirror(tabId);
        if (previous !== null) snapshots.set(tabId, previous);
    }
    writeSessionMirror(tabId, data);
    return { applied: "mirror", tabId };
}

/**
 * Replaces the tab's live tree (or its session mirror when the tab is not
 * mounted) with the library document's payload. Remembers the previous
 * state for `undoReload`.
 */
export async function reloadTabFromDoc(
    tabId: string,
    options: ReloadOptions = {},
): Promise<ReloadResult> {
    const doc = options.doc === undefined ? await getDoc(tabId) : options.doc;
    if (!doc?.data) return { applied: "none", tabId, reason: "no-document" };
    const tree = parseTreeDocData(doc.data);
    if (!tree) return { applied: "none", tabId, reason: "bad-data" };
    return applyPayload(tabId, doc.data, tree, options, true);
}

export function canUndoReload(tabId: string | null | undefined): boolean {
    return !!tabId && snapshots.has(tabId);
}

/**
 * Swaps the tab back to the state it had before the last `reloadTabFromDoc`
 * (calling it again redoes the reload). Returns false when there is nothing
 * to undo. A mounted tab persists the swapped-in state through its own
 * autosave; an unmounted tab only gets its mirror swapped.
 */
export function undoReload(tabId: string): boolean {
    const previous = snapshots.get(tabId);
    if (previous === undefined) return false;
    const tree = parseTreeDocData(previous);
    if (!tree) {
        snapshots.delete(tabId);
        return false;
    }
    const store = getTreeStore(tabId);
    const current = store ? snapshotOfStore(store) : readSessionMirror(tabId);
    applyPayload(tabId, previous, tree, { keepPosition: true }, false);
    if (current !== null) snapshots.set(tabId, current);
    else snapshots.delete(tabId);
    return true;
}

export type RestoreOutcome =
    | { ok: true; reload: ReloadResult; checkpointed: boolean }
    | { ok: false; reason: "no-document" | "no-version" };

/** Tolerance between the webview clock and the plugin's `now_ms()` when matching new rows. */
const CLOCK_SKEW_MS = 2_000;

/**
 * "恢复到此版本": flushes pending autosaves (so none overtakes the restore),
 * writes a `beforeLabel` checkpoint when the newest version is an unlabelled
 * autosave (the current state stays findable by name), restores the version
 * in the library and reloads the tab from it. Payloads that become known on
 * the way are cached for the drawer's previews.
 */
export async function restoreVersionAndReload(
    tabId: string,
    versionId: number,
    { beforeLabel, keepPosition }: { beforeLabel?: string; keepPosition?: boolean } = {},
): Promise<RestoreOutcome> {
    await flushDocWrites();
    const before = await getDoc(tabId);
    if (!before) return { ok: false, reason: "no-document" };
    const versions = sortVersions(await listDocVersions(tabId));
    if (!versions.some((v) => v.id === versionId)) return { ok: false, reason: "no-version" };

    const startedAt = Date.now();
    let checkpointed = false;
    const newest = versions[0];
    if (beforeLabel && newest && newest.label === null) {
        try {
            checkpointed = (await createCheckpoint(tabId, beforeLabel)) !== null;
        } catch (e) {
            console.warn(`[chessin] checkpoint before restore failed: ${String(e)}`);
        }
    }

    await restoreDocVersion(tabId, versionId);
    const after = await getDoc(tabId);
    if (after?.data) {
        rememberVersionData(tabId, versionId, after.data);
        try {
            const latest = sortVersions(await listDocVersions(tabId));
            for (const row of latest) {
                if (row.createdAt < startedAt - CLOCK_SKEW_MS) break;
                if (row.label === null) rememberVersionData(tabId, row.id, after.data);
                else if (checkpointed && row.label === beforeLabel && before.data) {
                    rememberVersionData(tabId, row.id, before.data);
                }
            }
        } catch {
            // Previews only; the restore itself succeeded.
        }
    }
    const reload = await reloadTabFromDoc(tabId, { doc: after, keepPosition });
    return { ok: true, reload, checkpointed };
}

/** Test helper: forgets every pre-reload snapshot. */
export function __resetReloadForTests(): void {
    snapshots.clear();
}

export type { TreeStoreState };
