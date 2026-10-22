import { readDir } from "@tauri-apps/plugin-fs";
import { commands } from "@/bindings";
import { buildUserMoveIndex } from "@/chessin/repertoire/coverage";
import { parseMeta, type PlayerColor, repertoireMetaId } from "@/chessin/repertoire/model";
import { collectRepertoires } from "@/chessin/shell/repertoireFiles";
import { getDoc } from "@/chessin/store/libraryStore";
import { processEntriesRecursively } from "@/components/files/file";
import { parsePGN } from "@/utils/chess";
import { buildReplyIndex, type Reply } from "./briefing";

/**
 * My repertoire for one colour, as the two indexes the briefing's clash map
 * needs: positions with a prepared reply (`buildUserMoveIndex`) and the
 * replies themselves (`buildReplyIndex`). Reads the repertoire files of the
 * document folder (Tauri: `readDir`, `read_games`, the PGN lexer); files
 * that fail to parse are skipped.
 */

export type RepertoireIndex = {
    /** Paths of the repertoire files used. */
    files: string[];
    userMoveIndex: Map<string, Set<string>>;
    userReplies: Map<string, Reply[]>;
};

async function repertoireColor(path: string, headerColor: PlayerColor): Promise<PlayerColor> {
    try {
        const doc = await getDoc(repertoireMetaId(path));
        const meta = parseMeta(doc?.data);
        if (meta?.color) return meta.color;
    } catch {
        // no sidecar: the PGN's Orientation header decides
    }
    return headerColor;
}

export async function loadRepertoireIndex(
    documentDir: string,
    mySide: PlayerColor,
): Promise<RepertoireIndex> {
    const index: RepertoireIndex = { files: [], userMoveIndex: new Map(), userReplies: new Map() };
    if (!documentDir) return index;
    let files: { path: string }[] = [];
    try {
        const entries = await readDir(documentDir);
        files = collectRepertoires(await processEntriesRecursively(documentDir, entries));
    } catch {
        return index;
    }
    for (const file of files) {
        try {
            const res = await commands.readGames(file.path, 0, 0);
            if (res.status !== "ok" || !res.data[0]) continue;
            const tree = await parsePGN(res.data[0]);
            const color = await repertoireColor(file.path, tree.headers.orientation ?? "white");
            if (color !== mySide) continue;
            index.files.push(file.path);
            for (const [epd, ids] of buildUserMoveIndex(tree.root, mySide)) {
                const existing = index.userMoveIndex.get(epd);
                if (existing) for (const id of ids) existing.add(id);
                else index.userMoveIndex.set(epd, new Set(ids));
            }
            for (const [epd, replies] of buildReplyIndex(tree.root, mySide)) {
                const existing = index.userReplies.get(epd) ?? [];
                for (const reply of replies) {
                    if (!existing.some((r) => r.uci === reply.uci)) existing.push(reply);
                }
                index.userReplies.set(epd, existing);
            }
        } catch {
            // unreadable file: skip
        }
    }
    return index;
}
