import { atom, getDefaultStore } from "jotai";
import { atomFamily, atomWithStorage, createJSONStorage } from "jotai/utils";
import { type Chip, isChip } from "./parse";

/**
 * Chips of the query bar, per database path. Mirrored in sessionStorage like
 * the games query it drives (`database-view` in `src/state/store/database.ts`),
 * so a reload within the session shows the bar and the table in agreement.
 * `openSmartCollection` writes here before navigating to the games table.
 */

export const CHIPS_STORAGE_KEY = "chessin.query.chips";

type ChipsByDb = Record<string, Chip[]>;

const EMPTY: Chip[] = [];

function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (i) => Array.from(map.keys())[i] ?? null,
        removeItem: (key) => {
            map.delete(key);
        },
        setItem: (key, value) => {
            map.set(key, value);
        },
    };
}

let fallback: Storage | null = null;

function sessionOrMemory(): Storage {
    try {
        if (typeof sessionStorage !== "undefined") return sessionStorage;
    } catch {
        // Sandboxed webview: fall through.
    }
    fallback ??= memoryStorage();
    return fallback;
}

// Storage may hand back anything; validated once per array (by reference) so
// the derived atom keeps returning the same array while nothing changed.
const cleaned = new WeakMap<object, Chip[]>();

function clean(value: unknown): Chip[] {
    if (!Array.isArray(value)) return EMPTY;
    let out = cleaned.get(value);
    if (!out) {
        out = value.every(isChip) ? (value as Chip[]) : value.filter(isChip);
        cleaned.set(value, out);
    }
    return out;
}

function table(value: unknown): ChipsByDb {
    return value && typeof value === "object" ? (value as ChipsByDb) : {};
}

const chipsByDbAtom = atomWithStorage<ChipsByDb>(
    CHIPS_STORAGE_KEY,
    {},
    createJSONStorage<ChipsByDb>(sessionOrMemory),
    { getOnInit: true },
);

/** Chips for one database file (empty when none were typed). */
export const queryChipsAtomFamily = atomFamily((file: string) =>
    atom(
        (get) => clean(table(get(chipsByDbAtom))[file]),
        (get, set, chips: Chip[]) => {
            const prev = table(get(chipsByDbAtom));
            if (chips.length === 0) {
                const { [file]: _dropped, ...rest } = prev;
                set(chipsByDbAtom, rest);
            } else {
                set(chipsByDbAtom, { ...prev, [file]: chips });
            }
        },
    ),
);

export function getQueryChips(file: string, store = getDefaultStore()): Chip[] {
    return store.get(queryChipsAtomFamily(file));
}

export function setQueryChips(file: string, chips: Chip[], store = getDefaultStore()): void {
    store.set(queryChipsAtomFamily(file), chips);
}
