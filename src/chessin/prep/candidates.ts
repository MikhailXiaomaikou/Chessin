import type {
    DatabaseInfo,
    GameQuery,
    NormalizedGame,
    Player,
    PlayerQuery,
    QueryResponse,
} from "@/bindings";
import { hasCjk } from "@/chessin/commands/pinyin";
import {
    allAliasGroups,
    chineseNameFor,
    ensureNamesReady,
    MATCH_SUBSTRING,
    MATCH_TOKEN,
    nameVariants,
    normalizeName,
    pinyinForms,
    sameEntity,
    scoreName,
    tokenKey,
} from "@/chessin/names/aliases";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { getKv, setKv } from "@/chessin/store/libraryStore";
import { getDefaultStore } from "jotai";
import { getDatabases, query_games, query_players } from "@/utils/db";
import { getFidePlayer, getLichessAccount, type LichessAccount } from "@/utils/lichess/api";

/**
 * Who is the opponent? (S4-2, teardown W1-1.)
 *
 * `findCandidates(query)` looks a name / FIDE id / 中文名 up in every local
 * database (`query_players`, with game counts and the last game date per
 * database) and in the FIDE directory served by Lichess (`getFidePlayer`),
 * and merges the hits into `Candidate`s by name (`@/chessin/names/aliases`).
 *
 * W1 boundaries, enforced here and in the page:
 * - adults only: a FIDE birth year under 18 marks the candidate `minor`;
 *   the page shows the notice and offers no online scouting at all;
 * - no silent identity matching: online accounts are never suggested from a
 *   name. A link is stored only through `confirmLink` after the user looked
 *   at the evidence (`inspectLichessAccount`) and said "我知道这是他".
 */

export const MINOR_AGE = 18;
export const LINK_KEY_PREFIX = "prep.links.";
export const DEFAULT_PER_DB_LIMIT = 5;
/** Players fetched per database and search term before scoring. */
const PLAYER_PAGE_SIZE = 25;

export type CandidateSource = {
    /** Database file path. */
    database: string;
    /** Database title (file name without extension when unknown). */
    title: string;
    playerId: number;
    /** Spelling in that database. */
    name: string;
    elo: number | null;
    games: number;
    /** `YYYY.MM.DD` of the newest game, when dated. */
    lastDate: string | null;
};

export type FideInfo = {
    id: number;
    name: string;
    federation: string | null;
    title: string | null;
    year: number | null;
    standard: number | null;
    rapid: number | null;
    blitz: number | null;
};

export type Candidate = {
    /** `fide:<id>` when known, else the order-free name key. */
    key: string;
    /** Display spelling (the database spelling with most games, else FIDE's). */
    name: string;
    /** Chinese spelling from the alias table, when known. */
    zhName: string | null;
    fide: FideInfo | null;
    birthYear: number | null;
    /** The FIDE birth year says under 18: no online scouting (W1). */
    minor: boolean;
    sources: CandidateSource[];
    /** Best name-match score of the query (1 = same person by spelling). */
    score: number;
};

export type CandidateSearch = {
    query: string;
    candidates: Candidate[];
    /** Databases that were searched. */
    databases: number;
    /** FIDE lookup skipped because offline mode is on. */
    offline: boolean;
    /** FIDE lookup failed (not found, network). */
    fideError: string | null;
};

export type QueryPlayers = (db: string, query: PlayerQuery) => Promise<QueryResponse<Player[]>>;
export type QueryGames = (db: string, query: GameQuery) => Promise<QueryResponse<NormalizedGame[]>>;

export type CandidateDeps = {
    getDatabases: () => Promise<DatabaseInfo[]>;
    queryPlayers: QueryPlayers;
    queryGames: QueryGames;
    /** Raw FIDE record from `getFidePlayer`; throws when not found / offline. */
    getFidePlayer: (query: string) => Promise<unknown>;
    isOffline: () => boolean;
    now: () => number;
    /** Players kept per database (default 5). */
    perDbLimit?: number;
};

