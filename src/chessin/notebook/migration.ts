import { getKv, setKv } from "@/chessin/store/libraryStore";
import {
    type AddCardInput,
    type AddCardResult,
    addCard,
    normalizeFsrsCard,
    repertoireCardId,
} from "./cards";
import { epdOf, plyFromFen, sideToMove, uciFromSan } from "./chess";

/**
 * One-time migration of the legacy repertoire decks (contract S2-5).
 *
 * `PracticePanel` keeps one deck per repertoire file in localStorage under
 * `deck-<file path>-<game number>` (`PracticeData = { positions, logs }`,
 * each `Position = { fen, answer: SAN, card: ts-fsrs Card }`). On the first
 * open of the notebook every position with a due date becomes a
 * `rp:<epd>` card (kind `repertoire`, answer = the position's move as UCI)
 * that keeps its FSRS schedule. The localStorage deck is left untouched so
 * the practice panel keeps working; `notebook.decksMigrated` in the library
 * kv records that the migration ran.
 */

export const DECKS_MIGRATED_KEY = "notebook.decksMigrated";
export const LEGACY_DECK_PREFIX = "deck-";

/** The subset of `Storage` the migration reads. */
export type StorageLike = {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
};

export type LegacyPosition = {
    fen: string;
    answer: string;
    card: Record<string, unknown>;
};

export type LegacyDeck = {
    key: string;
    file: string;
    game: number;
    positions: LegacyPosition[];
};

/** `deck-<file>-<game>` → `{ file, game }` (the file path may itself contain dashes). */
export function parseDeckKey(key: string): { file: string; game: number } | null {
    if (!key.startsWith(LEGACY_DECK_PREFIX)) return null;
    const rest = key.slice(LEGACY_DECK_PREFIX.length);
    const dash = rest.lastIndexOf("-");
    if (dash <= 0) return null;
    const game = Number(rest.slice(dash + 1));
    if (!Number.isInteger(game) || game < 0) return null;
    return { file: rest.slice(0, dash), game };
}

function defaultStorage(): StorageLike | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

export function readLegacyDecks(storage: StorageLike | null = defaultStorage()): LegacyDeck[] {
    if (!storage) return [];
    const decks: LegacyDeck[] = [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(LEGACY_DECK_PREFIX)) keys.push(key);
    }
    keys.sort();
    for (const key of keys) {
        const parsed = parseDeckKey(key);
        if (!parsed) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        let data: unknown;
        try {
            data = JSON.parse(raw);
        } catch {
            continue;
        }
        const positions = (data as { positions?: unknown })?.positions;
        if (!Array.isArray(positions)) continue;
        decks.push({
            key,
            file: parsed.file,
            game: parsed.game,
            positions: positions.filter(isLegacyPosition),
        });
    }
    return decks;
}

function isLegacyPosition(value: unknown): value is LegacyPosition {
    if (!value || typeof value !== "object") return false;
    const p = value as Record<string, unknown>;
    return (
        typeof p.fen === "string" &&
        typeof p.answer === "string" &&
        !!p.card &&
        typeof p.card === "object"
    );
}

function hasDueDate(card: Record<string, unknown>): boolean {
    const due = card.due;
    if (due instanceof Date) return !Number.isNaN(due.getTime());
    if (typeof due !== "string" && typeof due !== "number") return false;
    return !Number.isNaN(new Date(due).getTime());
}

/** Pure: the card a legacy position becomes (`null` when it has no due date or an unplayable move). */
export function legacyPositionToCard(
    position: LegacyPosition,
    deck: Pick<LegacyDeck, "key" | "file" | "game">,
    now = Date.now(),
): AddCardInput | null {
    if (!hasDueDate(position.card)) return null;
    const epd = epdOf(position.fen);
    const uci = uciFromSan(position.fen, position.answer);
    if (!uci) return null;
    return {
        id: repertoireCardId(epd),
        epd,
        kind: "repertoire",
        answers: [uci],
        source: { gameKey: `file:${deck.file}#${deck.game}`, ply: plyFromFen(position.fen) },
        meta: {
            san: position.answer,
            playerColor: sideToMove(position.fen),
            title: baseName(deck.file),
            legacyDeck: deck.key,
            file: deck.file,
            game: deck.game,
        },
        fsrs: normalizeFsrsCard(position.card, now),
    };
}

function baseName(path: string): string {
    const name = path.split(/[\\/]/).pop() || path;
    return name.replace(/\.pgn$/i, "");
}

export type MigrationResult = {
    /** True when the migration had already run (nothing was read). */
    skipped: boolean;
    decks: number;
    /** Cards created. */
    migrated: number;
    /** Positions that already had a card (schedule kept). */
    merged: number;
};

export type MigrateOptions = {
    storage?: StorageLike | null;
    now?: number;
    /** Run even when `notebook.decksMigrated` is set. */
    force?: boolean;
};

export async function migrateLegacyDecks(opts: MigrateOptions = {}): Promise<MigrationResult> {
    const now = opts.now ?? Date.now();
    if (!opts.force && (await getKv(DECKS_MIGRATED_KEY)) === "1") {
        return { skipped: true, decks: 0, migrated: 0, merged: 0 };
    }
    const decks = readLegacyDecks(opts.storage === undefined ? defaultStorage() : opts.storage);
    let migrated = 0;
    let merged = 0;
    for (const deck of decks) {
        for (const position of deck.positions) {
            const input = legacyPositionToCard(position, deck, now);
            if (!input) continue;
            const result: AddCardResult = await addCard(input, now);
            if (result.created) migrated++;
            else merged++;
        }
    }
    await setKv(DECKS_MIGRATED_KEY, "1");
    return { skipped: false, decks: decks.length, migrated, merged };
}
