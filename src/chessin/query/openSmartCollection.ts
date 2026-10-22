import type { DatabaseInfo } from "@/bindings";
import type { SuccessDatabaseInfo } from "@/utils/db";
import type { Chip } from "./parse";
import type { SmartCollectionData } from "./smartCollections";

/**
 * Opening a smart collection = select its database (which resets the games
 * query, as a double-click on the database card does), put the chips in the
 * bar's state, then navigate to the games table. The bar applies the chips
 * to the query when it mounts.
 */

export type OpenSmartCollectionDeps = {
    setDatabase: (db: SuccessDatabaseInfo) => void;
    setChips: (file: string, chips: Chip[]) => void;
    navigate: (opts: { to: "/databases/$databaseId"; params: { databaseId: string } }) => unknown;
};

export type OpenSmartCollectionResult =
    | { status: "opened"; database: SuccessDatabaseInfo }
    | { status: "missing_db"; dbPath: string };

export function findSmartCollectionDatabase(
    dbPath: string,
    databases: DatabaseInfo[],
): SuccessDatabaseInfo | null {
    const db = databases.find((d) => d.file === dbPath);
    return db && db.type === "success" ? db : null;
}

export function openSmartCollection(
    sc: SmartCollectionData,
    databases: DatabaseInfo[],
    deps: OpenSmartCollectionDeps,
): OpenSmartCollectionResult {
    const database = findSmartCollectionDatabase(sc.dbPath, databases);
    if (!database) return { status: "missing_db", dbPath: sc.dbPath };
    deps.setDatabase(database);
    deps.setChips(database.file, sc.chips);
    deps.navigate({ to: "/databases/$databaseId", params: { databaseId: database.title } });
    return { status: "opened", database };
}
