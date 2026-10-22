import { readDir } from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import { commands } from "@/bindings";
import { type AddCardResult, addCard } from "@/chessin/notebook/cards";
import { epdOf } from "@/chessin/notebook/chess";
import { explorerQueryFor, getExplorerCache } from "@/chessin/repertoire/explorerCache";
import {
    defaultMeta,
    loadRepertoireMeta,
    type RepertoireMeta,
    toEpd,
} from "@/chessin/repertoire/model";
import { onReviewSaved } from "@/chessin/review/events";
import type { Review } from "@/chessin/review/model";
import { collectRepertoires } from "@/chessin/shell/repertoireFiles";
import { getTreeStore } from "@/chessin/keymap/treeStores";
import type { OpenFileArgs } from "@/chessin/workspace/openInWorkspace";
import { type FileMetadata, processEntriesRecursively } from "@/components/files/file";
import { activeTabAtom, sessionsAtom, storedDocumentDirAtom, tabsAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { parsePGN } from "@/utils/chess";
import type { Tab } from "@/utils/tabs";
import {
    type GameHeaders,
    getNodeById,
    type TreeNode,
    type TreeState,
    treeIterator,
} from "@/utils/treeReducer";
import {
    type DetectDeps,
    type Deviation,
    type DeviationDoc,
    deviationMoveLabel,
    detectDeviations,
    type RepertoireRef,
    type RepertoireSource,
    sameMove,
    type StatsLookup,
} from "./detect";
import { getDeviationDoc, saveDeviationDoc, updateDeviationDoc } from "./store";

/**
 * Deviation detection wired to the app (S4-3): loading the repertoire files
 * of the document folder, running `detectDeviations` after every saved
 * review (and on the `deviation.check` command), and the actions behind the
 * two cards:
 *
 * - 我偏离了: 练这条线 (notebook card `kind: "deviation"`), 把 X 设为我的着法
 *   (`unifyConflict`-style edit of the repertoire tree when its file is open
 *   in a tab), 本次忽略;
 * - 对手偏离了: 补应对 (opens the repertoire at that node), 暂缓.
 */

type JotaiStore = ReturnType<typeof getDefaultStore>;

// ---------------------------------------------------------------------------
// Repertoire files → trees

export type RepertoireLoaderDeps = {
    documentDir: () => string;
    /** Repertoire files below `dir` (most recently modified first). */
    listFiles: (dir: string) => Promise<FileMetadata[]>;
    /** The PGN of the repertoire (its first game); null when unreadable. */
    readPgn: (path: string) => Promise<string | null>;
    parse: (pgn: string) => Promise<TreeState>;
    loadMeta: (file: FileMetadata, headers: GameHeaders) => Promise<RepertoireMeta>;
    /** Files read per check (the most recent ones). */
    maxFiles?: number;
};

export const DEFAULT_MAX_REPERTOIRE_FILES = 20;

export function defaultLoaderDeps(store: JotaiStore = getDefaultStore()): RepertoireLoaderDeps {
    return {
        documentDir: () => store.get(storedDocumentDirAtom),
        listFiles: async (dir) => {
            const entries = await readDir(dir);
            return collectRepertoires(await processEntriesRecursively(dir, entries));
        },
        readPgn: async (path) => {
            const result = await commands.readGames(path, 0, 0);
            return result.status === "ok" ? (result.data[0] ?? null) : null;
        },
        parse: (pgn) => parsePGN(pgn),
        loadMeta: async (file, headers) => {
            const fallback = defaultMeta({
                color: headers.orientation ?? "white",
                startFen: headers.fen,
                sessions: store.get(sessionsAtom),
            });
            const { meta } = await loadRepertoireMeta(file.path, fallback);
            return meta;
        },
    };
}

/**
 * The user's repertoires as trees. A repertoire is one PGN game with
 * variations; its colour comes from the stored meta (which defaults to the
 * file's `Orientation` header). Unreadable files are skipped.
 */
export async function loadRepertoireSources(
    deps: RepertoireLoaderDeps = defaultLoaderDeps(),
): Promise<RepertoireSource[]> {
    const dir = deps.documentDir();
    if (!dir) return [];
    let files: FileMetadata[];
    try {
        files = await deps.listFiles(dir);
    } catch (e) {
        console.warn("deviation: cannot list repertoires", e);
        return [];
    }
    const out: RepertoireSource[] = [];
    for (const file of files.slice(0, deps.maxFiles ?? DEFAULT_MAX_REPERTOIRE_FILES)) {
        try {
            const pgn = await deps.readPgn(file.path);
            if (!pgn) continue;
            const tree = await deps.parse(pgn);
            const meta = await deps.loadMeta(file, tree.headers);
            out.push({
                path: file.path,
                name: file.name,
                color: meta.color,
                root: tree.root,
                meta,
            });
        } catch (e) {
            console.warn("deviation: cannot read repertoire", file.path, e);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Running a check

/** Explorer statistics through the shared 7-day cache (offline: cache only). */
export const defaultStatsLookup: StatsLookup = async (fen, source) => {
    if (!source.meta) return null;
    const lookup = await getExplorerCache().lookup(fen, explorerQueryFor(source.meta));
    return lookup.stats;
};

export type CheckDeviationsOptions = {
    loader?: RepertoireLoaderDeps;
    detect?: DetectDeps;
    /** Already loaded sources (tests, batch runs). */
    sources?: RepertoireSource[];
};

function sameDeviation(a: Deviation | null, b: Deviation | null): boolean {
    return (
        !!a &&
        !!b &&
        a.kind === b.kind &&
        a.ply === b.ply &&
        a.playedUci === b.playedUci &&
        a.repertoire.path === b.repertoire.path
    );
}

/**
 * Detects the deviation of a reviewed game and stores the document. Returns
 * null when the review has no player colour (nothing to compare against).
 * A dismissed / snoozed state survives re-detection of the same deviation.
 */
export async function checkDeviations(
    review: Review,
    opts: CheckDeviationsOptions = {},
): Promise<DeviationDoc | null> {
    if (!review.playerColor) return null;
    const sources = opts.sources ?? (await loadRepertoireSources(opts.loader));
    const doc = await detectDeviations(review, sources, {
        lookup: defaultStatsLookup,
        ...opts.detect,
    });
    const previous = await getDeviationDoc(review.gameKey);
    if (previous && sameDeviation(previous.deviation, doc.deviation)) {
        doc.dismissed = previous.dismissed;
        doc.snoozed = previous.snoozed;
    }
    await saveDeviationDoc(doc);
    return doc;
}

/** The listener `registerDeviationListener` subscribes (exported for tests). */
export function handleReviewSaved(review: Review): void {
    if (!review.playerColor) return;
    checkDeviations(review).catch((e) => {
        console.error("deviation: check after review failed", e);
    });
}

let unsubscribe: (() => void) | null = null;

/** Subscribes the detection to saved reviews (idempotent). Returns the unsubscribe function. */
export function registerDeviationListener(): () => void {
    if (!unsubscribe) {
        const off = onReviewSaved(handleReviewSaved);
        unsubscribe = () => {
            off();
            unsubscribe = null;
        };
    }
    return unsubscribe;
}

export function isDeviationListenerRegistered(): boolean {
    return unsubscribe !== null;
}

// ---------------------------------------------------------------------------
// Card actions

export const DEVIATION_CARD_PREFIX = "dv:";

export function deviationCardId(epd: string): string {
    return DEVIATION_CARD_PREFIX + epdOf(epd);
}

/** 练这条线: a notebook card for the prepared move (`mine` only). */
export async function trainLine(
    doc: DeviationDoc,
    now = Date.now(),
): Promise<AddCardResult | null> {
    const d = doc.deviation;
    if (!d || d.kind !== "mine" || !d.preparedUci) return null;
    return addCard(
        {
            id: deviationCardId(d.epd),
            epd: d.epd,
            kind: "deviation",
            answers: [d.preparedUci],
            source: { gameKey: doc.gameKey, ply: d.ply },
            meta: {
                san: d.preparedSan,
                playedSan: d.playedSan,
                playerColor: d.color,
                title: d.repertoire.name,
                repertoire: d.repertoire.path,
                move: deviationMoveLabel(d.ply, d.preparedSan ?? ""),
            },
        },
        now,
    );
}

export async function dismissDeviation(gameKey: string): Promise<DeviationDoc | null> {
    return updateDeviationDoc(gameKey, { dismissed: true });
}

export async function snoozeDeviation(gameKey: string): Promise<DeviationDoc | null> {
    return updateDeviationDoc(gameKey, { snoozed: true });
}

/** The tab showing the repertoire file, if any. */
export function findRepertoireTab(path: string, store: JotaiStore = getDefaultStore()): Tab | null {
    for (const tab of store.get(tabsAtom)) {
        const origin = tab.gameOrigin;
        if ((origin.kind === "file" || origin.kind === "temp_file") && origin.file.path === path) {
            return tab;
        }
    }
    return null;
}

/** The live tree store of the repertoire file when it is open with a mounted board. */
export function findOpenRepertoireStore(
    path: string,
    store: JotaiStore = getDefaultStore(),
): TreeStore | undefined {
    const tab = findRepertoireTab(path, store);
    return tab ? getTreeStore(tab.value) : undefined;
}

/**
 * The node of the deviation's position in a (possibly edited) tree: by node
 * id, then by the recorded path, then by EPD anywhere in the tree.
 */
export function locateDeviationNode(
    root: TreeNode,
    dev: Pick<Deviation, "node" | "epd">,
): { node: TreeNode; path: number[] } | null {
    const byId = getNodeById(root, dev.node.id);
    if (byId && toEpd(byId.node.fen) === dev.epd) return byId;
    let node: TreeNode | undefined = root;
    for (const index of dev.node.path) {
        node = node?.children[index];
        if (!node) break;
    }
    if (node && toEpd(node.fen) === dev.epd) return { node, path: dev.node.path };
    for (const { node: n, position } of treeIterator(root)) {
        if (toEpd(n.fen) === dev.epd) return { node: n, path: position };
    }
    return null;
}

/**
 * 把 X 设为我的着法: makes the played move the main reply at the deviation's
 * node — an existing variation is promoted, a missing move is added in
 * front (nothing is deleted). Returns false when the node is not in the tree
 * or the move is illegal there; the board is left where it was.
 */
export function setAsMyMove(treeStore: TreeStore, dev: Deviation): boolean {
    if (dev.kind !== "mine") return false;
    const state = treeStore.getState();
    const found = locateDeviationNode(state.root, dev);
    if (!found) return false;
    const played = { san: dev.playedSan, uci: dev.playedUci };
    const original = state.position;
    const idx = found.node.children.findIndex((c) => sameMove(found.node.fen, played, c));
    if (idx === 0) return true;
    if (idx > 0) {
        state.promoteVariation([...found.path, idx]);
    } else {
        state.goToMove(found.path);
        state.makeMove({ payload: dev.playedSan, mainline: true, changeHeaders: false });
    }
    const after = locateDeviationNode(treeStore.getState().root, dev);
    const main = after?.node.children[0];
    const ok = !!after && !!main && sameMove(after.node.fen, played, main);
    treeStore.getState().goToMove(original);
    return ok;
}

/** A `FileMetadata` for the repertoire file (what `openFile` needs to open it as a repertoire). */
export async function repertoireFileMetadata(ref: RepertoireRef): Promise<FileMetadata> {
    let numGames = 1;
    try {
        const count = await commands.countPgnGames(ref.path);
        if (count.status === "ok") numGames = count.data;
    } catch {
        // keep the default
    }
    return {
        type: "file",
        name: ref.name,
        path: ref.path,
        numGames,
        metadata: { type: "repertoire", tags: [] },
        lastModified: Math.floor(Date.now() / 1000),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls for the tree store of a tab whose board is still mounting. */
export async function waitForTreeStore(
    tabId: string,
    timeoutMs = 4000,
    stepMs = 100,
): Promise<TreeStore | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const store = getTreeStore(tabId);
        if (store) return store;
        if (Date.now() >= deadline) return undefined;
        await sleep(stepMs);
    }
}

export type OpenRepertoireOptions = {
    /** Creates the tab and shows the board (S2-6's `useOpenInWorkspace()` result). */
    open: (args: OpenFileArgs) => Promise<string>;
    /** Shows the board without creating a tab (an already open tab was activated). */
    focus: () => void;
    store?: JotaiStore;
    waitMs?: number;
};

/**
 * 补应对: shows the repertoire at the deviation's node — the open tab is
 * activated, otherwise the file is opened as a repertoire. Resolves false
 * when there is nothing to open.
 */
export async function openRepertoireAtDeviation(
    doc: DeviationDoc,
    opts: OpenRepertoireOptions,
): Promise<boolean> {
    const dev = doc.deviation;
    if (!dev) return false;
    const store = opts.store ?? getDefaultStore();
    const tab = findRepertoireTab(dev.repertoire.path, store);
    let tabId: string;
    if (tab) {
        store.set(activeTabAtom, tab.value);
        opts.focus();
        tabId = tab.value;
    } else {
        tabId = await opts.open({ file: await repertoireFileMetadata(dev.repertoire) });
    }
    const treeStore = await waitForTreeStore(tabId, opts.waitMs);
    if (!treeStore) return true;
    const found = locateDeviationNode(treeStore.getState().root, dev);
    if (found) treeStore.getState().goToMove(found.path);
    return true;
}
