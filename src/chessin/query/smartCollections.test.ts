import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseInfo } from "@/bindings";
import {
    __setLibraryBackendForTests,
    createMemoryBackend,
    getDoc,
} from "@/chessin/store/libraryStore";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { getQueryChips, setQueryChips } from "./chipsState";
import { type OpenSmartCollectionDeps, openSmartCollection } from "./openSmartCollection";
import { parseQuery } from "./parse";
import { pickPlayer, createPlayerResolver, type QueryPlayers } from "./resolvePlayer";
import {
    deleteSmartCollection,
    isSmartCollectionId,
    listSmartCollections,
    loadSmartCollection,
    newSmartCollectionId,
    orderForDatabase,
    parseSmartCollectionData,
    saveSmartCollection,
    SMART_COLLECTION_KIND,
} from "./smartCollections";

const DB_A = "/db/a.db3";
const DB_B = "/db/b.db3";

let now = 1_000_000;

beforeEach(() => {
    now = 1_000_000;
    __setLibraryBackendForTests(createMemoryBackend(() => (now += 1000)));
    sessionStorage.clear();
});

afterEach(() => {
    __setLibraryBackendForTests(null);
});

const chips = (text: string) => parseQuery(text).chips;

describe("smart collections", () => {
    it("saves a library document of kind smart_collection with chips + dbPath", async () => {
        const id = await saveSmartCollection({
            title: " 2600+ 白胜 ",
            chips: chips("elo>2600 result:胜"),
            dbPath: DB_A,
        });
        expect(isSmartCollectionId(id)).toBe(true);
        const doc = await getDoc(id);
        expect(doc?.kind).toBe(SMART_COLLECTION_KIND);
        expect(doc?.title).toBe("2600+ 白胜");
        expect(doc?.origin).toBe(DB_A);
        expect(JSON.parse(doc!.data)).toEqual({
            chips: chips("elo>2600 result:胜"),
            dbPath: DB_A,
        });
    });

    it("lists newest first, loads chips back and deletes", async () => {
        const first = await saveSmartCollection({ title: "one", chips: chips("A"), dbPath: DB_A });
        const second = await saveSmartCollection({ title: "two", chips: chips("B"), dbPath: DB_B });
        const list = await listSmartCollections();
        expect(list.map((sc) => sc.id)).toEqual([second, first]);
        expect(list[1]).toMatchObject({ title: "one", dbPath: DB_A, chips: chips("A") });

        const loaded = await loadSmartCollection(first);
        expect(loaded?.chips).toEqual(chips("A"));

        await deleteSmartCollection(first);
        expect(await loadSmartCollection(first)).toBeNull();
        expect((await listSmartCollections()).map((sc) => sc.id)).toEqual([second]);
    });

    it("replaces a collection when saving with the same id", async () => {
        const id = await saveSmartCollection({ title: "x", chips: chips("A"), dbPath: DB_A });
        await saveSmartCollection({ id, title: "y", chips: chips("B"), dbPath: DB_A });
        expect(await listSmartCollections()).toHaveLength(1);
        expect((await loadSmartCollection(id))?.title).toBe("y");
    });

    it("rejects malformed data and drops invalid chips", () => {
        expect(parseSmartCollectionData("not json")).toBeNull();
        expect(parseSmartCollectionData('{"chips":"x","dbPath":"/a"}')).toBeNull();
        expect(parseSmartCollectionData('{"chips":[],"dbPath":1}')).toBeNull();
        expect(
            parseSmartCollectionData(
                JSON.stringify({ chips: [...chips("elo>2600"), { key: "bogus" }], dbPath: DB_A }),
            ),
        ).toEqual({ chips: chips("elo>2600"), dbPath: DB_A });
    });

    it("orders the current database's collections first", () => {
        const base = { kind: SMART_COLLECTION_KIND, origin: null, updatedAt: 0, chips: [] };
        const list = [
            { ...base, id: "sc:1", title: "b1", dbPath: DB_B },
            { ...base, id: "sc:2", title: "a1", dbPath: DB_A },
            { ...base, id: "sc:3", title: "b2", dbPath: DB_B },
        ];
        expect(orderForDatabase(list, DB_A).map((sc) => sc.id)).toEqual(["sc:2", "sc:1", "sc:3"]);
        expect(newSmartCollectionId()).not.toBe(newSmartCollectionId());
    });
});