function isOfflineNow(): boolean {
    try {
        if (getDefaultStore().get(offlineModeAtom)) return true;
        return localStorage.getItem("chessin.offline") === "true";
    } catch {
        return false;
    }
}

export function defaultCandidateDeps(): CandidateDeps {
    return {
        getDatabases,
        queryPlayers: query_players,
        queryGames: query_games,
        getFidePlayer,
        isOffline: isOfflineNow,
        now: () => Date.now(),
    };
}

// ---------------------------------------------------------------------------
// Keys and search terms

/** Order-free key of a name: "Ding, Liren" / "Liren Ding" → `ding_liren`; 丁立人 → `丁立人`. */
export function nameKey(name: string): string {
    return tokenKey(normalizeName(name)).replace(/\s+/g, "_");
}

export function isFideIdQuery(query: string): boolean {
    return /^\d{3,}$/.test(query.trim());
}

/**
 * Terms for the databases' `LIKE %term%` name filter: the two longest Latin
 * tokens of the query's spellings (so 丁立人 searches "liren", and
 * "Ding, Liren" finds "Liren Ding" too) plus the query itself when Chinese.
 */
export function searchTerms(query: string): string[] {
    const base = normalizeName(query);
    if (!base || isFideIdQuery(query)) return [];
    const tokens = new Set<string>();
    for (const variant of nameVariants(query)) {
        if (hasCjk(variant)) continue;
        const parts = variant.split(" ").filter(Boolean);
        if (parts.length >= 2) for (const p of parts) tokens.add(p);
        else if (variant === base) tokens.add(variant);
    }
    const ranked = Array.from(tokens)
        .filter((t) => t.length >= 3)
        .sort((a, b) => b.length - a.length || a.localeCompare(b));
    const out: string[] = ranked.slice(0, 2);
    if (out.length === 0 && tokens.size > 0) out.push(Array.from(tokens)[0]);
    if (hasCjk(base)) out.unshift(base);
    return out;
}

/** The spelling to send to the FIDE directory: ids as-is, Chinese names via alias table or pinyin. */
export function fideQuery(query: string): string | null {
    const base = normalizeName(query);
    if (!base) return null;
    if (isFideIdQuery(query)) return query.trim();
    if (!hasCjk(base)) return query.trim();
    for (const group of allAliasGroups()) {
        if (!group.some((n) => normalizeName(n) === base)) continue;
        const latin = group.find((n) => !hasCjk(n));
        if (latin) return normalizeName(latin);
    }
    const forms = pinyinForms(base);
    const spaced = forms.find((f) => f.includes(" ") && f.split(" ").length === 2);
    return spaced ?? null;
}

// ---------------------------------------------------------------------------
// FIDE

function num(value: unknown): number | null {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Accepts the Lichess FIDE API record; null when it has no id or name. */
export function normalizeFide(raw: unknown): FideInfo | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = num(r.id);
    const name = str(r.name);
    if (id === null || !name) return null;
    return {
        id,
        name,
        federation: str(r.federation),
        title: str(r.title),
        year: num(r.year),
        standard: num(r.standard),
        rapid: num(r.rapid),
        blitz: num(r.blitz),
    };
}

/** True when a birth year says the person is under `MINOR_AGE` at `now`. */
export function isMinor(birthYear: number | null, now: number): boolean {
    if (birthYear === null) return false;
    return new Date(now).getUTCFullYear() - birthYear < MINOR_AGE;
}

// ---------------------------------------------------------------------------
// Search

function databaseTitle(db: Extract<DatabaseInfo, { type: "success" }>): string {
    if (db.title?.trim()) return db.title.trim();
    const file = db.file.split(/[\\/]/).pop() ?? db.file;
    return file.replace(/\.db3$/i, "");
}

