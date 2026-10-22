import { ensureNamesReady, sameEntity } from "@/chessin/names/aliases";
import { addCard, deleteCard } from "@/chessin/notebook/cards";
import type { PlayerColor } from "@/chessin/repertoire/model";
import { onReviewSaved } from "@/chessin/review/events";
import type { Review } from "@/chessin/review/model";
import { deleteDoc, getDoc, listDocs, putDoc } from "@/chessin/store/libraryStore";
import { nameKey } from "./candidates";
import { followedPlies } from "./movetext";

/**
 * Prep pack (备战包): the lines pinned for one opponent, as notebook cards
 * of kind `prep` (so the unified queue of S4-1 schedules them before the
 * 比赛日 via `meta.deadline`), plus the post-game self-assessment.
 *
 * Storage: one library document per opponent, kind `prep_pack`, id
 * `prep:<nameKey>`; cards `prep:<nameKey>:<epd>` with
 * `source.gameKey = "prep:" + opponent` and `meta: { deadline, opponent }`.
 */

export const PREP_PACK_KIND = "prep_pack";
export const PREP_CARD_KIND = "prep";
export const PREP_PACK_PREFIX = "prep:";
export const PREP_PACK_VERSION = 1 as const;

export type PinnedLine = {
    /** Position after the opponent's move (my move). */
    epd: string;
    fen: string;
    ply: number;
    /** SAN from the initial position up to the opponent's move. */
    line: string[];
    /** My prepared replies, standard UCI. */
    answers: string[];
    answerSans: string[];
    cardId: string;
    pinnedAt: number;
};

export type Assessment = {
    gameKey: string;
    date: string | null;
    playerColor: PlayerColor;
    /** Plies of the game that followed the best-matching pinned line. */
    followedPlies: number;
    /** The move number reached on that line ("走到了第 N 着"). */
    followedMoves: number;
    /** Index into `lines` of the line followed furthest; null when none matched. */
    lineIndex: number | null;
    result: string;
    createdAt: number;
};

export type PrepPack = {
    version: typeof PREP_PACK_VERSION;
    opponent: string;
    nameKey: string;
    mySide: PlayerColor;
    /** 比赛日, unix ms (local midnight), or null. */
    deadline: number | null;
    lines: PinnedLine[];
    assessments: Assessment[];
    updatedAt: number;
};

export function packDocId(key: string): string {
    return `${PREP_PACK_PREFIX}${key}`;
}

export function prepCardId(key: string, epd: string): string {
    return `${PREP_PACK_PREFIX}${key}:${epd}`;
}

/** `source.gameKey` of the pack's cards. */
export function prepSourceKey(opponent: string): string {
    return `${PREP_PACK_PREFIX}${opponent}`;
}

export function newPack(opponent: string, mySide: PlayerColor, now = Date.now()): PrepPack {
    return {
        version: PREP_PACK_VERSION,
        opponent,
        nameKey: nameKey(opponent),
        mySide,
        deadline: null,
        lines: [],
        assessments: [],
        updatedAt: now,
    };
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePack(raw: string | null | undefined): PrepPack | null {
    if (!raw) return null;
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!json || typeof json !== "object") return null;
    const r = json as Record<string, unknown>;
    if (typeof r.opponent !== "string" || !r.opponent) return null;
    const mySide: PlayerColor = r.mySide === "black" ? "black" : "white";
    const lines: PinnedLine[] = [];
    for (const item of Array.isArray(r.lines) ? r.lines : []) {
        if (!item || typeof item !== "object") continue;
        const l = item as Record<string, unknown>;
        if (typeof l.epd !== "string" || !l.epd) continue;
        lines.push({
            epd: l.epd,
            fen: typeof l.fen === "string" ? l.fen : l.epd,
            ply: typeof l.ply === "number" ? l.ply : 0,
            line: strings(l.line),
            answers: strings(l.answers),
            answerSans: strings(l.answerSans),
            cardId: typeof l.cardId === "string" ? l.cardId : "",
            pinnedAt: typeof l.pinnedAt === "number" ? l.pinnedAt : 0,
        });
    }
    const assessments: Assessment[] = [];
    for (const item of Array.isArray(r.assessments) ? r.assessments : []) {
        if (!item || typeof item !== "object") continue;
        const a = item as Record<string, unknown>;
        if (typeof a.gameKey !== "string") continue;
        assessments.push({
            gameKey: a.gameKey,
            date: typeof a.date === "string" ? a.date : null,
            playerColor: a.playerColor === "black" ? "black" : "white",
            followedPlies: typeof a.followedPlies === "number" ? a.followedPlies : 0,
            followedMoves: typeof a.followedMoves === "number" ? a.followedMoves : 0,
            lineIndex: numberOrNull(a.lineIndex),
            result: typeof a.result === "string" ? a.result : "*",
            createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
        });
    }
    return {
        version: PREP_PACK_VERSION,
        opponent: r.opponent,
        nameKey: typeof r.nameKey === "string" && r.nameKey ? r.nameKey : nameKey(r.opponent),
        mySide,
        deadline: numberOrNull(r.deadline),
        lines,
        assessments,
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    };
}

