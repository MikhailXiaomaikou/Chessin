import { beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { DatabaseInfo, NormalizedGame, Player } from "@/bindings";
import { ensureNamesReady, setUserAliases } from "@/chessin/names/aliases";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getKv,
} from "@/chessin/store/libraryStore";
import type { LichessAccount } from "@/utils/lichess/api";
import {
    type Candidate,
    type CandidateDeps,
    canScoutOnline,
    confirmLink,
    evidenceFromLichess,
    fideQuery,
    findCandidates,
    inspectLichessAccount,
    isMinor,
    lastGameDate,
    linkKey,
    loadLinks,
    nameKey,
    normalizeFide,
    parseLinks,
    type QueryGames,
    type QueryPlayers,
    removeLink,
    searchTerms,
    totalGames,
} from "./candidates";

const NOW = Date.UTC(2026, 9, 22);

function db(file: string, type: "success" | "error" = "success"): DatabaseInfo {
    if (type === "error") {
        return { type: "error", file, filename: file, error: "nope", indexed: false };
    }
    return {
        type: "success",
        file,
        filename: file,
        title: file.includes("club") ? "Club games" : "",
        description: "",
        player_count: 10,
        event_count: 1,
        game_count: 100,
        storage_size: BigInt(0),
        indexed: false,
    };
}

type Table = Record<
    string,
    { players: Player[]; games: Record<number, { count: number; date: string | null }> }
>;

function fakeDeps(
    table: Table,
    fide: unknown | Error | null = null,
    options: { offline?: boolean; errorDb?: boolean } = {},
): CandidateDeps & {
    queryPlayers: Mock<QueryPlayers>;
    getFidePlayer: Mock<(query: string) => Promise<unknown>>;
} {
    const files = Object.keys(table);
    return {
        getDatabases: async () => [
            ...files.map((f) => db(f)),
            ...(options.errorDb ? [db("/dbs/broken.db3", "error")] : []),
        ],
        queryPlayers: vi.fn<QueryPlayers>(async (file, query) => {
            const needle = (query.name ?? "").toLowerCase();
            const data = (table[file]?.players ?? []).filter((p) =>
                (p.name ?? "").toLowerCase().includes(needle),
            );
            return { data, count: data.length };
        }),
        queryGames: vi.fn<QueryGames>(async (file, query) => {
            const entry = table[file]?.games[query.player1 ?? -1];
            if (!entry) return { data: [], count: 0 };
            const row = { id: 1, date: entry.date } as unknown as NormalizedGame;
            return { data: entry.count > 0 ? [row] : [], count: entry.count };
        }),
        getFidePlayer: vi.fn<(query: string) => Promise<unknown>>(async () => {
            if (fide instanceof Error) throw fide;
            if (fide === null) throw new Error("Player not found");
            return fide;
        }),
        isOffline: () => options.offline ?? false,
        now: () => NOW,
    };
}

const DING_FIDE = {
    id: 8603677,
    name: "Ding, Liren",
    federation: "CHN",
    title: "GM",
    year: 1992,
    standard: 2734,
    rapid: 2700,
    blitz: 2690,
};

beforeAll(async () => {
    await ensureNamesReady();
});

beforeEach(() => {
    __setLibraryBackendForTests(createMemoryBackend());
    setUserAliases([]);
});