async function searchDatabase(
    db: Extract<DatabaseInfo, { type: "success" }>,
    query: string,
    terms: string[],
    deps: CandidateDeps,
): Promise<CandidateSource[]> {
    const players = new Map<number, Player>();
    for (const term of terms) {
        let res: QueryResponse<Player[]>;
        try {
            res = await deps.queryPlayers(db.file, {
                name: term,
                options: {
                    page: 1,
                    pageSize: PLAYER_PAGE_SIZE,
                    sort: "elo",
                    direction: "desc",
                    skipCount: true,
                },
            });
        } catch {
            continue;
        }
        for (const p of res.data) if (p.name) players.set(p.id, p);
    }
    const scored = Array.from(players.values())
        .map((p) => ({ player: p, match: scoreName(query, p.name ?? "") }))
        .filter((s) => s.match !== null && s.match.score >= MATCH_SUBSTRING)
        .sort(
            (a, b) => b.match!.score - a.match!.score || (b.player.elo ?? 0) - (a.player.elo ?? 0),
        )
        .slice(0, deps.perDbLimit ?? DEFAULT_PER_DB_LIMIT);
    const title = databaseTitle(db);
    const sources = await Promise.all(
        scored.map(async ({ player }): Promise<CandidateSource> => {
            let games = 0;
            let lastDate: string | null = null;
            try {
                const res = await deps.queryGames(db.file, {
                    player1: player.id,
                    sides: "Any",
                    options: {
                        page: 1,
                        pageSize: 1,
                        sort: "date",
                        direction: "desc",
                        skipCount: false,
                    },
                });
                games = res.count ?? res.data.length;
                lastDate = res.data[0]?.date ?? null;
            } catch {
                games = 0;
            }
            return {
                database: db.file,
                title,
                playerId: player.id,
                name: player.name ?? "",
                elo: player.elo ?? null,
                games,
                lastDate,
            };
        }),
    );
    return sources;
}

type Draft = Candidate & { names: string[] };

function findDraft(drafts: Draft[], name: string): Draft | undefined {
    return drafts.find((d) => d.names.some((n) => sameEntity(n, name)));
}

/**
 * Looks the query up in every local database and in the FIDE directory and
 * merges the hits by name. Never touches online game sites.
 */