export function serializePack(pack: PrepPack): string {
    return JSON.stringify(pack);
}

export async function loadPack(opponent: string): Promise<PrepPack | null> {
    try {
        const doc = await getDoc(packDocId(nameKey(opponent)));
        return parsePack(doc?.data);
    } catch {
        return null;
    }
}

export async function savePack(pack: PrepPack, now = Date.now()): Promise<PrepPack> {
    const next: PrepPack = { ...pack, updatedAt: now };
    await putDoc({
        id: packDocId(pack.nameKey),
        kind: PREP_PACK_KIND,
        title: pack.opponent,
        origin: null,
        data: serializePack(next),
    });
    return next;
}

export async function listPacks(): Promise<PrepPack[]> {
    const metas = await listDocs(PREP_PACK_KIND);
    const packs = await Promise.all(
        metas.map(async (meta) => {
            try {
                return parsePack((await getDoc(meta.id))?.data);
            } catch {
                return null;
            }
        }),
    );
    return packs.filter((p): p is PrepPack => p !== null);
}

/** Removes the pack and its cards. */
export async function deletePack(pack: PrepPack): Promise<void> {
    await Promise.all(pack.lines.map((l) => deleteCard(l.cardId).catch(() => undefined)));
    await deleteDoc(packDocId(pack.nameKey));
}

export type PinInput = {
    epd: string;
    fen: string;
    ply: number;
    line: string[];
    /** Standard UCI of my replies (at least one). */
    answers: string[];
    answerSans?: string[];
};

/**
 * Pins a line: writes (or merges into) the `prep` card and records the line
 * on the pack. Returns the saved pack.
 */
export async function pinLine(
    pack: PrepPack,
    input: PinInput,
    now = Date.now(),
): Promise<PrepPack> {
    if (input.answers.length === 0) throw new Error("a pinned line needs a prepared reply");
    const cardId = prepCardId(pack.nameKey, input.epd);
    await addCard(
        {
            id: cardId,
            epd: input.epd,
            kind: PREP_CARD_KIND,
            answers: input.answers,
            source: { gameKey: prepSourceKey(pack.opponent), ply: input.ply + 1 },
            meta: {
                deadline: pack.deadline ?? undefined,
                opponent: pack.opponent,
                san: input.answerSans?.[0],
                playerColor: pack.mySide,
                line: input.line.join(" "),
                title: pack.opponent,
            },
        },
        now,
    );
    const line: PinnedLine = {
        epd: input.epd,
        fen: input.fen,
        ply: input.ply,
        line: input.line,
        answers: input.answers,
        answerSans: input.answerSans ?? [],
        cardId,
        pinnedAt: now,
    };
    const lines = pack.lines.filter((l) => l.epd !== input.epd);
    lines.push(line);
    lines.sort((a, b) => a.ply - b.ply || a.pinnedAt - b.pinnedAt);
    return savePack({ ...pack, lines }, now);
}

export async function unpinLine(pack: PrepPack, epd: string, now = Date.now()): Promise<PrepPack> {
    const line = pack.lines.find((l) => l.epd === epd);
    if (line) await deleteCard(line.cardId, now).catch(() => undefined);
    return savePack({ ...pack, lines: pack.lines.filter((l) => l.epd !== epd) }, now);
}

