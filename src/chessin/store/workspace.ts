import { notifications } from "@mantine/notifications";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "i18next";
import { atom, getDefaultStore } from "jotai";
import { registerCommand } from "@/chessin/commands/registry";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import {
    flushSessionMirror,
    readSessionMirror,
    writeSessionMirror,
} from "@/state/store/debouncedStorage";
import { type Tab, tabSchema } from "@/utils/tabs";
import {
    createCheckpoint,
    getDoc,
    getKv,
    hasTauri,
    setKv,
    setTreeDocMetaProvider,
} from "./libraryStore";
import { flushDocWrites } from "./treePersist";

/**
 * Workspace persistence + crash recovery (S1b-2).
 *
 * - `tabsAtom` / `activeTabAtom` keep sessionStorage as their transient mirror
 *   and are additionally written to the library kv (`workspace.tabs`,
 *   `workspace.activeTab`) `TABS_DEBOUNCE_MS` after the last change.
 * - At startup `restoreWorkspace` reads them back, seeds the sessionStorage
 *   mirror of each tab's tree from `doc_get(tab id)` and flips
 *   `workspaceReadyAtom`; `WorkspaceGate` holds `BoardsPage` until then.
 * - `workspace.cleanExit` is "0" while the app runs and "1" after a clean
 *   shutdown; a restore that finds "0" shows `Workspace.Restored`.
 */

export const WORKSPACE_TABS_KEY = "workspace.tabs";
export const WORKSPACE_ACTIVE_TAB_KEY = "workspace.activeTab";
export const WORKSPACE_CLEAN_EXIT_KEY = "workspace.cleanExit";
export const TABS_DEBOUNCE_MS = 300;

/** sessionStorage marker: present after a reload of the same webview, absent on a fresh process. */
const SESSION_MARKER_KEY = "chessin.workspace.session";
const RESTORE_TIMEOUT_MS = 3000;
const EXIT_FLUSH_TIMEOUT_MS = 1500;

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** True once the saved tabs have been applied (or there were none). */
export const workspaceReadyAtom = atom(false);

export type RestoreResult = {
    /** Tabs from a previous run were applied. */
    restored: boolean;
    /** `restored` and the previous run did not shut down cleanly. */
    crashRecovered: boolean;
    tabs: Tab[];
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });
}

function readSessionMarker(): boolean {
    try {
        const seen = sessionStorage.getItem(SESSION_MARKER_KEY) === "1";
        sessionStorage.setItem(SESSION_MARKER_KEY, "1");
        return seen;
    } catch {
        return false;
    }
}

/** Parses the stored tab list, dropping entries that no longer fit the schema. */
export function parseStoredTabs(raw: string | null): Tab[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const tabs: Tab[] = [];
        for (const item of parsed) {
            const result = tabSchema.safeParse(item);
            if (result.success) tabs.push(result.data);
        }
        return tabs;
    } catch {
        return [];
    }
}

/**
 * Combines the tabs saved by the previous run with the ones already in the
 * atom (a CLI / deep-link file opened during startup, or the same list after a
 * reload). Untouched "new" placeholders are dropped; other current tabs that
 * are not in the saved list are appended and keep the focus when active.
 */
export function mergeRestoredTabs(
    current: Tab[],
    currentActive: string | null,
    restored: Tab[],
    restoredActive: string | null,
): { tabs: Tab[]; activeTab: string | null } {
    if (restored.length === 0) return { tabs: current, activeTab: currentActive };

    const restoredIds = new Set(restored.map((t) => t.value));
    const extra = current.filter((t) => !restoredIds.has(t.value) && t.type !== "new");
    const tabs = [...restored, ...extra];

    let activeTab: string | null;
    if (currentActive && extra.some((t) => t.value === currentActive)) {
        activeTab = currentActive;
    } else if (restoredActive && restoredIds.has(restoredActive)) {
        activeTab = restoredActive;
    } else {
        activeTab = restored[0].value;
    }
    return { tabs, activeTab };
}

