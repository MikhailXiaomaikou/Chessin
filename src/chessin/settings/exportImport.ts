/**
 * 导出设置 / 导入设置 (plan X-10): the registered settings (`defaults.ts`)
 * as one JSON file, written and read through the Tauri dialog + fs plugins.
 *
 * File shape (version 1):
 *   { "app": "chessin", "version": 1, "exportedAt": "...", "settings": { "<row id>": value } }
 *
 * Import is tolerant: unknown ids and values the entry does not `accept` are
 * skipped and reported, everything else is written to the store (so the
 * stored localStorage keys update too). Secrets never travel: account
 * sessions, engine configurations and tabs are not registered settings.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import { type JotaiStore, SETTING_ENTRIES, settingEntry } from "./defaults";

export const SETTINGS_FILE_APP = "chessin";
export const SETTINGS_FILE_VERSION = 1;
export const SETTINGS_FILE_NAME = "chessin-settings.json";

const settingsFileSchema = z.object({
    app: z.literal(SETTINGS_FILE_APP),
    version: z.number().int().positive(),
    exportedAt: z.string().optional(),
    settings: z.record(z.string(), z.unknown()),
});

export type SettingsFile = z.infer<typeof settingsFileSchema>;

export type ParseFailure = "json" | "format" | "version";

export type ParseResult = { ok: true; file: SettingsFile } | { ok: false; reason: ParseFailure };

export type ApplyResult = { applied: string[]; skipped: string[] };

/** Snapshot of every registered setting, defaults included (so a file documents them). */
export function collectSettings(store: JotaiStore, now: Date = new Date()): SettingsFile {
    const settings: Record<string, unknown> = {};
    for (const e of SETTING_ENTRIES) settings[e.id] = store.get(e.atom);
    return {
        app: SETTINGS_FILE_APP,
        version: SETTINGS_FILE_VERSION,
        exportedAt: now.toISOString(),
        settings,
    };
}

export function serializeSettings(file: SettingsFile): string {
    return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseSettingsFile(text: string): ParseResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: "json" };
    }
    const parsed = settingsFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "format" };
    if (parsed.data.version > SETTINGS_FILE_VERSION) return { ok: false, reason: "version" };
    return { ok: true, file: parsed.data };
}

/** Writes the accepted values into `store`; returns what was applied and what was skipped. */
export function applySettingsFile(store: JotaiStore, file: SettingsFile): ApplyResult {
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const [id, value] of Object.entries(file.settings)) {
        const e = settingEntry(id);
        if (!e || !e.accept(value)) {
            skipped.push(id);
            continue;
        }
        store.set(e.atom, value);
        applied.push(id);
    }
    return { applied, skipped };
}

export type ExportDeps = {
    save: (options: {
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
    }) => Promise<string | null>;
    writeTextFile: (path: string, contents: string) => Promise<void>;
};

export type ImportDeps = {
    open: (options: {
        multiple: false;
        directory: false;
        filters?: { name: string; extensions: string[] }[];
    }) => Promise<string | string[] | null>;
    readTextFile: (path: string) => Promise<string>;
};

const JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];

/** Asks where to save, writes the file; returns its path, or `null` when cancelled. */
export async function exportSettingsToFile(
    store: JotaiStore,
    deps: ExportDeps = { save, writeTextFile },
): Promise<string | null> {
    const path = await deps.save({ defaultPath: SETTINGS_FILE_NAME, filters: JSON_FILTER });
    if (!path) return null;
    await deps.writeTextFile(path, serializeSettings(collectSettings(store)));
    return path;
}

export type ImportOutcome =
    | { status: "cancelled" }
    | { status: "invalid"; reason: ParseFailure }
    | ({ status: "applied"; path: string } & ApplyResult);

/** Asks for a file, validates it and applies it. */
export async function importSettingsFromFile(
    store: JotaiStore,
    deps: ImportDeps = { open, readTextFile },
): Promise<ImportOutcome> {
    const selected = await deps.open({ multiple: false, directory: false, filters: JSON_FILTER });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return { status: "cancelled" };
    const parsed = parseSettingsFile(await deps.readTextFile(path));
    if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
    return { status: "applied", path, ...applySettingsFile(store, parsed.file) };
}
