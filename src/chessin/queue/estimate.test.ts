import { describe, expect, it } from "vitest";
import {
    DEFAULT_SECONDS,
    type DurationStats,
    estimateQueue,
    formatCountdown,
    learnedSeconds,
    MIN_SAMPLES,
    parseDurationStats,
    recordDuration,
    secondsFor,
    serializeDurationStats,
} from "./estimate";
import type { QueueSource } from "./model";

const items = (sources: QueueSource[]) => sources.map((source) => ({ source }));

describe("estimateQueue", () => {
    it("sums the per-source seconds and rounds minutes up", () => {
        const e = estimateQueue(items(["notebook", "notebook", "repertoire", "prep"]), 10);
        expect(e.totalSeconds).toBe(20 + 20 + 12 + 30);
        expect(e.totalMinutes).toBe(2);
        expect(e.minutes).toBe(2);
        expect(e.fits).toBe(4);
    });

    it("caps the session minutes and counts how many items fit, at least one", () => {
        const e = estimateQueue(items(Array(20).fill("prep")), 5); // 600 s
        expect(e.minutes).toBe(5);
        expect(e.totalMinutes).toBe(10);
        expect(e.fits).toBe(10);
        const tiny = estimateQueue(items(["prep"]), 0);
        expect(tiny.fits).toBe(1);
        expect(tiny.minutes).toBe(0);
        expect(estimateQueue([], 10)).toEqual({
            totalSeconds: 0,
            totalMinutes: 0,
            minutes: 0,
            fits: 0,
        });
    });

    it("uses learned seconds when present and the defaults otherwise", () => {
        expect(secondsFor("notebook")).toBe(DEFAULT_SECONDS.notebook);
        expect(secondsFor("notebook", { notebook: 45 })).toBe(45);
        expect(secondsFor("notebook", { notebook: 0 })).toBe(DEFAULT_SECONDS.notebook);
        expect(secondsFor("puzzle", { notebook: 45 })).toBe(DEFAULT_SECONDS.puzzle);
    });
});

describe("learned durations", () => {
    it("recordDuration keeps a running average per source and clamps outliers", () => {
        let stats: DurationStats = {};
        stats = recordDuration(stats, "notebook", 10);
        stats = recordDuration(stats, "notebook", 30);
        expect(stats.notebook).toEqual({ avg: 20, n: 2 });
        stats = recordDuration(stats, "notebook", 100_000); // a pause: clamped to 180 s
        expect(stats.notebook?.avg).toBeCloseTo((20 * 2 + 180) / 3, 5);
        stats = recordDuration(stats, "repertoire", 0.5); // clamped to 3 s
        expect(stats.repertoire).toEqual({ avg: 3, n: 1 });
        expect(recordDuration(stats, "prep", Number.NaN)).toBe(stats);
    });

    it("learnedSeconds only trusts sources with enough samples", () => {
        let stats: DurationStats = {};
        for (let i = 0; i < MIN_SAMPLES - 1; i++) stats = recordDuration(stats, "notebook", 15);
        expect(learnedSeconds(stats)).toEqual({});
        stats = recordDuration(stats, "notebook", 15);
        expect(learnedSeconds(stats)).toEqual({ notebook: 15 });
    });

    it("round-trips through JSON and drops garbage", () => {
        const stats: DurationStats = { notebook: { avg: 18.5, n: 7 }, prep: { avg: 40, n: 2 } };
        expect(parseDurationStats(serializeDurationStats(stats))).toEqual(stats);
        expect(parseDurationStats(null)).toEqual({});
        expect(parseDurationStats("{")).toEqual({});
        expect(
            parseDurationStats(
                JSON.stringify({
                    notebook: { avg: -1, n: 3 },
                    bogus: { avg: 10, n: 3 },
                    prep: "x",
                }),
            ),
        ).toEqual({});
    });
});

describe("formatCountdown", () => {
    it("formats mm:ss and clamps negatives", () => {
        expect(formatCountdown(0)).toBe("00:00");
        expect(formatCountdown(65)).toBe("01:05");
        expect(formatCountdown(600)).toBe("10:00");
        expect(formatCountdown(-30)).toBe("00:00");
    });
});
