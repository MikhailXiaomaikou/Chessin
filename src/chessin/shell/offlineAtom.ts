import { atomWithStorage } from "jotai/utils";

/**
 * Offline mode: when true, no network request may leave the app (Lichess
 * explorer, catalogs, update checks, …). Persisted in localStorage so the
 * choice survives restarts.
 */
export const offlineModeAtom = atomWithStorage<boolean>("chessin.offline", false);