export async function findCandidates(
    rawQuery: string,
    deps: CandidateDeps = defaultCandidateDeps(),
): Promise<CandidateSearch> {
    const query = rawQuery.trim();
    const result: CandidateSearch = {
        query,
        candidates: [],
        databases: 0,
        offline: false,
        fideError: null,
    };
    if (!query) return result;
    await ensureNamesReady();

    // FIDE first: an id query needs the name before the databases can be searched.
    let fide: FideInfo | null = null;
    const fq = fideQuery(query);
    if (fq) {
        if (deps.isOffline()) {
            result.offline = true;
        } else {
            try {
                fide = normalizeFide(await deps.getFidePlayer(fq));
                if (!fide) result.fideError = "not-found";
            } catch (e) {
                result.fideError = e instanceof Error ? e.message : String(e);
            }
        }
    }
    if (fide && !isFideIdQuery(query)) {
        // A name search returns FIDE's closest hit; keep it only when it is plausibly the person.
        const match = scoreName(query, fide.name);
        if (!match || match.score < MATCH_TOKEN) fide = null;
    }

    const terms = new Set(searchTerms(query));
    if (fide) for (const t of searchTerms(fide.name)) terms.add(t);

    let databases: DatabaseInfo[] = [];
    try {
        databases = await deps.getDatabases();
    } catch {
        databases = [];
    }
    const usable = databases.filter(
        (db): db is Extract<DatabaseInfo, { type: "success" }> => db.type === "success",
    );
    result.databases = usable.length;

    const drafts: Draft[] = [];
    if (terms.size > 0) {
        const perDb = await Promise.all(
            usable.map((db) =>
                searchDatabase(db, fide ? fide.name : query, Array.from(terms), deps),
            ),
        );
        for (const sources of perDb) {
            for (const source of sources) {
                const match =
                    scoreName(query, source.name) ??
                    (fide ? scoreName(fide.name, source.name) : null);
                const score = match?.score ?? 0;
                const draft = findDraft(drafts, source.name);
                if (draft) {
                    draft.sources.push(source);
                    if (!draft.names.includes(source.name)) draft.names.push(source.name);
                    draft.score = Math.max(draft.score, score);
                } else {
                    drafts.push({
                        key: nameKey(source.name),
                        name: source.name,
                        zhName: null,
                        fide: null,
                        birthYear: null,
                        minor: false,
                        sources: [source],
                        score,
                        names: [source.name],
                    });
                }
            }
        }
    }

    if (fide) {
        const draft = findDraft(drafts, fide.name);
        if (draft) {
            draft.fide = fide;
            draft.score = Math.max(
                draft.score,
                isFideIdQuery(query) ? 1 : (scoreName(query, fide.name)?.score ?? 0),
            );
        } else {
            drafts.push({
                key: `fide:${fide.id}`,
                name: fide.name,
                zhName: null,
                fide,
                birthYear: null,
                minor: false,
                sources: [],
                score: isFideIdQuery(query) ? 1 : (scoreName(query, fide.name)?.score ?? 0),
                names: [fide.name],
            });
        }
    }

    const now = deps.now();
    result.candidates = drafts
        .map((draft): Candidate => {
            const { names: _names, ...candidate } = draft;
            const bySpelling = new Map<string, number>();
            for (const s of candidate.sources) {
                bySpelling.set(s.name, (bySpelling.get(s.name) ?? 0) + s.games);
            }
            const best = Array.from(bySpelling.entries()).sort((a, b) => b[1] - a[1])[0];
            const name = best?.[0] || candidate.name;
            const birthYear = candidate.fide?.year ?? null;
            return {
                ...candidate,
                key: candidate.fide ? `fide:${candidate.fide.id}` : nameKey(name),
                name,
                zhName: chineseNameFor(name),
                birthYear,
                minor: isMinor(birthYear, now),
                sources: [...candidate.sources].sort((a, b) => b.games - a.games),
            };
        })
        .sort(
            (a, b) =>
                b.score - a.score || totalGames(b) - totalGames(a) || a.name.localeCompare(b.name),
        );
    return result;
}

export function totalGames(candidate: Pick<Candidate, "sources">): number {
    return candidate.sources.reduce((acc, s) => acc + s.games, 0);
}

/** `YYYY.MM.DD` of the newest game across the sources. */
export function lastGameDate(candidate: Pick<Candidate, "sources">): string | null {
    let last: string | null = null;
    for (const s of candidate.sources) {
        if (s.lastDate && (!last || s.lastDate > last)) last = s.lastDate;
    }
    return last;
}

// ---------------------------------------------------------------------------
// Online account links (explicit confirmation only)

export type OnlineSite = "lichess";

export type LinkEvidence = {
    /** A FIDE id the profile states itself (the Lichess API has no such field today). */
    fideId: number | null;
    /** `profile.fideRating` as the user entered it on Lichess (self-declared). */
    fideRating: number | null;
    /** `profile.realName` (or first + last name on older payloads). */
    realName: string | null;
    title: string | null;
    /** The stated FIDE id equals the candidate's. */
    matchesFideId: boolean;
};

export type OnlineLink = {
    site: OnlineSite;
    username: string;
    /** When the user confirmed "我知道这是他". */
    confirmedAt: number;
    evidence: LinkEvidence;
};

export function linkKey(candidate: Pick<Candidate, "key">): string {
    return `${LINK_KEY_PREFIX}${candidate.key}`;
}

/** Online scouting is off for minors (W1): no account inspection, no links. */
export function canScoutOnline(candidate: Pick<Candidate, "minor">): boolean {
    return !candidate.minor;
}

