import { describe, expect, it } from "vitest";
import { isCbhPath, isTwoCbhImportAvailable, isTwoCbhPath } from "./cbh";

describe("ChessBase import paths", () => {
    it("recognises both header extensions, case-insensitively", () => {
        expect(isCbhPath("/bases/Mega2024.cbh")).toBe(true);
        expect(isCbhPath("C:\\Bases\\MEGA.CBH")).toBe(true);
        expect(isCbhPath("/bases/Mega2026.2cbh")).toBe(true);
        expect(isCbhPath("/bases/Mega2026.2CBH")).toBe(true);
        expect(isCbhPath("/bases/Mega2024.cbg")).toBe(false);
        expect(isCbhPath("/bases/Mega2024.cbh.bak")).toBe(false);
        expect(isCbhPath("/bases/games.pgn")).toBe(false);
    });

    it("tells the 2CBH family apart", () => {
        expect(isTwoCbhPath("/bases/Mega2026.2cbh")).toBe(true);
        expect(isTwoCbhPath("/bases/Mega2024.cbh")).toBe(false);
        expect(isTwoCbhPath("/bases/Mega2026.2cbg")).toBe(false);
    });

    it("finds the twocbh_to_pgn command in the committed bindings", () => {
        expect(isTwoCbhImportAvailable()).toBe(true);
    });
});