/** Reads the saved workspace and applies it to the atoms. Resolves even when the store is unavailable. */
export async function restoreWorkspace(
    store: JotaiStore = getDefaultStore(),
): Promise<RestoreResult> {
    const safeGet = (key: string) => getKv(key).catch(() => null);
    const [cleanExit, rawTabs, rawActive] = await withTimeout(
        Promise.all([
            safeGet(WORKSPACE_CLEAN_EXIT_KEY),
            safeGet(WORKSPACE_TABS_KEY),
            safeGet(WORKSPACE_ACTIVE_TAB_KEY),
        ]),
        RESTORE_TIMEOUT_MS,
        [null, null, null],
    );
    const sameSession = readSessionMarker();
    // From here on the run is "dirty" until a clean shutdown marks it.
    void setKv(WORKSPACE_CLEAN_EXIT_KEY, "0").catch(() => undefined);

    const restoredTabs = parseStoredTabs(rawTabs);
    let restored = false;
    if (restoredTabs.length > 0) {
        await withTimeout(
            Promise.all(
                restoredTabs
                    .filter((tab) => readSessionMirror(tab.value) === null)
                    .map(async (tab) => {
                        const doc = await getDoc(tab.value).catch(() => null);
                        if (doc?.data) writeSessionMirror(tab.value, doc.data);
                    }),
            ),
            RESTORE_TIMEOUT_MS,
            [],
        );
        const merged = mergeRestoredTabs(
            store.get(tabsAtom),
            store.get(activeTabAtom),
            restoredTabs,
            rawActive || null,
        );
        store.set(tabsAtom, merged.tabs);
        store.set(activeTabAtom, merged.activeTab);
        restored = true;
    }

    store.set(workspaceReadyAtom, true);
    return {
        restored,
        crashRecovered: restored && !sameSession && cleanExit === "0",
        tabs: restored ? store.get(tabsAtom) : [],
    };
}

// ---------------------------------------------------------------------------
// Debounced tabs persistence

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSuspended = false;
let lastWrittenTabs: string | null = null;
let lastWrittenActive: string | null = null;

async function writeTabsNow(store: JotaiStore): Promise<void> {
    if (persistSuspended) return;
    const tabs = JSON.stringify(store.get(tabsAtom));
    const active = store.get(activeTabAtom) ?? "";
    const writes: Promise<void>[] = [];
    if (tabs !== lastWrittenTabs) {
        lastWrittenTabs = tabs;
        writes.push(setKv(WORKSPACE_TABS_KEY, tabs));
    }
    if (active !== lastWrittenActive) {
        lastWrittenActive = active;
        writes.push(setKv(WORKSPACE_ACTIVE_TAB_KEY, active));
    }
    try {
        await Promise.all(writes);
    } catch (e) {
        console.warn(`[chessin] workspace persistence failed: ${String(e)}`);
        lastWrittenTabs = null;
        lastWrittenActive = null;
    }
}

/** Subscribes to the tab atoms and writes them `delay` ms after the last change. Returns an unsubscribe. */
export function startWorkspacePersistence(
    store: JotaiStore = getDefaultStore(),
    delay = TABS_DEBOUNCE_MS,
): () => void {
    persistSuspended = false;
    const schedule = () => {
        if (persistSuspended) return;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            void writeTabsNow(store);
        }, delay);
    };
    const unsubTabs = store.sub(tabsAtom, schedule);
    const unsubActive = store.sub(activeTabAtom, schedule);
    return () => {
        unsubTabs();
        unsubActive();
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
    };
}

/** Stops writing `workspace.*` for the rest of this page life (used by "clear saved data"). */
export function suspendWorkspacePersistence(): void {
    persistSuspended = true;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
}

/** Writes the tabs, the tree mirrors and every pending document now. */
export async function flushWorkspace(store: JotaiStore = getDefaultStore()): Promise<void> {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    flushSessionMirror();
    await Promise.all([writeTabsNow(store), flushDocWrites()]);
}

/** Flushes everything and records a clean shutdown. */
export async function markCleanExit(store: JotaiStore = getDefaultStore()): Promise<void> {
    await flushWorkspace(store);
    await setKv(WORKSPACE_CLEAN_EXIT_KEY, "1");
}

