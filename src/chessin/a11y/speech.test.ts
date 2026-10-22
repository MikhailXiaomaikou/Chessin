import { describe, expect, it } from "vitest";
import enUS from "../../translation/en-US.json";
import zhCN from "../../translation/zh-CN.json";
import type { Translate } from "../explain/types";
import {
    describePosition,
    materialSpeech,
    parseSanParts,
    pieceLabel,
    sanToSpeech,
    squareLabel,
} from "./speech";

const en: Record<string, string> = enUS.translation;
const zh: Record<string, string> = zhCN.translation;

const interpolate = (template: string, vars: Record<string, unknown>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? `{{${name}}}`));

// Same stand-in translator as explain/render.test.ts: unknown keys come back verbatim,
// so a missing `A11y.*` key fails the assertion instead of being papered over.
const translator =
    (table: Record<string, string>): Translate =>
    (key, options) =>
        key in table ? interpolate(table[key], options ?? {}) : key;

const tEn = translator(en);
const tZh = translator(zh);

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("parseSanParts", () => {
    it("splits a capture with check into its parts", () => {
        expect(parseSanParts("Nxe5+")).toEqual({
            role: "knight",
            from: "",
            capture: true,
            to: "e5",
            promotion: undefined,
            check: true,
            mate: false,
        });
    });

    it("keeps disambiguation, promotion and castling", () => {
        expect(parseSanParts("R1e2")).toMatchObject({ role: "rook", from: "1", to: "e2" });
        expect(parseSanParts("exd8=N")).toMatchObject({
            role: "pawn",
            from: "e",
            capture: true,
            to: "d8",
            promotion: "knight",
        });
        expect(parseSanParts("O-O-O#")).toMatchObject({ castle: "long", mate: true });
        expect(parseSanParts("0-0")).toMatchObject({ castle: "short" });
    });

    it("ignores NAG glyphs and rejects non-moves", () => {
        expect(parseSanParts("Bxf7!!")).toMatchObject({ role: "bishop", capture: true, to: "f7" });
        expect(parseSanParts("--")).toBeNull();
        expect(parseSanParts("Z0")).toBeNull();
    });
});

describe("sanToSpeech", () => {
    it("says a knight capture with check in Chinese and English", () => {
        expect(sanToSpeech("Nxe5+", "zh", tZh)).toBe("马吃 e5，将军");
        expect(sanToSpeech("Nxe5+", "en", tEn)).toBe("Knight takes e5, check");
    });

    it("says pawn pushes and pawn captures", () => {
        expect(sanToSpeech("e4", "zh", tZh)).toBe("兵到 e4");
        expect(sanToSpeech("e4", "en", tEn)).toBe("e4");
        expect(sanToSpeech("exd5", "zh", tZh)).toBe("e 兵吃 d5");
        expect(sanToSpeech("exd5", "en", tEn)).toBe("e takes d5");
    });

    it("says castling, with mate", () => {
        expect(sanToSpeech("O-O", "en", tEn)).toBe("Castles kingside");
        expect(sanToSpeech("O-O", "zh", tZh)).toBe("短易位");
        expect(sanToSpeech("O-O-O#", "zh", tZh)).toBe("长易位，将杀");
        expect(sanToSpeech("O-O-O#", "en", tEn)).toBe("Castles queenside, checkmate");
    });

    it("says promotions", () => {
        expect(sanToSpeech("e8=Q+", "en", tEn)).toBe("e8, promotes to queen, check");
        expect(sanToSpeech("exd8=N", "zh", tZh)).toBe("e 兵吃 d8，升变为马");
    });

    it("says disambiguated piece moves", () => {
        expect(sanToSpeech("Nbd7", "en", tEn)).toBe("Knight b to d7");
        expect(sanToSpeech("Nbxd7", "en", tEn)).toBe("Knight b takes d7");
        expect(sanToSpeech("R1e2", "zh", tZh)).toBe("车 1 到 e2");
    });

    it("says a quiet piece move and checkmate", () => {
        expect(sanToSpeech("Nf3", "zh", tZh)).toBe("马到 f3");
        expect(sanToSpeech("Nf3", "en", tEn)).toBe("Knight f3");
        expect(sanToSpeech("Qh7#", "en", tEn)).toBe("Queen h7, checkmate");
        expect(sanToSpeech("Qh7#", "zh", tZh)).toBe("后到 h7，将杀");
    });

    it("drops glyphs and returns non-moves verbatim", () => {
        expect(sanToSpeech("Bxf7!!", "zh", tZh)).toBe("象吃 f7");
        expect(sanToSpeech("Bxf7?!", "en", tEn)).toBe("Bishop takes f7");
        expect(sanToSpeech("--", "en", tEn)).toBe("--");
    });

    it("falls back to the English order for other UI languages", () => {
        const tFr: Translate = (key) => (key === "A11y.Speech.Takes" ? "prend" : key);
        expect(sanToSpeech("Nxe5", "en", tFr)).toBe("Knight prend e5");
    });
});

describe("squareLabel / pieceLabel", () => {
    it("labels occupied and empty squares in both languages", () => {
        const knight = { role: "knight", color: "white" } as const;
        expect(squareLabel("e4", knight, "zh", tZh)).toBe("e4，白马");
        expect(squareLabel("e4", knight, "en", tEn)).toBe("e4, white knight");
        expect(squareLabel("e4", undefined, "zh", tZh)).toBe("e4，空");
        expect(squareLabel("e4", undefined, "en", tEn)).toBe("e4, empty");
        expect(pieceLabel("pawn", "black", "zh", tZh)).toBe("黑兵");
        expect(pieceLabel("pawn", "black", "en", tEn)).toBe("black pawn");
    });
});

describe("describePosition", () => {
    it("lists the material of both sides from the start position", () => {
        expect(materialSpeech(START, "white", "zh")).toBe("王、后、2 个车、2 个象、2 个马、8 个兵");
        expect(materialSpeech(START, "black", "en")).toBe(
            "king, queen, 2 rooks, 2 bishops, 2 knights, 8 pawns",
        );
        const zhText = describePosition(START, "zh", tZh)!;
        expect(zhText).toContain("白方：王、后、2 个车、2 个象、2 个马、8 个兵");
        expect(zhText).toContain("子力相等");
        expect(zhText.endsWith("白方走棋。")).toBe(true);
        const enText = describePosition(START, "en", tEn)!;
        expect(enText).toContain("White: king, queen, 2 rooks, 2 bishops, 2 knights, 8 pawns");
        expect(enText).toContain("Material is equal");
        expect(enText.endsWith("White to move.")).toBe(true);
    });

    it("reports the material balance and check", () => {
        const fen = "4k3/4Q3/8/8/8/8/8/4K3 b - - 0 1";
        expect(describePosition(fen, "zh", tZh)).toContain("白方子力多 9");
        expect(describePosition(fen, "zh", tZh)).toContain("黑方走棋，被将军");
        expect(describePosition(fen, "en", tEn)).toContain("White is up 9");
        expect(describePosition(fen, "en", tEn)).toContain("Black to move, in check");
        expect(describePosition("not a fen", "en", tEn)).toBeNull();
    });
});
