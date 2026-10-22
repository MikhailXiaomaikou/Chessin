import { notifications } from "@mantine/notifications";
import { basename, resolve, tempDir } from "@tauri-apps/api/path";
import { remove } from "@tauri-apps/plugin-fs";
import { warn } from "@tauri-apps/plugin-log";
import i18n from "i18next";
import { commands as appCommands } from "@/bindings";
import { type CbhImportReport, commands, type Result } from "@/chessin/bindings";
import { getDatabasesDir } from "@/utils/directories";
import { unwrap } from "@/utils/unwrap";

export type { CbhImportReport };

/** Whether a path is a ChessBase header file: `.cbh` (ChessBase 6–16) or `.2cbh` (17+). */
export function isCbhPath(path: string): boolean {
    return /\.2?cbh$/i.test(path);
}

/** Whether a path is a ChessBase 17+ header file (`.2cbh`). */
export function isTwoCbhPath(path: string): boolean {
    return /\.2cbh$/i.test(path);
}

type TwoCbhCommand = (path: string, outPgnPath: string) => Promise<Result<CbhImportReport, string>>;

/**
 * The `twocbh_to_pgn` plugin command, looked up at call time so a build whose
 * bindings predate it still compiles and simply reports `.2cbh` as unavailable.
 */
function getTwoCbhCommand(): TwoCbhCommand | null {
    const command = (commands as Record<string, unknown>).twocbhToPgn;
    return typeof command === "function" ? (command as TwoCbhCommand) : null;
}

/** True when this build can import `.2cbh` databases. */
export function isTwoCbhImportAvailable(): boolean {
    return getTwoCbhCommand() !== null;
}

/** A database title derived from the `.cbh` / `.2cbh` file name. */
export async function cbhTitle(cbhPath: string): Promise<string> {
    return (await basename(cbhPath)).replace(/\.2?cbh$/i, "");
}

export type CbhConversion = { pgnPath: string; report: CbhImportReport };

/**
 * Converts a `.cbh` or `.2cbh` database into a temporary PGN file through the
 * `cbh_to_pgn` / `twocbh_to_pgn` plugin command. The caller imports the PGN
 * (for example with `commands.convertPgn`) and then calls `removeTempPgn`.
 */
export async function cbhToTempPgn(cbhPath: string): Promise<CbhConversion> {
    const name = `chessin-cbh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pgn`;
    const pgnPath = await resolve(await tempDir(), name);
    let result: Result<CbhImportReport, string>;
    if (isTwoCbhPath(cbhPath)) {
        const twocbh = getTwoCbhCommand();
        if (!twocbh) throw new Error(i18n.t("FirstRun.Scan.NotYet2cbh"));
        result = await twocbh(cbhPath, pgnPath);
    } else {
        result = await commands.cbhToPgn(cbhPath, pgnPath);
    }
    const report = unwrap(result);
    for (const warning of report.warnings) {
        warn(`[cbh] ${cbhPath}: ${warning}`);
    }
    return { pgnPath, report };
}

/** Deletes a temporary PGN; failures are ignored since the OS cleans the temp dir. */
export async function removeTempPgn(pgnPath: string): Promise<void> {
    try {
        await remove(pgnPath);
    } catch {
        // Outside the fs scope or already gone.
    }
}

/**
 * Imports a ChessBase database: `.cbh` / `.2cbh` -> temporary PGN -> `.db3`
 * through the existing `convert_pgn` command. `targetDbPath` defaults to
 * `<databases dir>/<cbh name>.db3`.
 */
export async function importCbhFile(
    cbhPath: string,
    targetDbPath?: string,
    options?: { title?: string; description?: string },
): Promise<CbhImportReport> {
    const title = options?.title ?? (await cbhTitle(cbhPath));
    const dbPath = targetDbPath ?? (await resolve(await getDatabasesDir(), `${title}.db3`));
    const { pgnPath, report } = await cbhToTempPgn(cbhPath);
    try {
        unwrap(
            await appCommands.convertPgn(
                [pgnPath],
                dbPath,
                null,
                title,
                options?.description ?? null,
            ),
        );
    } finally {
        await removeTempPgn(pgnPath);
    }
    return report;
}

/** Merges the reports of one or more databases into the lines of a notification. */
export function describeCbhReports(reports: CbhImportReport[]): string[] {
    const sum = (f: (r: CbhImportReport) => number) => reports.reduce((acc, r) => acc + f(r), 0);
    const games = sum((r) => r.games);
    const exported = sum((r) => r.exported);
    const skipped = sum((r) => r.skipped);
    const unsupported = new Map<string, number>();
    for (const r of reports) {
        for (const u of r.unsupported) {
            unsupported.set(u.kind, (unsupported.get(u.kind) ?? 0) + u.count);
        }
    }
    const warnings = sum((r) => r.warnings.length);
    const lines = [i18n.t("Import.Cbh.Summary", { exported, games, skipped })];
    if (unsupported.size > 0) {
        const kinds = [...unsupported].map(([kind, n]) => `${kind} ×${n}`).join(", ");
        lines.push(i18n.t("Import.Cbh.Unsupported", { kinds }));
    }
    const encodings = [...new Set(reports.map((r) => r.encoding))].join(", ");
    lines.push(i18n.t("Import.Cbh.Encoding", { encoding: encodings }));
    if (warnings > 0) {
        lines.push(i18n.t("Import.Cbh.Warnings", { n: warnings }));
    }
    return lines;
}

/** Shows the import report as a short notification. */
export function showCbhReport(reports: CbhImportReport[]): void {
    if (reports.length === 0) return;
    const skipped = reports.reduce((acc, r) => acc + r.skipped, 0);
    notifications.show({
        title: i18n.t("Import.Cbh.Title"),
        message: describeCbhReports(reports).join("\n"),
        color: skipped > 0 ? "yellow" : "green",
        autoClose: 10_000,
        style: { whiteSpace: "pre-line" },
    });
}
