import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCommands, getCommand, runCommand } from "@/chessin/commands/registry";
import { __resetJobsForTests, pauseJobsAtom } from "./queue";
import { registerJobCommands, taskCentreOpenAtom } from "./taskCentre";

// i18next is not initialised in vitest; titles come back as their keys.
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));

const store = getDefaultStore();

beforeEach(() => {
    __resetJobsForTests();
    clearCommands();
    store.set(taskCentreOpenAtom, false);
});

afterEach(() => {
    clearCommands();
    __resetJobsForTests();
});

describe("job commands", () => {
    it("jobs.open toggles the task centre popover", async () => {
        const unregister = registerJobCommands(store);
        expect(getCommand("jobs.open")?.section).toBe("status");
        expect(await runCommand("jobs.open")).toBe(true);
        expect(store.get(taskCentreOpenAtom)).toBe(true);
        await runCommand("jobs.open");
        expect(store.get(taskCentreOpenAtom)).toBe(false);
        unregister();
        expect(getCommand("jobs.open")).toBeUndefined();
    });

    it("jobs.pause toggles pauseJobsAtom and its title follows the state", async () => {
        registerJobCommands(store);
        const cmd = getCommand("jobs.pause");
        expect(cmd?.title()).toBe("Jobs.Pause");
        expect(await runCommand("jobs.pause")).toBe(true);
        expect(store.get(pauseJobsAtom)).toBe(true);
        expect(cmd?.title()).toBe("Jobs.Resume");
        await runCommand("jobs.pause");
        expect(store.get(pauseJobsAtom)).toBe(false);
    });
});
