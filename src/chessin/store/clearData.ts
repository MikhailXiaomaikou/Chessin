import { deleteKv, setKv } from "./libraryStore";
import {
    suspendWorkspacePersistence,
    WORKSPACE_ACTIVE_TAB_KEY,
    WORKSPACE_TABS_KEY,
} from "./workspace";

/**
 * Scoped "clear saved data" (replaces the old `localStorage.clear()`).
 *
 * localStorage keys are sorted into four buckets; only the selected buckets
 * are removed. Library documents (library.sqlite) are never touched, and the
 * whole localStorage is snapshotted into `backup.localStorage.<ts>` first.
 */

export type ClearDataScope = {
    /** 设置: every preference key not listed in another bucket. */
    settings: boolean;
    /** 布局与标签页: sidebar / tab bar / window layout, open tabs, tree mirrors. */
    layout: boolean;
    /** 训练记录: spaced-repetition decks. */
    training: boolean;
    /** 登录: Lichess / Chess.com sessions. */
    login: boolean;
};

export type ClearDataCategory = keyof ClearDataScope;

export const LAYOUT_LOCAL_KEYS: ReadonlySet<string> = new Set([
    "show-sidebar",
    "show-tabbar",
    "native-bar",
    "table-view",
    "windowsState",
    "expanded-directories",
]);

export const LOGIN_LOCAL_KEYS: ReadonlySet<string> = new Set(["sessions"]);

export const TRAINING_KEY_PREFIXES: readonly string[] = ["deck-"];

export function classifyLocalKey(key: string): ClearDataCategory {
    if (LOGIN_LOCAL_KEYS.has(key)) return "login";
    if (LAYOUT_LOCAL_KEYS.has(key)) return "layout";
    if (TRAINING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return "training";
    return "settings";
}

export function collectEntries(storage: Pick<Storage, "length" | "key" | "getItem">) {
    const entries: Record<string, string> = {};
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null) continue;
        const value = storage.getItem(key);
        if (value !== null) entries[key] = value;
    }
    return entries;
}

export type ClearDataResult = {
    backupKey: string;
    removed: string[];
};

export async function clearSavedData(
    scope: ClearDataScope,
    deps: { local?: Storage; session?: Storage; now?: () => number } = {},
): Promise<ClearDataResult> {
    const local = deps.local ?? localStorage;
    const session = deps.session ?? sessionStorage;
    const now = deps.now ?? Date.now;

    const entries = collectEntries(local);
    const backupKey = `backup.localStorage.${now()}`;
    await setKv(backupKey, JSON.stringify(entries));

    // From here on nothing may write `workspace.*` back before the reload.
    if (scope.layout) suspendWorkspacePersistence();

    const removed: string[] = [];
    for (const key of Object.keys(entries)) {
        if (scope[classifyLocalKey(key)]) {
            local.removeItem(key);
            removed.push(key);
        }
    }

    if (scope.layout) {
        session.clear();
        await Promise.all([deleteKv(WORKSPACE_TABS_KEY), deleteKv(WORKSPACE_ACTIVE_TAB_KEY)]);
    }

    return { backupKey, removed };
}
