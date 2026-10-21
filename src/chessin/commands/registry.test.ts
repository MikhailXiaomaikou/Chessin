import { beforeEach, expect, test } from "vitest";
import {
    clearCommands,
    getCommand,
    getCommands,
    registerCommand,
    registerCommands,
    runCommand,
    unregisterCommand,
} from "./registry";

beforeEach(() => {
    clearCommands();
});

test("registerCommand adds, replaces by id and returns an unregister function", () => {
    const off = registerCommand({ id: "a", title: () => "A", section: "file", run: () => {} });
    expect(getCommands().map((c) => c.id)).toEqual(["a"]);

    registerCommand({ id: "a", title: () => "A2", section: "file", run: () => {} });
    expect(getCommands()).toHaveLength(1);
    expect(getCommand("a")?.title()).toBe("A2");

    off();
    expect(getCommands()).toHaveLength(0);
});

test("registerCommands registers a batch and unregisters it as a whole", () => {
    const off = registerCommands([
        { id: "x", title: () => "X", section: "edit", run: () => {} },
        { id: "y", title: () => "Y", section: "edit", run: () => {} },
    ]);
    expect(getCommands().map((c) => c.id)).toEqual(["x", "y"]);
    off();
    expect(getCommands()).toHaveLength(0);
});

test("runCommand respects enabled() and reports whether it ran", async () => {
    let ran = 0;
    registerCommand({
        id: "run",
        title: () => "Run",
        section: "edit",
        run: () => {
            ran += 1;
        },
    });
    registerCommand({
        id: "off",
        title: () => "Off",
        section: "edit",
        enabled: () => false,
        run: () => {
            ran += 100;
        },
    });

    expect(await runCommand("run")).toBe(true);
    expect(await runCommand("off")).toBe(false);
    expect(await runCommand("missing")).toBe(false);
    expect(ran).toBe(1);

    unregisterCommand("run");
    expect(await runCommand("run")).toBe(false);
});
