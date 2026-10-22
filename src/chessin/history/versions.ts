import { makeUci } from "chessops";
import { commands } from "@/chessin/bindings";
import { hasTauri, type LibraryVersionMeta, unwrapResult } from "@/chessin/store/libraryStore";
import {
    type GameHeaders,
    getGameName,
    type TreeNode,
    type TreeState,
    treeIteratorMainLine,
} from "@/utils/treeReducer";

/**
 * Version history of a library document (S3-7), pure helpers.
 *
 * `listDocVersions` returns metadata only (`id`, `createdAt`, `label`); the
 * payload of a version is not readable through the plugin until a
 * `doc_version_get(id, version_id) -> String` command exists. What the drawer
 * can preview therefore comes from three places, in this order:
 *
 * 1. the newest version always holds the document's current payload (every
 *    `doc_put` either merges into it or appends it, and a restore appends the
 *    restored payload), so it is previewed from `getDoc`;
 * 2. payloads this process has seen (checkpoints it created, versions it
 *    restored) are kept in `versionDataCache`;
 * 3. `loadVersionData` tries a `typeof`-guarded `commands.docVersionGet` so a
 *    later Rust command completes the preview without touching the UI.
 */

export type VersionRow = {
    id: number;
    /** Unix milliseconds. */
    createdAt: number;
    /** Checkpoint label; null for an automatic (merged) version. */
    label: string | null;
    /** The newest version: its payload is the document's current state. */
    current: boolean;
    /** The version payload when known (see the module comment), else null. */
    data: string | null;
};

export type VersionPreview = {
    /** Final position of the main line. */
    fen: string;
    /** UCI of the last main-line move, if any. */
    lastMove?: string;
    /** Main-line length in half-moves. */
    plies: number;
    /** Game name from the headers ("White - Black"), or "" when unknown. */
    title: string;
    result: string;
};

/** Newest first: `created_at DESC, id DESC`, the order the plugin returns. */
export function sortVersions(list: readonly LibraryVersionMeta[]): LibraryVersionMeta[] {
    return [...list].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/**
 * Turns the plugin's version list into drawer rows. `currentData` is the
 * document payload (`getDoc(id).data`), attached to the newest version;
 * `dataFor` answers for the others (the cache, by default).
 */
export function mapVersions(
    list: readonly LibraryVersionMeta[],
    currentData: string | null,
    dataFor: (versionId: number) => string | null = () => null,
): VersionRow[] {
    return sortVersions(list).map((version, index) => ({
        id: version.id,
        createdAt: version.createdAt,
        label: version.label,
        current: index === 0,
        data: index === 0 ? (currentData ?? dataFor(version.id)) : dataFor(version.id),
    }));
}

/** The `state` of a persisted tree document, or null when the payload is not one. */
export function parseTreeDocData(raw: string | null | undefined): TreeState | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const envelope = parsed as { state?: unknown };
    const candidate = (
        envelope.state && typeof envelope.state === "object" ? envelope.state : parsed
    ) as Partial<TreeState>;
    const root = candidate.root as Partial<TreeNode> | undefined;
    if (!root || typeof root.fen !== "string" || !Array.isArray(root.children)) return null;
    const headers = (candidate.headers ?? {}) as Partial<GameHeaders>;
    return {
        root: root as TreeNode,
        headers: headers as GameHeaders,
        position: Array.isArray(candidate.position) ? candidate.position : [],
        dirty: candidate.dirty === true,
        report: { inProgress: false },
    };
}

/** Final main-line position + move count of a stored payload, or null when unreadable. */
export function previewFromData(raw: string | null | undefined): VersionPreview | null {
    const state = parseTreeDocData(raw);
    if (!state) return null;
    let last: TreeNode = state.root;
    let plies = 0;
    for (const { node } of treeIteratorMainLine(state.root)) {
        if (node === state.root) continue;
        last = node;
        plies += 1;
    }
    const preview: VersionPreview = {
        fen: last.fen,
        plies,
        title: gameTitle(state.headers),
        result: typeof state.headers?.result === "string" ? state.headers.result : "*",
    };
    if (last !== state.root && last.move) {
        try {
            preview.lastMove = makeUci(last.move);
        } catch {
            // A malformed move object: the board still shows the position.
        }
    }
    return preview;
}

function gameTitle(headers: GameHeaders | undefined): string {
    if (!headers) return "";
    try {
        const name = getGameName(headers);
        return name === "Unknown" ? "" : name;
    } catch {
        return "";
    }
}

/** Localised "2026/10/22 14:05" style timestamp; never throws on odd locales. */
export function formatVersionTime(ms: number, locale?: string): string {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "";
    const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
    try {
        return date.toLocaleString(locale, options);
    } catch {
        try {
            return date.toLocaleString(undefined, options);
        } catch {
            return date.toISOString();
        }
    }
}

// ---------------------------------------------------------------------------
// Version payloads known to this process

const versionDataCache = new Map<string, string>();

function cacheKey(docId: string, versionId: number): string {
    return `${docId}\u0000${versionId}`;
}

export function rememberVersionData(docId: string, versionId: number, data: string): void {
    versionDataCache.set(cacheKey(docId, versionId), data);
}

export function getCachedVersionData(docId: string, versionId: number): string | null {
    return versionDataCache.get(cacheKey(docId, versionId)) ?? null;
}

/** Test helper. */
export function __clearVersionDataCache(): void {
    versionDataCache.clear();
}

type NativeVersionCommands = {
    docVersionGet?: (id: string, versionId: unknown) => Promise<unknown>;
};

/** True when the (future) `doc_version_get` command is on the bindings. */
export function hasVersionDataCommand(): boolean {
    return hasTauri() && typeof (commands as NativeVersionCommands).docVersionGet === "function";
}

/**
 * The payload of `versionId`: from the cache, else through `doc_version_get`
 * when the plugin has it (cached afterwards), else null.
 */
export async function loadVersionData(docId: string, versionId: number): Promise<string | null> {
    const cached = getCachedVersionData(docId, versionId);
    if (cached !== null) return cached;
    if (!hasVersionDataCommand()) return null;
    try {
        const raw = unwrapResult<unknown>(
            await (commands as NativeVersionCommands).docVersionGet!(docId, versionId),
        );
        if (typeof raw !== "string" || raw === "") return null;
        rememberVersionData(docId, versionId, raw);
        return raw;
    } catch (e) {
        console.warn(`[chessin] doc_version_get(${docId}, ${versionId}) failed: ${String(e)}`);
        return null;
    }
}
