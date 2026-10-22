import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureNamesReady } from "@/chessin/names/aliases";
import {
    __setCardBackendForTests,
    awaitCardWrites,
    createMemoryCardBackend,
    getCard,
} from "@/chessin/notebook/cards";
import type { Review } from "@/chessin/review/model";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getDoc,
    listDocs,
} from "@/chessin/store/libraryStore";
import {
    assessAfterGame,
    assessPack,
    deletePack,
    listPacks,
    loadPack,
    newPack,
    opponentOfReview,
    packDocId,
    parsePack,
    pinLine,
    PREP_CARD_KIND,
    PREP_PACK_KIND,
    prepCardId,
    savePack,
    setDeadline,
    unpinLine,
} from "./pack";

const NOW = Date.UTC(2026, 9, 22);
const DEADLINE = Date.UTC(2026, 9, 25);
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4_E6 = "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const EPD_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
const EPD_E6 = "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";

const C5_LINE = {
    epd: EPD_C5,
    fen: AFTER_E4_C5,
    ply: 2,
    line: ["e4", "c5"],
    answers: ["g1f3"],
    answerSans: ["Nf3"],
};
const E6_LINE = {
    epd: EPD_E6,
    fen: AFTER_E4_E6,
    ply: 2,
    line: ["e4", "e6"],
    answers: ["d2d4"],
    answerSans: ["d4"],
};

function review(partial: Partial<Review> & { sans: string[] }): Review {
    const { sans, ...rest } = partial;
    return {
        version: 1,
        gameKey: "database:/dbs/club.db3#5",
        engine: "test",
        depth: 10,
        createdAt: NOW,
        playerColor: "white",
        preset: "full",
        headers: { white: "Me", black: "丁立人", result: "1-0", date: "2026.10.20" },
        plies: sans.map((san, i) => ({ ply: i + 1, san }) as Review["plies"][number]),
        moments: [],
        phases: {} as Review["phases"],
        summary: {} as Review["summary"],
        ...rest,
    };
}

beforeAll(async () => {
    await ensureNamesReady();
});

beforeEach(() => {
    __setLibraryBackendForTests(createMemoryBackend(() => NOW));
    __setCardBackendForTests(createMemoryCardBackend());
});

describe("prep pack storage", () => {
    it("round-trips a pack and rejects junk", () => {
        const pack = { ...newPack("Ding, Liren", "white", NOW), deadline: DEADLINE };
        expect(pack.nameKey).toBe("ding_liren");
        expect(parsePack(JSON.stringify(pack))).toEqual(pack);
        expect(parsePack("nope")).toBeNull();
        expect(parsePack('{"mySide":"white"}')).toBeNull();
        expect(
            parsePack(
                '{"opponent":"X","lines":[{"epd":"e"},{"bad":1}],"assessments":[{"gameKey":"g"}]}',
            ),
        ).toMatchObject({
            opponent: "X",
            nameKey: "x",
            mySide: "white",
            deadline: null,
            lines: [{ epd: "e", fen: "e", answers: [] }],
            assessments: [{ gameKey: "g", followedPlies: 0, lineIndex: null, result: "*" }],
        });
    });

    it("pins a line as a prep card with the deadline and the opponent in its meta", async () => {
        const pack = await savePack(
            { ...newPack("Ding, Liren", "white", NOW), deadline: DEADLINE },
            NOW,
        );
        const pinned = await pinLine(pack, C5_LINE, NOW);
        await awaitCardWrites();
        expect(pinned.lines).toEqual([
            { ...C5_LINE, cardId: prepCardId("ding_liren", EPD_C5), pinnedAt: NOW },
        ]);
        const card = await getCard(prepCardId("ding_liren", EPD_C5));
        expect(card).toMatchObject({
            kind: PREP_CARD_KIND,
            epd: EPD_C5,
            answers: ["g1f3"],
            source: { gameKey: "prep:Ding, Liren", ply: 3 },
            meta: {
                deadline: DEADLINE,
                opponent: "Ding, Liren",
                san: "Nf3",
                playerColor: "white",
                line: "e4 c5",
            },
        });
        // The pack document is stored under its kind and reloads by opponent (any spelling).
        expect((await getDoc(packDocId("ding_liren")))?.kind).toBe(PREP_PACK_KIND);
        expect((await loadPack("Liren Ding"))?.lines).toHaveLength(1);
        // Pinning again replaces the line; unpinning deletes the card.
        const again = await pinLine(
            pinned,
            { ...C5_LINE, answers: ["b1c3"], answerSans: ["Nc3"] },
            NOW + 1,
        );
        expect(again.lines).toHaveLength(1);
        expect(again.lines[0].answerSans).toEqual(["Nc3"]);
        const unpinned = await unpinLine(again, EPD_C5, NOW + 2);
        await awaitCardWrites();
        expect(unpinned.lines).toEqual([]);
        expect(await getCard(prepCardId("ding_liren", EPD_C5))).toBeNull();
        await expect(pinLine(pack, { ...C5_LINE, answers: [] })).rejects.toThrow(/reply/);
    });

    it("copies a new match day onto every card and lists / deletes packs", async () => {
        let pack = await pinLine(newPack("Ding, Liren", "white", NOW), C5_LINE, NOW);
        pack = await pinLine(pack, E6_LINE, NOW);
        pack = await setDeadline(pack, DEADLINE, NOW + 1);
        await awaitCardWrites();
        expect(pack.deadline).toBe(DEADLINE);
        for (const line of pack.lines) {
            expect((await getCard(line.cardId))?.meta.deadline).toBe(DEADLINE);
        }
        const other = await savePack(newPack("Carlsen, Magnus", "black", NOW), NOW);
        expect((await listPacks()).map((p) => p.opponent).sort()).toEqual([
            "Carlsen, Magnus",
            "Ding, Liren",
        ]);
        await deletePack(pack);
        await awaitCardWrites();
        expect((await listPacks()).map((p) => p.opponent)).toEqual([other.opponent]);
        expect(await getCard(pack.lines[0].cardId)).toBeNull();
    });
});

