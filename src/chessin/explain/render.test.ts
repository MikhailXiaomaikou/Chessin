import { describe, expect, it } from "vitest";
import enUS from "../../translation/en-US.json";
import zhCN from "../../translation/zh-CN.json";
import {
    EXPLAIN_TEMPLATE_KEYS,
    formatTargets,
    langOf,
    pieceLetter,
    pieceName,
    renderExplanation,
    templateKeys,
    templateVars,
} from "./render";
import type { Explanation, Translate } from "./types";

const en: Record<string, string> = enUS.translation;
const zh: Record<string, string> = zhCN.translation;

const interpolate = (template: string, vars: Record<string, unknown>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? `{{${name}}}`));

const translator =
    (table: Record<string, string>): Translate =>
    (key, options) =>
        key in table ? interpolate(table[key], options ?? {}) : key;

const tEn = translator(en);
const tZh = translator(zh);

const hanging: Explanation = {
    id: "hanging_piece",
    evidence: "likely",
    severity: 2,
    params: { played: "Ne5", best: "e4", piece: "knight", square: "e5", value: 3 },
};

describe("renderExplanation", () => {
    it("renders the Chinese sentence with localised piece names", () => {
        expect(renderExplanation(hanging, tZh, "zh")).toBe(
            "你走的 Ne5 把马放到了 e5 上，那里没有保护，对方可以直接吃掉",
        );
    });

    it("renders the English sentence", () => {
        expect(renderExplanation(hanging, tEn, "en")).toBe(
            "Ne5 puts the knight on e5 where nothing protects it: it can simply be taken.",
        );
    });

    it("prefers the variant key and falls back to the base key", () => {
        const left: Explanation = { ...hanging, params: { ...hanging.params, variant: "left" } };
        expect(templateKeys(left)).toEqual(["Explain.hanging_piece.left", "Explain.hanging_piece"]);
        expect(renderExplanation(left, tZh, "zh")).toBe(
            "你走的 Ne5 把马留在 e5 上没有保护，对方可以直接吃掉",
        );
        const unknown: Explanation = { ...hanging, params: { ...hanging.params, variant: "nope" } };
        expect(renderExplanation(unknown, tEn, "en")).toBe(renderExplanation(hanging, tEn, "en"));
    });

    it("returns the key when no translation exists", () => {
        const missing: Explanation = {
            id: "made_up",
            evidence: "heuristic",
            severity: 1,
            params: {},
        };
        expect(renderExplanation(missing, tEn, "en")).toBe("Explain.made_up");
    });

    it("formats fork targets as a localised list", () => {
        expect(formatTargets("king@g1;queen@d2", "zh")).toBe("g1 的王和 d2 的后");
        expect(formatTargets("king@g1;queen@d2", "en")).toBe("the king on g1 and the queen on d2");
        expect(formatTargets("rook@a8;knight@c6;bishop@e7", "en")).toBe(
            "the rook on a8, the knight on c6 and the bishop on e7",
        );
        expect(formatTargets("rook@a8", "en")).toBe("the rook on a8");
        const fork: Explanation = {
            id: "fork",
            evidence: "likely",
            severity: 3,
            params: {
                variant: "allowed",
                played: "h3",
                best: "Qe2",
                reply: "Nf3+",
                piece: "knight",
                targets: "king@g1;queen@d2",
            },
        };
        expect(renderExplanation(fork, tZh, "zh")).toBe(
            "你走的 h3 给了对方 Nf3+ 捉双的机会：马同时攻击 g1 的王和 d2 的后",
        );
    });

    it("exposes short piece forms and keeps the raw role", () => {
        const vars = templateVars(hanging, "zh");
        expect(vars).toMatchObject({
            piece: "马",
            pieceRole: "knight",
            pieceLetter: "马",
            pieceOn: "马e5",
        });
        expect(templateVars(hanging, "en")).toMatchObject({
            piece: "knight",
            pieceLetter: "N",
            pieceOn: "Ne5",
        });
        expect(pieceName("queen", "zh")).toBe("后");
        expect(pieceLetter("queen", "en")).toBe("Q");
        expect(langOf("zh-CN")).toBe("zh");
        expect(langOf("zh-TW")).toBe("zh");
        expect(langOf("en-US")).toBe("en");
        expect(langOf(undefined)).toBe("en");
    });
});

describe("translation files", () => {
    it("contain every template key in both languages", () => {
        const missing = EXPLAIN_TEMPLATE_KEYS.filter(
            (key) => typeof en[key] !== "string" || typeof zh[key] !== "string",
        );
        expect(missing).toEqual([]);
    });

    it("use only parameters the detectors provide, with the same set in both languages", () => {
        const known = new Set([
            "played",
            "best",
            "reply",
            "piece",
            "pieceOn",
            "square",
            "targets",
            "pinned",
            "pinner",
            "target",
            "n",
            "diff",
            "seconds",
            "used",
            "value",
            "phase",
            "loss",
            "blunders",
            "mistakes",
        ]);
        const placeholders = (s: string) =>
            [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
        const mismatched: string[] = [];
        const unknown: string[] = [];
        for (const key of EXPLAIN_TEMPLATE_KEYS) {
            const a = placeholders(en[key]);
            const b = placeholders(zh[key]);
            if (a.join() !== b.join()) mismatched.push(key);
            for (const p of a) if (!known.has(p)) unknown.push(`${key}:{{${p}}}`);
        }
        expect(mismatched).toEqual([]);
        expect(unknown).toEqual([]);
    });
});
