import i18n from "i18next";
import type { StoreApi } from "zustand";
import { GAME_DOC_KIND, putDoc } from "@/chessin/store/libraryStore";
import { markDocFailed, markDocSaved, markDocSaving } from "@/chessin/store/saveState";
import type { TreeStoreState } from "@/state/store/tree";
import type { Tab } from "@/utils/tabs";
import { getGameName } from "@/utils/treeReducer";
import { libraryDocIdFor, originToString, retargetTabToLibrary } from "./saveModel";

/**
 * JSON written to `documents.data`: the zustand `StorageValue` of the tree
 * store (`{ version, state }` without the history flags), the same shape the
 * workspace store persists, so a library copy and the autosaved document are
 * interchangeable.
 */
export function serializeTreeForDoc(state: TreeStoreState): string {
    const { canUndo: _canUndo, canRedo: _canRedo, ...persisted } = state;
    return JSON.stringify({ version: 0, state: { ...persisted, dirty: false } });
}

/** Title shown in the library for a copied tab. */
export function libraryTitleFor(tab: Tab, state: TreeStoreState): string {
    const fromHeaders = getGameName(state.headers).trim();
    if (fromHeaders && fromHeaders !== "Unknown") return fromHeaders;
    return tab.name.trim() || fromHeaders || "Game";
}

/**
 * "复制到棋谱库 / Copy into library": creates a Chessin-owned document for the
 * tab (id = tab id, so the workspace store keeps writing the same document),
 * records a checkpoint, and re-targets the tab's origin to `library`.
 * The external source is never touched. Returns the document id.
 */
export async function copyTabToLibrary({
    tab,
    store,
    setTab,
}: {
    tab: Tab;
    store: StoreApi<TreeStoreState>;
    setTab: React.Dispatch<React.SetStateAction<Tab>>;
}): Promise<string> {
    const docId = libraryDocIdFor(tab);
    const state = store.getState();
    markDocSaving(docId);
    try {
        await putDoc({
            id: docId,
            kind: GAME_DOC_KIND,
            title: libraryTitleFor(tab, state),
            origin: originToString(tab.gameOrigin),
            data: serializeTreeForDoc(state),
            checkpoint: i18n.t("Save.CopyToLibrary.Checkpoint"),
        });
        markDocSaved(docId);
    } catch (error) {
        markDocFailed(docId);
        throw error;
    }
    setTab((prev) => retargetTabToLibrary(prev, docId));
    store.getState().save();
    return docId;
}
