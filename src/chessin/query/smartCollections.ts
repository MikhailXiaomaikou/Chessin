import {
    deleteDoc,
    getDoc,
    type LibraryDocumentMeta,
    listDocs,
    putDoc,
} from "@/chessin/store/libraryStore";
import { type Chip, isChip } from "./parse";

/**
 * Smart collections (智能棋谱集) are library documents:
 * `kind: "smart_collection"`, id `"sc:" + uuid`, `origin` = the database
 * path, `data` = JSON `{ chips, dbPath }`. Opening one puts the chips on the
 * games table of that database (`openSmartCollection`).
 */

export const SMART_COLLECTION_KIND = "smart_collection";
export const SMART_COLLECTION_ID_PREFIX = "sc:";

export type SmartCollectionData = { chips: Chip[]; dbPath: string };
export type SmartCollection = LibraryDocumentMeta & SmartCollectionData;

export function newSmartCollectionId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    const uuid =
        c && typeof c.randomUUID === "function"
            ? c.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${SMART_COLLECTION_ID_PREFIX}${uuid}`;
}

export function isSmartCollectionId(id: string): boolean {
    return (
        id.startsWith(SMART_COLLECTION_ID_PREFIX) && id.length > SMART_COLLECTION_ID_PREFIX.length
    );
}

export function parseSmartCollectionData(data: string): SmartCollectionData | null {
    try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object") return null;
        const r = parsed as Record<string, unknown>;
        if (!Array.isArray(r.chips) || typeof r.dbPath !== "string") return null;
        return { chips: r.chips.filter(isChip), dbPath: r.dbPath };
    } catch {
        return null;
    }
}

export function serializeSmartCollectionData(data: SmartCollectionData): string {
    return JSON.stringify({ chips: data.chips, dbPath: data.dbPath });
}

/** Writes (or, with `id`, replaces) a smart collection. Resolves to its id. */
export async function saveSmartCollection(input: {
    title: string;
    chips: Chip[];
    dbPath: string;
    id?: string;
}): Promise<string> {
    const id = input.id ?? newSmartCollectionId();
    await putDoc({
        id,
        kind: SMART_COLLECTION_KIND,
        title: input.title.trim(),
        origin: input.dbPath,
        data: serializeSmartCollectionData({ chips: input.chips, dbPath: input.dbPath }),
    });
    return id;
}

export async function loadSmartCollection(id: string): Promise<SmartCollection | null> {
    const doc = await getDoc(id);
    if (!doc || doc.kind !== SMART_COLLECTION_KIND) return null;
    const data = parseSmartCollectionData(doc.data);
    if (!data) return null;
    const { data: _raw, ...meta } = doc;
    return { ...meta, ...data, dbPath: data.dbPath || doc.origin || "" };
}

/** Newest first; documents with unreadable data are skipped. */
export async function listSmartCollections(): Promise<SmartCollection[]> {
    const metas = await listDocs(SMART_COLLECTION_KIND);
    const loaded = await Promise.all(metas.map((meta) => loadSmartCollection(meta.id)));
    return loaded.filter((sc): sc is SmartCollection => sc !== null);
}

export async function deleteSmartCollection(id: string): Promise<void> {
    await deleteDoc(id);
}

/** Collections of `dbPath` first (newest first), then the others. */
export function orderForDatabase(list: SmartCollection[], dbPath: string): SmartCollection[] {
    const own = list.filter((sc) => sc.dbPath === dbPath);
    const others = list.filter((sc) => sc.dbPath !== dbPath);
    return own.concat(others);
}
