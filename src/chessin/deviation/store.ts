import i18n from "i18next";
import {
    deleteDoc,
    getDoc,
    type LibraryDocumentMeta,
    listDocs,
    putDoc,
} from "@/chessin/store/libraryStore";
import { type DeviationDoc, deviationMoveLabel, isDeviationDoc } from "./detect";

/**
 * Deviation documents: `kind: "deviation"`, id `"dev:" + gameKey`, `origin`
 * = the game key, `data` = the JSON `DeviationDoc`. One per game; saving
 * again replaces it. `onDeviationSaved` lets the review panel and the events
 * page refresh after a detection or an action (忽略 / 暂缓).
 */

export const DEVIATION_DOC_KIND = "deviation";
export const DEVIATION_DOC_PREFIX = "dev:";

export type DeviationMeta = LibraryDocumentMeta & { gameKey: string };

export function deviationDocId(gameKey: string): string {
    return DEVIATION_DOC_PREFIX + gameKey;
}

export function gameKeyFromDeviationDocId(docId: string): string | null {
    return docId.startsWith(DEVIATION_DOC_PREFIX) ? docId.slice(DEVIATION_DOC_PREFIX.length) : null;
}

export function parseDeviationDoc(data: string | null | undefined): DeviationDoc | null {
    if (!data) return null;
    try {
        const parsed: unknown = JSON.parse(data);
        return isDeviationDoc(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Listeners

export type DeviationSavedListener = (doc: DeviationDoc) => void;

const listeners = new Set<DeviationSavedListener>();

export function onDeviationSaved(cb: DeviationSavedListener): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function emitDeviationSaved(doc: DeviationDoc): void {
    for (const cb of Array.from(listeners)) {
        try {
            cb(doc);
        } catch (e) {
            console.error("deviation listener failed", e);
        }
    }
}

/** Test helper. */
export function clearDeviationListeners(): void {
    listeners.clear();
}

// ---------------------------------------------------------------------------
// Documents

function tr(key: string): string {
    const value = i18n.t(key);
    return typeof value === "string" ? value : key;
}

/** Library title: "我偏离了 12...Nf6" / "对手偏离了 5.Bc4", else the game key. */
export function deviationTitle(doc: DeviationDoc): string {
    const d = doc.deviation;
    if (!d) return doc.gameKey;
    const label = tr(d.kind === "mine" ? "Deviation.Badge.Mine" : "Deviation.Badge.Theirs");
    return `${label} ${deviationMoveLabel(d.ply, d.playedSan)}`;
}

export async function saveDeviationDoc(doc: DeviationDoc, title?: string): Promise<void> {
    await putDoc({
        id: deviationDocId(doc.gameKey),
        kind: DEVIATION_DOC_KIND,
        title: title ?? deviationTitle(doc),
        origin: doc.gameKey,
        data: JSON.stringify(doc),
    });
    emitDeviationSaved(doc);
}

export async function getDeviationDoc(gameKey: string): Promise<DeviationDoc | null> {
    const doc = await getDoc(deviationDocId(gameKey));
    if (!doc || doc.kind !== DEVIATION_DOC_KIND) return null;
    return parseDeviationDoc(doc.data);
}

/** Newest first. */
export async function listDeviationDocs(): Promise<DeviationMeta[]> {
    const metas = await listDocs(DEVIATION_DOC_KIND);
    const out: DeviationMeta[] = [];
    for (const meta of metas) {
        const gameKey = meta.origin ?? gameKeyFromDeviationDocId(meta.id);
        if (gameKey) out.push({ ...meta, gameKey });
    }
    return out;
}

export async function deleteDeviationDoc(gameKey: string): Promise<void> {
    await deleteDoc(deviationDocId(gameKey));
}

/** Merges `patch` into the stored document (null when there is none). */
export async function updateDeviationDoc(
    gameKey: string,
    patch: Partial<Pick<DeviationDoc, "dismissed" | "snoozed">>,
): Promise<DeviationDoc | null> {
    const current = await getDeviationDoc(gameKey);
    if (!current) return null;
    const next: DeviationDoc = { ...current, ...patch };
    await saveDeviationDoc(next);
    return next;
}
