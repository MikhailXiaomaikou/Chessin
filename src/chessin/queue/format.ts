import { localDayDiff, startOfLocalDay } from "./build";
import type { QueueBuild } from "./build";
import { QUEUE_SOURCES, type QueueItem, type QueueSource } from "./model";

/**
 * Text helpers of the queue (pure; `t` is injected so they are testable).
 *
 * Today line: "18 分钟 · 34 项（开局体系 12、赛事失误 9、备战对王某 8（周六比赛）、开局偏离 0、兵形范例 0）"
 * Summary:    "完成 23 项 · 12 分钟 · 明天还有 11 项"
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export type UiLang = "zh" | "en";

// Static keys so `i18next-cli extract` keeps them:
// t("Queue.Source.notebook") t("Queue.Source.repertoire") t("Queue.Source.prep")
// t("Queue.Source.deviation") t("Queue.Source.puzzle")
export function sourceLabel(
    source: QueueSource,
    t: Translate,
    context: { opponent?: string } = {},
): string {
    if (source === "prep" && context.opponent) {
        return t("Queue.Source.prepFor", { opponent: context.opponent });
    }
    return t(`Queue.Source.${source}`);
}

function locale(lang: UiLang): string {
    return lang === "zh" ? "zh-CN" : "en-US";
}

/** "（周六比赛）" / " (plays Sat)"; empty for a deadline that already passed. */
export function deadlineSuffix(
    deadline: number | undefined,
    now: number,
    t: Translate,
    lang: UiLang,
): string {
    if (deadline === undefined || !Number.isFinite(deadline)) return "";
    if (deadline < startOfLocalDay(now)) return "";
    const days = localDayDiff(now, deadline);
    if (days <= 0) return t("Queue.Deadline.Today");
    if (days === 1) return t("Queue.Deadline.Tomorrow");
    const date = new Date(deadline);
    if (days < 7) {
        let day: string;
        try {
            day = date.toLocaleDateString(locale(lang), { weekday: "short" });
        } catch {
            day = date.toDateString().slice(0, 3);
        }
        return t("Queue.Deadline.Weekday", { day });
    }
    let text: string;
    try {
        text = date.toLocaleDateString(locale(lang), { month: "numeric", day: "numeric" });
    } catch {
        text = `${date.getMonth() + 1}/${date.getDate()}`;
    }
    return t("Queue.Deadline.Date", { date: text });
}

export type PrepContext = { opponent?: string; deadline?: number };

/**
 * The prep pack to name in the breakdown: the one with the nearest upcoming
 * deadline, else the first prep item with an opponent. `null` without prep items.
 */
export function prepContext(items: readonly QueueItem[], now: number): PrepContext | null {
    const dayStart = startOfLocalDay(now);
    let best: QueueItem | null = null;
    let fallback: QueueItem | null = null;
    for (const item of items) {
        if (item.source !== "prep") continue;
        fallback ??= item;
        if (item.deadline === undefined || item.deadline < dayStart) continue;
        if (!best || best.deadline === undefined || item.deadline < best.deadline) best = item;
    }
    const pick = best ?? fallback;
    if (!pick) return null;
    return { opponent: pick.payload.opponent, deadline: pick.deadline };
}

/** "开局体系 12、赛事失误 9、备战对王某 8（周六比赛）、开局偏离 0、兵形范例 0" */
export function describeSources(
    build: Pick<QueueBuild, "items" | "bySource">,
    t: Translate,
    lang: UiLang,
    now: number,
): string {
    const prep = prepContext(build.items, now);
    const parts = QUEUE_SOURCES.map((source) => {
        const count = build.bySource[source] ?? 0;
        const label = sourceLabel(source, t, source === "prep" ? { opponent: prep?.opponent } : {});
        let text = t("Queue.SourceCount", { label, count });
        if (source === "prep" && count > 0 && prep) {
            text += deadlineSuffix(prep.deadline, now, t, lang);
        }
        return text;
    });
    return parts.join(t("Queue.ListSeparator"));
}

/** The Today card line: "18 分钟 · 34 项（…）". */
export function queueLine(build: QueueBuild, t: Translate, lang: UiLang, now: number): string {
    return t("Today.Queue", {
        minutes: build.minutes,
        count: build.items.length,
        sources: describeSources(build, t, lang, now),
    });
}

/** "完成 23 项 · 12 分钟 · 明天还有 11 项" */
export function summaryLine(
    done: number,
    minutes: number,
    remaining: number,
    t: Translate,
): string {
    return t("Queue.Session.Summary", { done, minutes, remaining });
}
