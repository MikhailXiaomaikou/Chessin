import i18n from "i18next";
import { commands } from "@/chessin/bindings";
import { readSessionMirror } from "@/state/store/debouncedStorage";
import { type GameHeaders, getGameName } from "@/utils/treeReducer";
import { markDocFailed, markDocSaved, markDocSaving } from "./saveState";

/**
 * Typed wrappers over the S1b-1 library store commands (`<app_data_dir>/chessin/library.sqlite`):
 * the `kv` table (`getKv` / `setKv` / `deleteKv`) and the `documents` table with
 * its version history (`putDoc` / `getDoc` / `listDocs` / `deleteDoc` /
 * `listDocVersions` / `restoreDocVersion`, `createCheckpoint`).
 *
 * This is the only module that talks to those commands. Outside Tauri (vitest,
 * the Vite dev server in a browser) or while the commands are not part of the
 * bindings yet, an in-memory backend with the same semantics is used instead.
 */

export type LibraryDocument = {
    id: string;
    kind: string;
    title: string;
    origin: string | null;
    data: string;
    /** Unix milliseconds. */
    updatedAt: number;
};

export type LibraryDocumentMeta = Omit<LibraryDocument, "data">;

export type LibraryVersionMeta = {
    id: number;
    docId: string;
    /** Unix milliseconds. */
    createdAt: number;
    label: string | null;
};

export type PutDocInput = {
    id: string;
    kind: string;
    title: string;
    origin?: string | null;
    /** JSON payload; for kind "game" the zustand `StorageValue` of the tree store. */
    data: string;
    /** When set, a named version row is written (otherwise versions merge per 5 minutes). */
    checkpoint?: string | null;
};

export interface LibraryBackend {
    readonly native: boolean;
    storeGet(key: string): Promise<string | null>;
    storeSet(key: string, value: string): Promise<void>;
    storeDelete(key: string): Promise<void>;
    docPut(input: Required<PutDocInput>): Promise<void>;
    docGet(id: string): Promise<LibraryDocument | null>;
    docList(kind: string | null): Promise<LibraryDocumentMeta[]>;
    docDelete(id: string): Promise<void>;
    docVersions(id: string): Promise<LibraryVersionMeta[]>;
    docRestoreVersion(id: string, versionId: number): Promise<void>;
}

export const GAME_DOC_KIND = "game";

/** Mirrors the S1b-1 policy: ≤ 50 versions per document, merged within 5 minutes. */
export const VERSION_CAP = 50;
export const VERSION_MERGE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Backend selection

const NATIVE_COMMANDS = [
    "storeGet",
    "storeSet",
    "storeDelete",
    "docPut",
    "docGet",
    "docList",
    "docDelete",
    "docVersions",
    "docRestoreVersion",
] as const;

/** True inside a Tauri webview (`window.__TAURI_INTERNALS__` / `window.__TAURI__`). */
export function hasTauri(): boolean {
    if (typeof window === "undefined") return false;
    const w = window as unknown as Record<string, unknown>;
    return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

/** True when every store command exists on the generated bindings. */
export function hasNativeLibraryCommands(): boolean {
    const table = commands as unknown as Record<string, unknown>;
    return NATIVE_COMMANDS.every((name) => typeof table[name] === "function");
}

type SpectaResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

/** Accepts both plain values and tauri-specta `Result` envelopes. */
export function unwrapResult<T>(value: unknown): T {
    if (value && typeof value === "object" && "status" in value) {
        const result = value as SpectaResult<T>;
        if (result.status === "ok") return result.data;
        if (result.status === "error") throw new Error(String(result.error));
    }
    return value as T;
}

function toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
    return camel in record ? record[camel] : record[snake];
}

function normalizeDocument(raw: unknown): LibraryDocument | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
        id: String(r.id ?? ""),
        kind: String(r.kind ?? ""),
        title: String(r.title ?? ""),
        origin: r.origin == null ? null : String(r.origin),
        data: String(r.data ?? ""),
        updatedAt: toNumber(field(r, "updatedAt", "updated_at")),
    };
}

function normalizeMeta(raw: unknown): LibraryDocumentMeta | null {
    const doc = normalizeDocument(raw);
    if (!doc) return null;
    const { data: _data, ...meta } = doc;
    return meta;
}

function normalizeVersion(raw: unknown): LibraryVersionMeta | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
        id: toNumber(r.id),
        docId: String(field(r, "docId", "doc_id") ?? ""),
        createdAt: toNumber(field(r, "createdAt", "created_at")),
        label: r.label == null ? null : String(r.label),
    };
}

function normalizeList<T>(raw: unknown, map: (item: unknown) => T | null): T[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(map).filter((item): item is T => item !== null);
}