describe("keys and terms", () => {
    it("keys a name independently of its order", () => {
        expect(nameKey("Ding, Liren")).toBe("ding_liren");
        expect(nameKey("Liren Ding")).toBe("ding_liren");
        expect(nameKey("丁立人")).toBe("丁立人");
    });

    it("derives LIKE terms and the FIDE query from any spelling", () => {
        expect(searchTerms("Ding, Liren")).toEqual(["liren", "ding"]);
        expect(searchTerms("丁立人")).toEqual(["丁立人", "liren", "ding"]);
        expect(searchTerms("Carlsen")).toEqual(["carlsen"]);
        expect(searchTerms("8603677")).toEqual([]);
        expect(searchTerms("")).toEqual([]);
        expect(fideQuery("8603677")).toBe("8603677");
        expect(fideQuery("Ding, Liren")).toBe("Ding, Liren");
        expect(fideQuery("丁立人")).toBe("liren ding");
        expect(fideQuery("张三")).toBe("zhang san");
        expect(fideQuery("")).toBeNull();
    });

    it("normalizes FIDE records and the adults-only rule", () => {
        expect(normalizeFide(DING_FIDE)).toEqual({ ...DING_FIDE });
        expect(normalizeFide({ id: "12", name: "X", year: "2012" })).toMatchObject({
            id: 12,
            year: 2012,
            federation: null,
        });
        expect(normalizeFide({ name: "no id" })).toBeNull();
        expect(normalizeFide(null)).toBeNull();
        expect(isMinor(2012, NOW)).toBe(true);
        expect(isMinor(2008, NOW)).toBe(false);
        expect(isMinor(null, NOW)).toBe(false);
    });
});

describe("findCandidates", () => {
    const table: Table = {
        "/dbs/club.db3": {
            players: [
                { id: 7, name: "Ding, Liren", elo: 2700 },
                { id: 8, name: "Ding, Yixin", elo: 2400 },
                { id: 9, name: "Carlsen, Magnus", elo: 2830 },
            ],
            games: {
                7: { count: 12, date: "2026.09.01" },
                8: { count: 3, date: "2025.01.01" },
                9: { count: 40, date: "2026.10.01" },
            },
        },
        "/dbs/lichess.db3": {
            players: [{ id: 2, name: "Liren Ding", elo: 2650 }],
            games: { 2: { count: 5, date: "2026.10.10" } },
        },
    };

    it("merges the same person across databases and attaches the FIDE record", async () => {
        const deps = fakeDeps(table, DING_FIDE, { errorDb: true });
        const result = await findCandidates("丁立人", deps);
        expect(result.databases).toBe(2);
        expect(result.offline).toBe(false);
        expect(result.fideError).toBeNull();
        expect(result.candidates.map((c) => c.name)).toEqual(["Ding, Liren"]);
        const ding = result.candidates[0];
        expect(ding).toMatchObject({
            key: "fide:8603677",
            zhName: "丁立人",
            birthYear: 1992,
            minor: false,
            score: 1,
        });
        expect(ding.fide).toEqual(DING_FIDE);
        expect(ding.sources.map((s) => [s.title, s.name, s.games, s.lastDate])).toEqual([
            ["Club games", "Ding, Liren", 12, "2026.09.01"],
            ["lichess", "Liren Ding", 5, "2026.10.10"],
        ]);
        expect(totalGames(ding)).toBe(17);
        expect(lastGameDate(ding)).toBe("2026.10.10");
        expect(deps.queryPlayers).toHaveBeenCalledWith(
            "/dbs/club.db3",
            expect.objectContaining({ name: "liren" }),
        );
        expect(deps.getFidePlayer).toHaveBeenCalledWith("liren ding");
    });

    it("ranks a surname query by match score, then games", async () => {
        const result = await findCandidates("Ding", fakeDeps(table, null));
        expect(result.fideError).toBe("Player not found");
        expect(result.candidates.map((c) => [c.name, c.score, totalGames(c)])).toEqual([
            ["Ding, Liren", 0.7, 17],
            ["Ding, Yixin", 0.7, 3],
        ]);
        expect(result.candidates[0].key).toBe("ding_liren");
    });

    it("skips the FIDE directory offline and drops an implausible FIDE hit", async () => {
        const offline = await findCandidates(
            "Carlsen",
            fakeDeps(table, DING_FIDE, { offline: true }),
        );
        expect(offline.offline).toBe(true);
        expect(offline.candidates.map((c) => c.name)).toEqual(["Carlsen, Magnus"]);
        expect(offline.candidates[0].fide).toBeNull();

        const mismatch = await findCandidates("Carlsen", fakeDeps(table, DING_FIDE));
        expect(mismatch.candidates.map((c) => c.name)).toEqual(["Carlsen, Magnus"]);
        expect(mismatch.candidates[0].fide).toBeNull();
    });

    it("searches the databases by the FIDE name for an id query and keeps FIDE-only hits", async () => {
        const byId = await findCandidates("8603677", fakeDeps(table, DING_FIDE));
        expect(byId.candidates.map((c) => c.name)).toEqual(["Ding, Liren"]);
        expect(byId.candidates[0].sources).toHaveLength(2);
        expect(byId.candidates[0].score).toBe(1);

        const junior = { id: 1, name: "Young, Player", federation: "CHN", year: 2012 };
        const fideOnly = await findCandidates("Young, Player", fakeDeps(table, junior));
        expect(fideOnly.candidates).toHaveLength(1);
        expect(fideOnly.candidates[0]).toMatchObject({
            key: "fide:1",
            sources: [],
            minor: true,
            birthYear: 2012,
        });
        expect(canScoutOnline(fideOnly.candidates[0])).toBe(false);

        expect((await findCandidates("   ", fakeDeps(table))).candidates).toEqual([]);
        expect(
            (await findCandidates("zzzz", fakeDeps(table, new Error("offline")))).fideError,
        ).toBe("offline");
    });
});