describe("post-game self-assessment", () => {
    it("measures how far the game followed the best pinned line", () => {
        const pack = {
            ...newPack("Ding, Liren", "white", NOW),
            lines: [
                { ...C5_LINE, line: ["e4", "c5", "Nf3", "d6", "d4"], cardId: "c", pinnedAt: NOW },
                { ...E6_LINE, cardId: "e", pinnedAt: NOW },
            ],
        };
        const followed = assessPack(
            pack,
            review({ sans: ["e4", "c5", "Nf3", "d6", "Nc3", "Nf6"] }),
            NOW,
        );
        expect(followed).toMatchObject({
            gameKey: "database:/dbs/club.db3#5",
            date: "2026.10.20",
            playerColor: "white",
            followedPlies: 4,
            followedMoves: 2,
            lineIndex: 0,
            result: "1-0",
            createdAt: NOW,
        });
        expect(assessPack(pack, review({ sans: ["d4", "d5"] }))).toMatchObject({
            followedPlies: 0,
            lineIndex: null,
        });
        expect(assessPack(pack, review({ sans: ["e4", "c5"], playerColor: "black" }))).toBeNull();
        expect(opponentOfReview(review({ sans: [] }))).toBe("丁立人");
        expect(opponentOfReview(review({ sans: [], playerColor: "black" }))).toBe("Me");
        expect(opponentOfReview(review({ sans: [], headers: undefined }))).toBeNull();
    });

    it("stores the assessment on every pack of that opponent, alias-aware, once per game", async () => {
        let ding = await pinLine(newPack("Ding, Liren", "white", NOW), C5_LINE, NOW);
        ding = await pinLine(ding, E6_LINE, NOW);
        await savePack(newPack("Carlsen, Magnus", "white", NOW), NOW);
        const saved: string[] = [];
        const deps = {
            listPacks,
            savePack: async (pack: Parameters<typeof savePack>[0], now: number) => {
                saved.push(pack.opponent);
                return savePack(pack, now);
            },
            now: () => NOW + 5,
        };
        const first = await assessAfterGame(review({ sans: ["e4", "e6", "d4", "d5"] }), deps);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            followedPlies: 2,
            followedMoves: 1,
            lineIndex: 1,
            createdAt: NOW + 5,
        });
        expect(saved).toEqual(["Ding, Liren"]);
        // A second review of the same game replaces the first assessment.
        await assessAfterGame(review({ sans: ["e4", "c5", "Nf3"] }), deps);
        const stored = await loadPack("Ding, Liren");
        expect(stored?.assessments).toHaveLength(1);
        expect(stored?.assessments[0]).toMatchObject({ followedPlies: 2, lineIndex: 0 });
        // Unknown opponent, no headers or the other colour: nothing written.
        expect(
            await assessAfterGame(
                review({ sans: ["e4"], headers: { white: "Me", black: "Nobody", result: "*" } }),
                deps,
            ),
        ).toEqual([]);
        expect(await assessAfterGame(review({ sans: ["e4"], headers: undefined }), deps)).toEqual(
            [],
        );
        expect(
            await assessAfterGame(
                review({
                    sans: ["e4"],
                    playerColor: "black",
                    headers: { white: "丁立人", black: "Me", result: "*" },
                }),
                deps,
            ),
        ).toEqual([]);
        expect((await listDocs(PREP_PACK_KIND)).length).toBe(2);
    });
});