/**
 * Backend over the plugin commands. The member accesses below are checked
 * against the contract signatures and fail type-checking until S1b-1 adds the
 * commands to `src/chessin/bindings.ts`; `hasNativeLibraryCommands()` keeps the
 * app on the memory backend until then.
 */
function createTauriBackend(): LibraryBackend {
    return {
        native: true,
        async storeGet(key) {
            const value = unwrapResult<string | null>(await commands.storeGet(key));
            return value == null ? null : String(value);
        },
        async storeSet(key, value) {
            unwrapResult<unknown>(await commands.storeSet(key, value));
        },
        async storeDelete(key) {
            unwrapResult<unknown>(await commands.storeDelete(key));
        },
        async docPut(input) {
            unwrapResult<unknown>(
                await commands.docPut(
                    input.id,
                    input.kind,
                    input.title,
                    input.origin,
                    input.data,
                    input.checkpoint,
                ),
            );
        },
        async docGet(id) {
            return normalizeDocument(unwrapResult<unknown>(await commands.docGet(id)));
        },
        async docList(kind) {
            return normalizeList(
                unwrapResult<unknown>(await commands.docList(kind)),
                normalizeMeta,
            );
        },
        async docDelete(id) {
            unwrapResult<unknown>(await commands.docDelete(id));
        },
        async docVersions(id) {
            return normalizeList(
                unwrapResult<unknown>(await commands.docVersions(id)),
                normalizeVersion,
            );
        },
        async docRestoreVersion(id, versionId) {
            // `version_id: i64` is exported as `bigint` by the plugin's specta
            // config, but Tauri's IPC serialises arguments with JSON.stringify,
            // which throws on a real BigInt; a plain number crosses fine.
            unwrapResult<unknown>(
                await commands.docRestoreVersion(id, versionId as unknown as bigint),
            );
        },
    };
}

/** In-memory backend with the same semantics (tests, browser dev server, pre-S1b-1 builds). */
export function createMemoryBackend(now: () => number = Date.now): LibraryBackend {
    const kv = new Map<string, string>();
    const docs = new Map<string, LibraryDocument>();
    const versions = new Map<string, (LibraryVersionMeta & { data: string })[]>();
    let nextVersionId = 1;

    return {
        native: false,
        async storeGet(key) {
            return kv.get(key) ?? null;
        },
        async storeSet(key, value) {
            kv.set(key, value);
        },
        async storeDelete(key) {
            kv.delete(key);
        },
        async docPut(input) {
            const at = now();
            docs.set(input.id, {
                id: input.id,
                kind: input.kind,
                title: input.title,
                origin: input.origin,
                data: input.data,
                updatedAt: at,
            });
            const list = versions.get(input.id) ?? [];
            const last = list[list.length - 1];
            // Same rule as the Rust store: an unlabelled put merges into the
            // latest version only when that one is unlabelled and recent; a
            // named checkpoint is never overwritten.
            if (
                input.checkpoint !== null ||
                !last ||
                last.label !== null ||
                at - last.createdAt >= VERSION_MERGE_MS
            ) {
                list.push({
                    id: nextVersionId++,
                    docId: input.id,
                    createdAt: at,
                    label: input.checkpoint,
                    data: input.data,
                });
            } else {
                last.data = input.data;
            }
            while (list.length > VERSION_CAP) list.shift();
            versions.set(input.id, list);
        },
        async docGet(id) {
            const doc = docs.get(id);
            return doc ? { ...doc } : null;
        },
        async docList(kind) {
            return Array.from(docs.values())
                .filter((doc) => kind === null || doc.kind === kind)
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map(({ data: _data, ...meta }) => meta);
        },
        async docDelete(id) {
            docs.delete(id);
            versions.delete(id);
        },
        async docVersions(id) {
            return (versions.get(id) ?? []).map(({ data: _data, ...meta }) => meta).reverse();
        },
        async docRestoreVersion(id, versionId) {
            const doc = docs.get(id);
            const version = versions.get(id)?.find((v) => v.id === versionId);
            if (!doc || !version) throw new Error(`No version ${versionId} for document ${id}`);
            docs.set(id, { ...doc, data: version.data, updatedAt: now() });
        },
    };
}

let backend: LibraryBackend | null = null;

function resolveBackend(): LibraryBackend {
    if (!backend) {
        backend =
            hasTauri() && hasNativeLibraryCommands() ? createTauriBackend() : createMemoryBackend();
    }
    return backend;
}

/** True when writes go to library.sqlite (false on the in-memory fallback). */
export function isLibraryStoreNative(): boolean {
    return resolveBackend().native;
}

