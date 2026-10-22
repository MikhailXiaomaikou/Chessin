/**
 * Pure text model for the trash notification (no React / i18next imports so
 * it can be unit tested with a fake `t`).
 */
import type { TrashItem } from "./paths";

/** How the deletion actually happened. */
export type TrashMode =
    /** Moved to the OS recycle bin via `move_to_trash`. */
    | "trash"
    /** `move_to_trash` is not available in this build: deleted for good. */
    | "permanent";

export type TrashResult = {
    mode: TrashMode;
    /** Items whose primary path was moved (or deleted). */
    moved: TrashItem[];
    /** Items whose primary path could not be moved (or deleted). */
    failed: TrashItem[];
    /** Side files (`-wal`, `.info`, ...) that stayed behind although their item moved. */
    leftovers: string[];
};

export type NoticeColor = "green" | "yellow" | "red";

export type NoticeText = {
    title: string;
    lines: string[];
    color: NoticeColor;
};

/** Names listed in a notice before collapsing into "...and N more". */
export const NOTICE_MAX_LINES = 5;

export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** Caps a list of lines, replacing the tail with a translated "...and N more". */
export function capLines(lines: string[], t: TranslateFn, max = NOTICE_MAX_LINES): string[] {
    if (lines.length <= max) return lines;
    const shown = lines.slice(0, max);
    shown.push(t("Trash.MoreItems", { number: lines.length - max }));
    return shown;
}

/**
 * Builds the notice(s) for a trash result: one for what moved (title says
 * whether it went to the recycle bin or was deleted permanently) and, when
 * anything failed or stayed behind, a second red one listing it.
 */
export function buildTrashNotices(result: TrashResult, t: TranslateFn): NoticeText[] {
    const notices: NoticeText[] = [];

    if (result.moved.length > 0) {
        const permanent = result.mode === "permanent";
        notices.push({
            title: permanent ? t("Trash.DeletedPermanently") : t("Trash.Moved"),
            lines: capLines(
                result.moved.map((item) => item.name),
                t,
            ),
            color: permanent ? "yellow" : "green",
        });
    }

    const problems = [...result.failed.map((item) => item.name), ...result.leftovers];
    if (problems.length > 0) {
        notices.push({
            title: result.mode === "permanent" ? t("Trash.DeleteFailed") : t("Trash.Failed"),
            lines: capLines(problems, t),
            color: "red",
        });
    }

    return notices;
}