describe("online links", () => {
    const adult: Candidate = {
        key: "fide:8603677",
        name: "Ding, Liren",
        zhName: "丁立人",
        fide: { ...DING_FIDE },
        birthYear: 1992,
        minor: false,
        sources: [],
        score: 1,
    };
    const minor: Candidate = { ...adult, key: "fide:1", fide: null, birthYear: 2012, minor: true };

    it("stores a link only through explicit confirmation and never for a minor", async () => {
        expect(await loadLinks(adult)).toEqual([]);
        const links = await confirmLink(
            adult,
            {
                site: "lichess",
                username: "SomeUser",
                evidence: {
                    fideId: null,
                    fideRating: 2700,
                    realName: "Ding Liren",
                    title: "GM",
                    matchesFideId: false,
                },
            },
            NOW,
        );
        expect(links).toEqual([
            expect.objectContaining({ site: "lichess", username: "SomeUser", confirmedAt: NOW }),
        ]);
        expect(linkKey(adult)).toBe("prep.links.fide:8603677");
        expect(parseLinks(await getKv(linkKey(adult)))).toEqual(links);
        // Re-confirming the same account replaces it; unlinking removes it.
        const again = await confirmLink(adult, { ...links[0] }, NOW + 1);
        expect(again).toHaveLength(1);
        expect(await removeLink(adult, "lichess", "someuser")).toEqual([]);
        await expect(confirmLink(minor, links[0])).rejects.toThrow(/minors/);
        await expect(inspectLichessAccount(minor, "x")).rejects.toThrow(/minors/);
        expect(parseLinks("junk")).toEqual([]);
        expect(parseLinks('[{"site":"chesscom","username":"x"}]')).toEqual([]);
    });

    it("shows only what the profile states and whether a stated FIDE id matches", async () => {
        const account = {
            username: "SomeUser",
            title: "GM",
            profile: { fideRating: 2700, realName: "Ding Liren", fideId: 8603677 },
        } as unknown as LichessAccount;
        expect(evidenceFromLichess(account, adult)).toEqual({
            fideId: 8603677,
            fideRating: 2700,
            realName: "Ding Liren",
            title: "GM",
            matchesFideId: true,
        });
        expect(
            evidenceFromLichess({ profile: { firstName: "A", lastName: "B" } }, null),
        ).toMatchObject({
            realName: "A B",
            fideId: null,
            matchesFideId: false,
        });
        const found = await inspectLichessAccount(adult, " SomeUser ", async () => account);
        expect(found).toMatchObject({ username: "SomeUser", evidence: { matchesFideId: true } });
        expect(await inspectLichessAccount(adult, "ghost", async () => null)).toBeNull();
        expect(await inspectLichessAccount(adult, "", async () => account)).toBeNull();
    });
});