/** Test hook: replaces the backend (null restores automatic selection). */
export function __setLibraryBackendForTests(next: LibraryBackend | null): void {
    backend = next;
}

// ---------------------------------------------------------------------------
// kv

export function getKv(key: string): Promise<string | null> {
    return resolveBackend().storeGet(key);
}

export function setKv(key: string, value: string): Promise<void> {
    return resolveBackend().storeSet(key, value);
}

export function deleteKv(key: string): Promise<void> {
    return resolveBackend().storeDelete(key);
}

// ---------------------------------------------------------------------------
// documents

// Writes for one document id are chained so autosave and checkpoints never
// overtake each other (plugin commands run concurrently on the Rust side).
const docWriteChains = new Map<string, Promise<void>>();

export function putDoc(input: PutDocInput): Promise<void> {
    const full: Required<PutDocInput> = {
        id: input.id,
        kind: input.kind,
        title: input.title,
        origin: input.origin ?? null,
        data: input.data,
        checkpoint: input.checkpoint ?? null,
    };
    const previous = docWriteChains.get(input.id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => resolveBackend().docPut(full));
    docWriteChains.set(input.id, task);
    const cleanup = () => {
        if (docWriteChains.get(input.id) === task) docWriteChains.delete(input.id);
    };
    task.then(cleanup, cleanup);
    return task;
}

/** Resolves once every queued `putDoc` has settled. */
export async function awaitDocWrites(): Promise<void> {
    await Promise.allSettled(Array.from(docWriteChains.values()));
}

export function hasInFlightDocWrites(): boolean {
    return docWriteChains.size > 0;
}

export function getDoc(id: string): Promise<LibraryDocument | null> {
    return resolveBackend().docGet(id);
}

export function listDocs(kind?: string | null): Promise<LibraryDocumentMeta[]> {
    return resolveBackend().docList(kind ?? null);
}

export function deleteDoc(id: string): Promise<void> {
    return resolveBackend().docDelete(id);
}

export function listDocVersions(id: string): Promise<LibraryVersionMeta[]> {
    return resolveBackend().docVersions(id);
}

export function restoreDocVersion(id: string, versionId: number): Promise<void> {
    return resolveBackend().docRestoreVersion(id, versionId);
}

// ---------------------------------------------------------------------------
// Tree documents (kind "game", id = tab id)

export type TreeDocMeta = { title?: string; origin?: string | null };

let treeDocMetaProvider: ((id: string) => TreeDocMeta | undefined) | null = null;

/** Lets the workspace layer supply the tab origin / title for a tree document. */
export function setTreeDocMetaProvider(
    provider: ((id: string) => TreeDocMeta | undefined) | null,
): void {
    treeDocMetaProvider = provider;
}

export function getTreeDocMeta(id: string): TreeDocMeta {
    try {
        return treeDocMetaProvider?.(id) ?? {};
    } catch {
        return {};
    }
}

/** Title for a persisted tree: the game name from its headers, else `fallback`. */
export function titleForTreeState(state: unknown, fallback: string): string {
    const headers = (state as { headers?: GameHeaders } | null)?.headers;
    if (!headers) return fallback;
    const name = getGameName(headers);
    return name === "Unknown" ? fallback : name;
}

export type CheckpointResult = { id: string; label: string };

function defaultCheckpointLabel(): string {
    const label = i18n.t("Workspace.Checkpoint.DefaultLabel");
    return typeof label === "string" && label !== "Workspace.Checkpoint.DefaultLabel"
        ? label
        : new Date().toLocaleString();
}

/**
 * Writes the current tree of `tabId` as a named version. Returns null when the
 * tab has no tree document (nothing to checkpoint). S1b-3 calls this from the
 * mod+s handler for Chessin-owned documents and for "copy into library".
 */
export async function createCheckpoint(
    tabId: string,
    label?: string,
): Promise<CheckpointResult | null> {
    const raw = readSessionMirror(tabId);
    if (raw === null) return null;

    let state: unknown = null;
    try {
        state = (JSON.parse(raw) as { state?: unknown }).state ?? null;
    } catch {
        state = null;
    }
    const meta = getTreeDocMeta(tabId);
    const checkpoint = label ?? defaultCheckpointLabel();

    markDocSaving(tabId);
    try {
        await putDoc({
            id: tabId,
            kind: GAME_DOC_KIND,
            title: meta.title ?? titleForTreeState(state, tabId),
            origin: meta.origin ?? null,
            data: raw,
            checkpoint,
        });
        markDocSaved(tabId);
    } catch (e) {
        markDocFailed(tabId);
        throw e;
    }
    return { id: tabId, label: checkpoint };
}