const dbA: SuccessDatabaseInfo = {
    type: "success",
    title: "Mega",
    description: "",
    filename: "a.db3",
    file: DB_A,
    game_count: 10,
    player_count: 3,
    event_count: 1,
    storage_size: BigInt(1),
    indexed: false,
};
const databases: DatabaseInfo[] = [
    dbA,
    { type: "error", filename: "b.db3", file: DB_B, error: "broken", indexed: false },
];

describe("openSmartCollection", () => {
    it("selects the database, stores the chips and navigates", () => {
        const setDatabase = vi.fn<OpenSmartCollectionDeps["setDatabase"]>();
        const navigate = vi.fn<OpenSmartCollectionDeps["navigate"]>();
        const setChips = vi.fn<OpenSmartCollectionDeps["setChips"]>();
        const result = openSmartCollection({ chips: chips("elo>2600"), dbPath: DB_A }, databases, {
            setDatabase,
            setChips,
            navigate,
        });
        expect(result).toEqual({ status: "opened", database: dbA });
        expect(setDatabase).toHaveBeenCalledWith(dbA);
        expect(setChips).toHaveBeenCalledWith(DB_A, chips("elo>2600"));
        expect(navigate).toHaveBeenCalledWith({
            to: "/databases/$databaseId",
            params: { databaseId: "Mega" },
        });
    });

    it("reports a missing or broken database without side effects", () => {
        const deps: OpenSmartCollectionDeps = {
            setDatabase: vi.fn<OpenSmartCollectionDeps["setDatabase"]>(),
            setChips: vi.fn<OpenSmartCollectionDeps["setChips"]>(),
            navigate: vi.fn<OpenSmartCollectionDeps["navigate"]>(),
        };
        expect(openSmartCollection({ chips: [], dbPath: DB_B }, databases, deps)).toEqual({
            status: "missing_db",
            dbPath: DB_B,
        });
        expect(
            openSmartCollection({ chips: [], dbPath: "/nope.db3" }, databases, deps).status,
        ).toBe("missing_db");
        expect(deps.setDatabase).not.toHaveBeenCalled();
        expect(deps.navigate).not.toHaveBeenCalled();
    });
});

describe("chips state", () => {
    it("keeps chips per database path and clears an emptied entry", () => {
        setQueryChips(DB_A, chips("elo>2600"));
        setQueryChips(DB_B, chips("Carlsen"));
        expect(getQueryChips(DB_A)).toEqual(chips("elo>2600"));
        expect(getQueryChips(DB_B)).toEqual(chips("Carlsen"));
        expect(JSON.parse(sessionStorage.getItem("chessin.query.chips") ?? "{}")).toHaveProperty(
            DB_A,
        );
        setQueryChips(DB_A, []);
        expect(getQueryChips(DB_A)).toEqual([]);
        expect(
            JSON.parse(sessionStorage.getItem("chessin.query.chips") ?? "{}"),
        ).not.toHaveProperty(DB_A);
    });
});

describe("player resolver", () => {
    it("prefers an exact name, then the highest rating", () => {
        const candidates = [
            { id: 1, name: "Carlsen, Henrik", elo: 2100 },
            { id: 2, name: "Carlsen, Magnus", elo: 2850 },
            { id: 3, name: "carlsen", elo: null },
        ];
        expect(pickPlayer("Carlsen", candidates)).toBe(3);
        expect(pickPlayer("Carlsen", candidates.slice(0, 2))).toBe(2);
        expect(pickPlayer("Carlsen", [])).toBeNull();
        expect(pickPlayer("   ", candidates)).toBeNull();
    });

    it("queries once per name (case-insensitive) and maps failures to null", async () => {
        const queryPlayers = vi.fn<QueryPlayers>(async (_db, query) => ({
            data: query.name === "Magnus" ? [{ id: 7, name: "Magnus", elo: 2800 }] : [],
            count: null,
        }));
        const resolve = createPlayerResolver(DB_A, queryPlayers);
        expect(await resolve("Magnus")).toBe(7);
        expect(await resolve("magnus")).toBe(7);
        expect(await resolve("Nobody")).toBeNull();
        expect(await resolve("")).toBeNull();
        expect(queryPlayers).toHaveBeenCalledTimes(2);
        expect(queryPlayers.mock.calls[0][1]).toMatchObject({
            name: "Magnus",
            options: { skipCount: true, sort: "elo", direction: "desc" },
        });

        const failing = createPlayerResolver(
            DB_A,
            vi.fn<QueryPlayers>(async () => {
                throw new Error("boom");
            }),
        );
        expect(await failing("Magnus")).toBeNull();
    });
});