/**
 * Exit hooks: `beforeunload` / `pagehide` (reload, relaunch) and the Tauri
 * close request. A JS listener on `tauri://close-requested` makes Tauri hold
 * the window, so the handler flushes, removes itself and then calls `close()`
 * again, which now goes through (`destroy` is not in the capabilities).
 * `exit(0)` from the menu bypasses both: the Rust `ExitRequested` handler must
 * set `workspace.cleanExit = "1"` once the store crate is wired.
 */
export function installExitHooks(store: JotaiStore = getDefaultStore()): () => void {
    if (typeof window === "undefined") return () => undefined;

    const onUnload = () => {
        void markCleanExit(store).catch(() => undefined);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);

    let unlistenClose: (() => void | Promise<void>) | undefined;
    if (hasTauri()) {
        try {
            const win = getCurrentWindow();
            win.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
                const off = unlistenClose;
                unlistenClose = undefined;
                try {
                    await off?.();
                } catch {
                    // listener already gone
                }
                await withTimeout(markCleanExit(store), EXIT_FLUSH_TIMEOUT_MS, undefined);
                try {
                    await win.close();
                } catch (e) {
                    console.warn(`[chessin] window close after flush failed: ${String(e)}`);
                }
            })
                .then((fn) => {
                    unlistenClose = fn;
                })
                .catch((e: unknown) => {
                    console.warn(`[chessin] close-requested hook unavailable: ${String(e)}`);
                });
        } catch (e) {
            console.warn(`[chessin] close-requested hook unavailable: ${String(e)}`);
        }
    }

    return () => {
        window.removeEventListener("beforeunload", onUnload);
        window.removeEventListener("pagehide", onUnload);
        void unlistenClose?.();
        unlistenClose = undefined;
    };
}

function registerCheckpointCommand(store: JotaiStore): () => void {
    return registerCommand({
        id: "edit.checkpoint",
        section: "edit",
        title: () => i18n.t("Workspace.Checkpoint"),
        shortcutKey: "SAVE_FILE",
        aliases: ["checkpoint", "snapshot", "version", "save", "存档", "存档点", "版本", "保存"],
        enabled: () => {
            const id = store.get(activeTabAtom);
            return !!id && readSessionMirror(id) !== null;
        },
        disabledReason: () => i18n.t("Workspace.Checkpoint.NoDocument"),
        run: async () => {
            const id = store.get(activeTabAtom);
            if (!id) return;
            const result = await createCheckpoint(id);
            if (result) {
                notifications.show({
                    id: "workspace-checkpoint",
                    message: i18n.t("Workspace.Checkpoint.Created"),
                    autoClose: 2500,
                });
            }
        },
    });
}

function originOf(tab: Tab): string | null {
    return tab.gameOrigin.kind === "none" ? null : JSON.stringify(tab.gameOrigin);
}

let started: Promise<void> | null = null;

/**
 * Idempotent startup: restore → persistence → exit hooks → `edit.checkpoint`.
 * Called at module load by `WorkspaceGate` (the index route), before React renders.
 */
export function startWorkspace(store: JotaiStore = getDefaultStore()): Promise<void> {
    if (started) return started;
    started = (async () => {
        setTreeDocMetaProvider((id) => {
            const tab = store.get(tabsAtom).find((t) => t.value === id);
            return tab ? { origin: originOf(tab) } : undefined;
        });
        try {
            const result = await restoreWorkspace(store);
            if (result.crashRecovered) {
                notifications.show({
                    id: "workspace-restored",
                    message: i18n.t("Workspace.Restored"),
                    autoClose: 6000,
                });
            }
        } catch (e) {
            console.warn(`[chessin] workspace restore failed: ${String(e)}`);
            store.set(workspaceReadyAtom, true);
        }
        startWorkspacePersistence(store);
        installExitHooks(store);
        registerCheckpointCommand(store);
    })();
    return started;
}

/** Test helper: forgets the startup promise and the write caches. */
export function __resetWorkspaceForTests(): void {
    started = null;
    persistSuspended = false;
    lastWrittenTabs = null;
    lastWrittenActive = null;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
}
