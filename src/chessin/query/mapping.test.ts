import { describe, expect, it, vi } from "vitest";
import {
    eloRange,
    isUnconstrained,
    NO_PLAYER_ID,
    type PlayerResolver,
    splitUnsupported,
    toGameQuery,
    yearBounds,
    yearToDates,
} from "./mapping";
import { parseQuery } from "./parse";

const PLAYERS: Record<string, number> = {
    carlsen: 1,
    nakamura: 2,
    ding: 3,
};

const resolver = vi.fn<PlayerResolver>(async (name) => PLAYERS[name.toLowerCase()] ?? null);

function chips(text: string) {
    const { chips, errors } = parseQuery(text);
    if (errors.length) throw new Error(`parse errors: ${JSON.stringify(errors)}`);
    return chips;
}

describe("splitUnsupported", () => {
    it("marks eco / event / tc chips as unsupported keys", () => {
        const out = splitUnsupported(chips("eco:B90 event:Tata tc:classical white:Carlsen"));
        expect(out.map((u) => [u.chip.key, u.reason])).toEqual([
            ["eco", "key"],
            ["event", "key"],
            ["tc", "key"],
        ]);
    });

    it("keeps at most two players: extra coloured or colour-less chips are dropped", () => {
        expect(
            splitUnsupported(chips("white:A white:B")).map((u) => [u.chip.raw, u.reason]),
        ).toEqual([["white:B", "extra_player"]]);
        expect(splitUnsupported(chips("A B C")).map((u) => [u.chip.raw, u.reason])).toEqual([
            ["C", "extra_player"],
        ]);
        expect(
            splitUnsupported(chips("white:A black:B player:C")).map((u) => [u.chip.raw, u.reason]),
        ).toEqual([["player:C", "extra_player"]]);
        expect(splitUnsupported(chips("white:A player:C"))).toEqual([]);
    });

    it("keeps only the first result chip", () => {
        expect(
            splitUnsupported(chips("result:1-0 result:draw")).map((u) => [u.chip.raw, u.reason]),
        ).toEqual([["result:draw", "duplicate"]]);
    });
});

describe("eloRange / yearBounds", () => {
    it("intersects every elo chip and clamps to [0, 3000]", () => {
        expect(eloRange(chips("elo>2600"))).toEqual([2601, 3000]);
        expect(eloRange(chips("elo<2000"))).toEqual([0, 1999]);
        expect(eloRange(chips("elo:2400..2600"))).toEqual([2400, 2600]);
        expect(eloRange(chips("elo:2500"))).toEqual([2500, 2500]);
        expect(eloRange(chips("elo>2500 elo<2700"))).toEqual([2501, 2699]);
        expect(eloRange(chips("elo<5000"))).toEqual([0, 3000]);
        expect(eloRange(chips("white:Carlsen"))).toEqual([0, 3000]);
    });

    it("turns year chips into YYYY.MM.DD bounds", () => {
        expect(yearBounds(chips("year:2020"))).toEqual({ from: 2020, to: 2020 });
        expect(yearBounds(chips("year>2015"))).toEqual({ from: 2016, to: undefined });
        expect(yearBounds(chips("year<2000"))).toEqual({ from: undefined, to: 1999 });
        expect(yearBounds(chips("year:2020..2024 year>2021"))).toEqual({ from: 2022, to: 2024 });
        expect(yearToDates({ from: 2020, to: 2024 })).toEqual({
            start_date: "2020.01.01",
            end_date: "2024.12.31",
        });
        expect(yearToDates({})).toEqual({ start_date: undefined, end_date: undefined });
        expect(yearToDates({ from: 850 })).toEqual({
            start_date: "0850.01.01",
            end_date: undefined,
        });
    });
});

describe("toGameQuery", () => {
    it("maps white + black to player1 / player2 with sides WhiteBlack", async () => {
        const mapped = await toGameQuery(chips("white:Carlsen black:Nakamura"), resolver);
        expect(mapped.query).toMatchObject({ player1: 1, player2: 2, sides: "WhiteBlack" });
        expect(mapped.unsupported).toEqual([]);
        expect(mapped.unresolved).toEqual([]);
    });

    it("maps a lone black chip to sides BlackWhite", async () => {
        const mapped = await toGameQuery(chips("black:Ding"), resolver);
        expect(mapped.query).toMatchObject({ player1: 3, player2: undefined, sides: "BlackWhite" });
    });

    it("maps bare words and player: to sides Any, in order", async () => {
        const mapped = await toGameQuery(chips("Carlsen player:Nakamura"), resolver);
        expect(mapped.query).toMatchObject({ player1: 1, player2: 2, sides: "Any" });
    });

    it("gives a colour-less player the free colour next to a coloured one", async () => {
        const mapped = await toGameQuery(chips("black:Nakamura Carlsen"), resolver);
        expect(mapped.query).toMatchObject({ player1: 2, player2: 1, sides: "BlackWhite" });
    });

    it("sends NO_PLAYER_ID for a name nobody matches and reports it", async () => {
        const mapped = await toGameQuery(chips("white:Nobody"), resolver);
        expect(mapped.query.player1).toBe(NO_PLAYER_ID);
        expect(mapped.unresolved.map((c) => c.raw)).toEqual(["white:Nobody"]);
    });

    it("maps elo, year and result; eco / event / tc are excluded and never sent", async () => {
        const mapped = await toGameQuery(
            chips("elo>2600 year:2020..2024 result:draw eco:B90 event:Tata tc:blitz"),
            resolver,
        );
        expect(mapped.query).toEqual({
            player1: undefined,
            player2: undefined,
            sides: "WhiteBlack",
            range1: [2601, 3000],
            range2: [2601, 3000],
            outcome: "1/2-1/2",
            start_date: "2020.01.01",
            end_date: "2024.12.31",
        });
        expect(mapped.unsupported.map((u) => u.chip.key)).toEqual(["eco", "event", "tc"]);
        expect(JSON.stringify(mapped.query)).not.toContain("B90");
    });

    it("returns the defaults for no chips so stale filters are cleared", async () => {
        const mapped = await toGameQuery([], resolver);
        expect(mapped.query).toEqual({
            player1: undefined,
            player2: undefined,
            sides: "WhiteBlack",
            range1: [0, 3000],
            range2: [0, 3000],
            outcome: undefined,
            start_date: undefined,
            end_date: undefined,
        });
        expect(isUnconstrained(mapped)).toBe(true);
        expect(isUnconstrained(await toGameQuery(chips("eco:B90"), resolver))).toBe(true);
        expect(isUnconstrained(await toGameQuery(chips("elo>2600"), resolver))).toBe(false);
    });

    it("does not resolve players of excluded chips", async () => {
        const spy = vi.fn<PlayerResolver>(async (name) => PLAYERS[name.toLowerCase()] ?? null);
        await toGameQuery(chips("white:Carlsen black:Nakamura player:Ding"), spy);
        expect(spy.mock.calls.map((c) => c[0])).toEqual(["Carlsen", "Nakamura"]);
    });
});
