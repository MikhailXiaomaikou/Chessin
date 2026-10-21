import { describe, expect, it } from "vitest";
import { flipOrientation, resolveOrientation } from "./orientationAtom";

describe("board orientation view state", () => {
    it("defaults to the Orientation header (white when absent)", () => {
        expect(resolveOrientation(null)).toBe("white");
        expect(resolveOrientation(null, null)).toBe("white");
        expect(resolveOrientation(null, "black")).toBe("black");
    });

    it("flips relative to the header without touching it", () => {
        const flipped = flipOrientation(null, "white");
        expect(flipped).toEqual({ base: "white", value: "black" });
        expect(resolveOrientation(flipped, "white")).toBe("black");
        expect(resolveOrientation(flipOrientation(flipped, "white"), "white")).toBe("white");
    });

    it("follows the header again once the header changes", () => {
        const flipped = flipOrientation(null, "white");
        expect(resolveOrientation(flipped, "black")).toBe("black");
        expect(resolveOrientation(flipped, undefined)).toBe("black");
    });
});
