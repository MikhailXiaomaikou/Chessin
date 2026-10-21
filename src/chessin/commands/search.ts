import Fuse from "fuse.js";
import { pinyinIndex } from "./pinyin";
import type { Command } from "./registry";

export type IndexedCommand = {
    cmd: Command;
    id: string;
    title: string;
    section: string;
    aliases: string[];
    pinyinFull: string;
    pinyinInitials: string;
};

const NO_PINYIN = { full: "", initials: "" };

/**
 * Resolves titles and builds the pinyin index for every command.
 * `pinyin: false` skips the pinyin columns (used until `pinyin-pro` has loaded).
 */
export function indexCommands(
    commands: Command[],
    options: { pinyin?: boolean } = {},
): IndexedCommand[] {
    const toPinyin = options.pinyin === false ? () => NO_PINYIN : pinyinIndex;
    return commands.map((cmd) => {
        const title = cmd.title();
        const aliases = cmd.aliases ?? [];
        const own = toPinyin(title);
        const aliasPinyin = aliases.map(toPinyin);
        return {
            cmd,
            id: cmd.id,
            title,
            section: cmd.section,
            aliases,
            pinyinFull: [own.full, ...aliasPinyin.map((p) => p.full)].filter(Boolean).join(" "),
            pinyinInitials: [own.initials, ...aliasPinyin.map((p) => p.initials)]
                .filter(Boolean)
                .join(" "),
        };
    });
}

export function buildFuse(entries: IndexedCommand[]): Fuse<IndexedCommand> {
    return new Fuse(entries, {
        keys: [
            { name: "title", weight: 3 },
            { name: "aliases", weight: 2 },
            { name: "pinyinFull", weight: 1.5 },
            { name: "pinyinInitials", weight: 1.5 },
            { name: "id", weight: 0.5 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
        includeScore: true,
        minMatchCharLength: 1,
    });
}

/** Returns matching commands best-first; an empty query returns all entries in registration order. */
export function searchCommands(
    entries: IndexedCommand[],
    fuse: Fuse<IndexedCommand>,
    query: string,
): IndexedCommand[] {
    const q = query.trim();
    if (q.length === 0) return entries;
    return fuse.search(q).map((r) => r.item);
}