export function parseLinks(raw: string | null | undefined): OnlineLink[] {
    if (!raw) return [];
    try {
        const json: unknown = JSON.parse(raw);
        if (!Array.isArray(json)) return [];
        const out: OnlineLink[] = [];
        for (const item of json) {
            if (!item || typeof item !== "object") continue;
            const r = item as Record<string, unknown>;
            if (r.site !== "lichess" || typeof r.username !== "string" || !r.username) continue;
            const ev = (r.evidence && typeof r.evidence === "object" ? r.evidence : {}) as Record<
                string,
                unknown
            >;
            out.push({
                site: "lichess",
                username: r.username,
                confirmedAt: typeof r.confirmedAt === "number" ? r.confirmedAt : 0,
                evidence: {
                    fideId: num(ev.fideId),
                    fideRating: num(ev.fideRating),
                    realName: str(ev.realName),
                    title: str(ev.title),
                    matchesFideId: ev.matchesFideId === true,
                },
            });
        }
        return out;
    } catch {
        return [];
    }
}

export async function loadLinks(candidate: Pick<Candidate, "key">): Promise<OnlineLink[]> {
    try {
        return parseLinks(await getKv(linkKey(candidate)));
    } catch {
        return [];
    }
}

/** Stores a link the user confirmed explicitly; refuses for minors. */
export async function confirmLink(
    candidate: Pick<Candidate, "key" | "minor">,
    link: Omit<OnlineLink, "confirmedAt">,
    now = Date.now(),
): Promise<OnlineLink[]> {
    if (!canScoutOnline(candidate)) throw new Error("online scouting is off for minors");
    const links = (await loadLinks(candidate)).filter(
        (l) => !(l.site === link.site && l.username.toLowerCase() === link.username.toLowerCase()),
    );
    links.push({ ...link, confirmedAt: now });
    await setKv(linkKey(candidate), JSON.stringify(links));
    return links;
}

export async function removeLink(
    candidate: Pick<Candidate, "key">,
    site: OnlineSite,
    username: string,
): Promise<OnlineLink[]> {
    const links = (await loadLinks(candidate)).filter(
        (l) => !(l.site === site && l.username.toLowerCase() === username.toLowerCase()),
    );
    await setKv(linkKey(candidate), JSON.stringify(links));
    return links;
}

/** What a Lichess profile states about itself (shown as evidence, never used to auto-link). */
export function evidenceFromLichess(
    account: Partial<LichessAccount> | Record<string, unknown>,
    candidate: Pick<Candidate, "fide"> | null,
): LinkEvidence {
    const a = account as Record<string, unknown>;
    const profile = (a.profile && typeof a.profile === "object" ? a.profile : {}) as Record<
        string,
        unknown
    >;
    const fideId = num(profile.fideId ?? a.fideId);
    const first = str(profile.firstName);
    const last = str(profile.lastName);
    const realName =
        str(profile.realName) ?? (first || last ? [first, last].filter(Boolean).join(" ") : null);
    return {
        fideId,
        fideRating: num(profile.fideRating),
        realName,
        title: str(a.title),
        matchesFideId: fideId !== null && candidate?.fide?.id === fideId,
    };
}

export type AccountInspection = {
    username: string;
    account: LichessAccount;
    evidence: LinkEvidence;
};

/**
 * Fetches a Lichess profile the user typed in and extracts the evidence for
 * the confirmation dialog. Refuses for minors; null when the account does
 * not exist or the app is offline.
 */
export async function inspectLichessAccount(
    candidate: Pick<Candidate, "fide" | "minor">,
    username: string,
    fetchAccount: (username: string) => Promise<LichessAccount | null> = (u) =>
        getLichessAccount({ username: u }),
): Promise<AccountInspection | null> {
    if (!canScoutOnline(candidate)) throw new Error("online scouting is off for minors");
    const name = username.trim();
    if (!name) return null;
    const account = await fetchAccount(name);
    if (!account) return null;
    return {
        username: account.username || name,
        account,
        evidence: evidenceFromLichess(account, candidate),
    };
}
