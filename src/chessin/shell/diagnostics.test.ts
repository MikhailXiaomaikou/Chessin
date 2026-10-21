import { expect, test } from "vitest";
import type { Engine } from "@/utils/engines";
import { collectDiagnostics, describeError, describeOs } from "./diagnostics";
import { countEnabledEngines } from "./StatusBar";

const local = (overrides: Partial<Engine> = {}): Engine =>
    ({
        type: "local",
        id: "x",
        name: "Stockfish",
        version: "17",
        path: "/bin/stockfish",
        loaded: true,
        ...overrides,
    }) as Engine;

test("countEnabledEngines counts loaded local engines only", () => {
    expect(countEnabledEngines(undefined)).toBe(0);
    expect(countEnabledEngines([])).toBe(0);
    expect(
        countEnabledEngines([
            local(),
            local({ loaded: false }),
            local({ loaded: null }),
            local({ enabled: false }),
            { type: "chessdb", id: "c", name: "ChessDB", url: "https://x", loaded: true } as Engine,
        ]),
    ).toBe(1);
});

test("describeError normalises Error and non-Error values", () => {
    const err = new TypeError("boom", { cause: { code: 7 } });
    const described = describeError(err);
    expect(described.name).toBe("TypeError");
    expect(described.message).toBe("boom");
    expect(described.stack).toContain("boom");
    expect(described.cause).toBe('{"code":7}');

    expect(describeError("plain string")).toMatchObject({ name: "Error", message: "plain string" });
    expect(describeError({ a: 1 })).toMatchObject({ message: '{"a":1}' });
});

test("describeOs does not throw outside Tauri", () => {
    expect(describeOs()).toBe("unknown");
});

test("collectDiagnostics includes version, OS and the error", () => {
    const text = collectDiagnostics(new Error("kaput"), "1.2.3");
    expect(text).toContain("Chessin 1.2.3");
    expect(text).toContain("OS: ");
    expect(text).toContain("Error: kaput");
    expect(collectDiagnostics("x", "")).toContain("Chessin unknown");
});
