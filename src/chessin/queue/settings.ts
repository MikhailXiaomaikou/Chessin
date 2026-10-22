import { atom, getDefaultStore } from "jotai";
import { getKv, setKv } from "@/chessin/store/libraryStore";
import {
    DEFAULT_QUEUE_SETTINGS,
    normalizeQueueSettings,
    parseQueueSettings,
    QUEUE_SETTINGS_KEY,
    type QueueSettings,
    serializeQueueSettings,
} from "./model";

/**
 * Queue settings persisted in the library kv (`queue.settings`), mirrored in
 * `queueSettingsAtom`, and the open state of the settings modal.
 */

type JotaiStore = ReturnType<typeof getDefaultStore>;

export const queueSettingsAtom = atom<QueueSettings>(DEFAULT_QUEUE_SETTINGS);

/** `true` while the settings modal is open (`queue.settings`, the Today card's gear). */
export const queueSettingsOpenAtom = atom(false);

/** Bumped after every settings save; the Today card and the notebook rebuild their queue. */
export const queueChangedAtom = atom(0);

let loaded: Promise<QueueSettings> | null = null;

/** Reads the settings once (later calls return the cached promise; `force` re-reads). */
export function loadQueueSettings(
    store: JotaiStore = getDefaultStore(),
    force = false,
): Promise<QueueSettings> {
    if (!loaded || force) {
        loaded = getKv(QUEUE_SETTINGS_KEY)
            .then((raw) => {
                const settings = parseQueueSettings(raw);
                store.set(queueSettingsAtom, settings);
                return settings;
            })
            .catch(() => store.get(queueSettingsAtom));
    }
    return loaded;
}

export async function saveQueueSettings(
    settings: QueueSettings,
    store: JotaiStore = getDefaultStore(),
): Promise<QueueSettings> {
    const normalized = normalizeQueueSettings(settings);
    await setKv(QUEUE_SETTINGS_KEY, serializeQueueSettings(normalized));
    store.set(queueSettingsAtom, normalized);
    loaded = Promise.resolve(normalized);
    store.set(queueChangedAtom, (n) => n + 1);
    return normalized;
}

/** Test hook: forgets the cached read. */
export function __resetQueueSettingsForTests(): void {
    loaded = null;
}

// The modal lives on the pages that start sessions (Today card, notebook).
// `queue.settings` opens the notebook first when none of them is mounted.
let settingsMounts = 0;

export function registerQueueSettingsMount(): () => void {
    settingsMounts++;
    return () => {
        settingsMounts = Math.max(0, settingsMounts - 1);
    };
}

export function isQueueSettingsModalMounted(): boolean {
    return settingsMounts > 0;
}
