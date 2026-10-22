import { beforeEach, describe, expect, it } from "vitest";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getDoc,
} from "@/chessin/store/libraryStore";
import type { Session } from "@/utils/session";
import {
    bucketFor,
    defaultMeta,
    eloRangeAround,
    formatEloRange,
    inferDefaults,
    isUserTurn,
    lichessRatingsFor,
    lichessSpeedsFor,
    loadRepertoireMeta,
    parseMeta,
    REPERTOIRE_META_KIND,
    repertoireMetaId,
    saveRepertoireMeta,
    toEpd,
    withDefaults,
} from "./model";

function lichessSession(
    perfs: Record<string, { rating: number; games: number }>,
    fide = 0,
): Session {
    return {
        updatedAt: 0,
        lichess: {
            username: "alice",
            account: { perfs, profile: { fideRating: fide } },
        },
    } as unknown as Session;
}

function chessComSession(stats: Record<string, { rating: number; games: number }>): Session {
    const mapped: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(stats)) {
        mapped[key] = {
            last: { rating: v.rating, date: 0, rd: 0 },
            record: { win: v.games, loss: 0, draw: 0 },
        };
    }
    return { updatedAt: 0, chessCom: { username: "bob", stats: mapped } } as unknown as Session;
}

describe("rating buckets", () => {
    it("maps a rating to the explorer band around it", () => {
        expect(bucketFor(1712)).toBe(1600);
        expect(eloRangeAround(1712)).toEqual([1600, 1800]);
        expect(eloRangeAround(2600)).toEqual([2500, 3200]);
        expect(eloRangeAround(800)).toEqual([0, 1000]);
        expect(formatEloRange([1600, 1800])).toBe("1600–1800");
    });

    it("selects every bucket a range overlaps, never none", () => {
        expect(lichessRatingsFor([1600, 1800])).toEqual([1600]);
        expect(lichessRatingsFor([1500, 1900])).toEqual([1400, 1600, 1800]);
        expect(lichessRatingsFor([1700, 1700])).toEqual([1600]);
        expect(lichessRatingsFor([1900, 1500])).toEqual([1400, 1600, 1800]);
        expect(lichessRatingsFor([2700, 3000])).toEqual([2500]);
        expect(lichessSpeedsFor("blitz")).toEqual(["blitz"]);
        expect(lichessSpeedsFor("classical")).toEqual(["classical"]);
    });
});

describe("inferDefaults", () => {
    it("prefers the Lichess pool with the most games", () => {
        const d = inferDefaults([
            lichessSession({
                blitz: { rating: 1850, games: 1000 },
                rapid: { rating: 1700, games: 50 },
            }),
        ]);
        expect(d).toMatchObject({
            eloRange: [1800, 2000],
            timeControl: "blitz",
            ratingSource: "lichess",
        });
        expect(d.from?.account).toBe("alice");
    });

    it("falls back to chess.com, then FIDE, then the built-in band", () => {
        expect(
            inferDefaults([chessComSession({ chess_rapid: { rating: 1250, games: 300 } })]),
        ).toMatchObject({
            eloRange: [1200, 1400],
            timeControl: "rapid",
            ratingSource: "lichess",
        });
        expect(inferDefaults([lichessSession({}, 2150)])).toMatchObject({
            eloRange: [2000, 2200],
            timeControl: "classical",
            ratingSource: "fide",
        });
        expect(inferDefaults([])).toMatchObject({
            eloRange: [1600, 1800],
            timeControl: "rapid",
            ratingSource: "lichess",
            from: null,
        });
        // Pools without games (provisional, unplayed) are ignored.
        expect(
            inferDefaults([lichessSession({ blitz: { rating: 1500, games: 0 } })]).from,
        ).toBeNull();
    });

    it("builds a complete meta document", () => {
        const meta = defaultMeta({ color: "black", startFen: "fen", sessions: [] });
        expect(meta).toEqual({
            color: "black",
            startFen: "fen",
            eloRange: [1600, 1800],
            ratingSource: "lichess",
            timeControl: "rapid",
            coverageTarget: 100,
            coldThreshold: 0.01,
            depth: 10,
        });
    });
});

describe("meta persistence", () => {
    beforeEach(() => {
        __setLibraryBackendForTests(createMemoryBackend());
    });

    it("parses stored payloads leniently", () => {
        expect(parseMeta(null)).toBeNull();
        expect(parseMeta("{not json")).toBeNull();
        expect(parseMeta('{"eloRange":[1000,1200],"timeControl":"bullet"}')).toBeNull();
        expect(parseMeta('{"eloRange":[1000,1200]}')).toEqual({ eloRange: [1000, 1200] });
        const fallback = defaultMeta({ color: "white", startFen: "f" });
        expect(withDefaults({ coverageTarget: 50 }, fallback)).toEqual({
            ...fallback,
            coverageTarget: 50,
        });
        expect(withDefaults(null, fallback)).toBe(fallback);
    });

    it("round-trips through the library store under rep:<path>", async () => {
        const fallback = defaultMeta({ color: "white", startFen: "f" });
        const path = "/repertoires/sicilian.pgn";
        expect(await loadRepertoireMeta(path, fallback)).toEqual({ meta: fallback, stored: false });
        await saveRepertoireMeta(path, "Sicilian", {
            ...fallback,
            eloRange: [2000, 2200],
            depth: 12,
        });
        const doc = await getDoc(repertoireMetaId(path));
        expect(doc?.kind).toBe(REPERTOIRE_META_KIND);
        expect(doc?.id).toBe("rep:/repertoires/sicilian.pgn");
        expect(doc?.origin).toBe(path);
        const loaded = await loadRepertoireMeta(path, fallback);
        expect(loaded.stored).toBe(true);
        expect(loaded.meta.eloRange).toEqual([2000, 2200]);
        expect(loaded.meta.depth).toBe(12);
    });

    it("reduces FENs to EPDs and knows whose turn it is", () => {
        expect(toEpd("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
        );
        expect(isUserTurn(0, "white")).toBe(true);
        expect(isUserTurn(1, "white")).toBe(false);
        expect(isUserTurn(1, "black")).toBe(true);
    });
});
