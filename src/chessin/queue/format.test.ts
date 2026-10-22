import { describe, expect, it } from "vitest";
import type { QueueBuild } from "./build";
import { deadlineSuffix, describeSources, prepContext, queueLine, summaryLine } from "./format";
import { emptyBySource, type QueueItem } from "./model";

// Thursday 2026-10-22 10:00 local.
const NOW = new Date(2026, 9, 22, 10, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const ZH: Record<string, string> = {
    "Queue.Source.notebook": "赛事失误",
    "Queue.Source.repertoire": "开局体系",
    "Queue.Source.prep": "备战",
    "Queue.Source.prepFor": "备战对{{opponent}}",
    "Queue.Source.deviation": "开局偏离",
    "Queue.Source.puzzle": "兵形范例",
    "Queue.SourceCount": "{{label}} {{count}}",
    "Queue.ListSeparator": "、",
    "Queue.Deadline.Today": "（今天比赛）",
    "Queue.Deadline.Tomorrow": "（明天比赛）",
    "Queue.Deadline.Weekday": "（{{day}}比赛）",
    "Queue.Deadline.Date": "（{{date}} 比赛）",
    "Today.Queue": "{{minutes}} 分钟 · {{count}} 项（{{sources}}）",
    "Queue.Session.Summary": "完成 {{done}} 项 · {{minutes}} 分钟 · 明天还有 {{remaining}} 项",
};

const t = (key: string, options: Record<string, unknown> = {}) =>
    (ZH[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));

function prepItem(id: string, opponent?: string, deadline?: number): QueueItem {
    return {
        id,
        source: "prep",
        kind: "prep",
        due: NOW,
        priority: 0.8,
        deadline,
        isNew: false,
        extraPass: false,
        score: 0.8,
        payload: {
            cardId: id,
            epd: "x",
            answers: ["e2e4"],
            orientation: "white",
            title: "t",
            opponent,
            card: {} as QueueItem["payload"]["card"],
        },
    };
}

function buildWith(
    bySource: Partial<Record<keyof QueueBuild["bySource"], number>>,
    items: QueueItem[] = [],
): QueueBuild {
    return {
        items,
        minutes: 18,
        totalMinutes: 18,
        bySource: { ...emptyBySource(), ...bySource },
        catchUp: false,
        dropped: 0,
        newCapped: 0,
        fits: items.length,
        overdue: items.length,
        extraPass: 0,
    };
}

describe("deadlineSuffix", () => {
    it("today / tomorrow / weekday within the week / date beyond; nothing for past deadlines", () => {
        expect(deadlineSuffix(NOW + 2 * 60 * 60 * 1000, NOW, t, "zh")).toBe("（今天比赛）");
        expect(deadlineSuffix(NOW + DAY, NOW, t, "zh")).toBe("（明天比赛）");
        const saturday = new Date(2026, 9, 24, 0, 0).getTime();
        expect(deadlineSuffix(saturday, NOW, t, "zh")).toBe("（周六比赛）");
        expect(deadlineSuffix(saturday, NOW, t, "en")).toBe("（Sat比赛）");
        const later = new Date(2026, 10, 5, 0, 0).getTime();
        expect(deadlineSuffix(later, NOW, t, "zh")).toBe("（11/5 比赛）");
        expect(deadlineSuffix(NOW - 2 * DAY, NOW, t, "zh")).toBe("");
        expect(deadlineSuffix(undefined, NOW, t, "zh")).toBe("");
    });
});

describe("describeSources / queueLine", () => {
    it("renders every source in order, naming the nearest prep opponent and its deadline", () => {
        const saturday = new Date(2026, 9, 24, 0, 0).getTime();
        const items = [
            prepItem("p1", "李某", saturday + 7 * DAY),
            prepItem("p2", "王某", saturday),
        ];
        const build = buildWith({ repertoire: 12, notebook: 9, prep: 8 }, items);
        expect(describeSources(build, t, "zh", NOW)).toBe(
            "开局体系 12、赛事失误 9、备战对王某 8（周六比赛）、开局偏离 0、兵形范例 0",
        );
        expect(
            queueLine(
                { ...build, minutes: 18, items: [...items, ...Array(32).fill(items[0])] },
                t,
                "zh",
                NOW,
            ),
        ).toBe(
            "18 分钟 · 34 项（开局体系 12、赛事失误 9、备战对王某 8（周六比赛）、开局偏离 0、兵形范例 0）",
        );
    });

    it("falls back to the plain 备战 label without an opponent and omits a passed deadline", () => {
        const build = buildWith({ prep: 3 }, [prepItem("p1", undefined, NOW - 3 * DAY)]);
        expect(describeSources(build, t, "zh", NOW)).toBe(
            "开局体系 0、赛事失误 0、备战 3、开局偏离 0、兵形范例 0",
        );
    });

    it("prepContext prefers the nearest upcoming deadline, else the first prep item", () => {
        expect(prepContext([], NOW)).toBeNull();
        const past = prepItem("a", "甲", NOW - 5 * DAY);
        const soon = prepItem("b", "乙", NOW + DAY);
        const later = prepItem("c", "丙", NOW + 9 * DAY);
        expect(prepContext([past, later, soon], NOW)).toEqual({
            opponent: "乙",
            deadline: NOW + DAY,
        });
        expect(prepContext([past], NOW)).toEqual({ opponent: "甲", deadline: NOW - 5 * DAY });
    });
});

describe("summaryLine", () => {
    it("formats the session summary", () => {
        expect(summaryLine(23, 12, 11, t)).toBe("完成 23 项 · 12 分钟 · 明天还有 11 项");
    });
});