/** Sets the 比赛日 and copies it onto every card (`meta.deadline`). */
export async function setDeadline(
    pack: PrepPack,
    deadline: number | null,
    now = Date.now(),
): Promise<PrepPack> {
    for (const line of pack.lines) {
        await addCard(
            {
                id: line.cardId,
                epd: line.epd,
                kind: PREP_CARD_KIND,
                answers: line.answers,
                meta: { deadline: deadline ?? undefined, opponent: pack.opponent },
            },
            now,
        );
    }
    return savePack({ ...pack, deadline }, now);
}

// ---------------------------------------------------------------------------
// Post-game self-assessment

export function isMyPackSide(
    pack: Pick<PrepPack, "mySide">,
    review: Pick<Review, "playerColor">,
): boolean {
    return review.playerColor === null || review.playerColor === pack.mySide;
}

/** The opponent's name in a review (the other colour than mine); null without headers. */
export function opponentOfReview(review: Pick<Review, "playerColor" | "headers">): string | null {
    const h = review.headers;
    if (!h || !review.playerColor) return null;
    const name = review.playerColor === "white" ? h.black : h.white;
    return name?.trim() ? name.trim() : null;
}

/**
 * How far the game followed the pinned lines: the longest common SAN prefix
 * over the pack's lines. Null when the pack is for the other colour.
 */
export function assessPack(
    pack: PrepPack,
    review: Pick<Review, "gameKey" | "playerColor" | "plies" | "headers">,
    now = Date.now(),
): Assessment | null {
    if (!review.playerColor || review.playerColor !== pack.mySide) return null;
    const sans = [...review.plies].sort((a, b) => a.ply - b.ply).map((p) => p.san);
    let best = 0;
    let lineIndex: number | null = null;
    pack.lines.forEach((line, i) => {
        const n = followedPlies(line.line, sans);
        if (n > best) {
            best = n;
            lineIndex = i;
        }
    });
    return {
        gameKey: review.gameKey,
        date: review.headers?.date ?? null,
        playerColor: review.playerColor,
        followedPlies: best,
        followedMoves: Math.ceil(best / 2),
        lineIndex,
        result: review.headers?.result ?? "*",
        createdAt: now,
    };
}

export type AssessDeps = {
    listPacks: () => Promise<PrepPack[]>;
    savePack: (pack: PrepPack, now: number) => Promise<PrepPack>;
    now: () => number;
};

export function defaultAssessDeps(): AssessDeps {
    return { listPacks, savePack, now: () => Date.now() };
}

/**
 * After a review is saved: for every pack whose opponent is the game's
 * opponent (alias-aware), compute and store the assessment. Returns the
 * assessments written (one per matching pack).
 */
export async function assessAfterGame(
    review: Pick<Review, "gameKey" | "playerColor" | "plies" | "headers">,
    deps: AssessDeps = defaultAssessDeps(),
): Promise<Assessment[]> {
    const opponent = opponentOfReview(review);
    if (!opponent || !review.gameKey) return [];
    await ensureNamesReady();
    const packs = await deps.listPacks();
    const out: Assessment[] = [];
    for (const pack of packs) {
        if (!sameEntity(pack.opponent, opponent)) continue;
        const assessment = assessPack(pack, review, deps.now());
        if (!assessment) continue;
        const assessments = pack.assessments.filter((a) => a.gameKey !== review.gameKey);
        assessments.push(assessment);
        assessments.sort((a, b) => b.createdAt - a.createdAt);
        await deps.savePack({ ...pack, assessments }, deps.now());
        out.push(assessment);
    }
    return out;
}

let unsubscribe: (() => void) | null = null;

/** Subscribes `assessAfterGame` to `onReviewSaved` once. */
export function registerPrepReviewListener(): () => void {
    if (!unsubscribe) {
        const off = onReviewSaved((review) => {
            assessAfterGame(review).catch((e) =>
                console.warn("[chessin] prep assessment failed", e),
            );
        });
        unsubscribe = () => {
            off();
            unsubscribe = null;
        };
    }
    return unsubscribe;
}
