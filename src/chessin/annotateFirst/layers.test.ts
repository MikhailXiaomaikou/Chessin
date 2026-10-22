import { describe, expect, it } from "vitest";
import {
    ALL_LAYERS_VISIBLE,
    filterLayers,
    getLayerText,
    hasLayers,
    joinLayers,
    LAYER_PREFIX,
    layerLabelKey,
    layerOfPrefix,
    parseLayers,
    setLayerText,
} from "./layers";

const SAMPLE = [
    "Book move until here.",
    "【我的思考】I would play ...d5 to fight for the centre.",
    "【教练】Too early: White gets e4-e5 with tempo.",
    "【引擎】+0.6 after 12. e5",
].join("\n\n");

describe("parseLayers", () => {
    it("splits a comment into its plain text and the tagged segments, in order", () => {
        expect(parseLayers(SAMPLE)).toEqual([
            { layer: "plain", text: "Book move until here." },
            { layer: "mine", text: "I would play ...d5 to fight for the centre." },
            { layer: "coach", text: "Too early: White gets e4-e5 with tempo." },
            { layer: "engine", text: "+0.6 after 12. e5" },
        ]);
    });

    it("tolerates missing blank lines, inline prefixes and drops empty segments", () => {
        expect(parseLayers("【我的思考】a\n【引擎】b")).toEqual([
            { layer: "mine", text: "a" },
            { layer: "engine", text: "b" },
        ]);
        expect(parseLayers("plain 【教练】coach 【我的思考】")).toEqual([
            { layer: "plain", text: "plain" },
            { layer: "coach", text: "coach" },
        ]);
        expect(parseLayers("")).toEqual([]);
        expect(parseLayers("   \n ")).toEqual([]);
    });

    it("round-trips through joinLayers", () => {
        const segments = parseLayers(SAMPLE);
        expect(joinLayers(segments)).toBe(SAMPLE);
        expect(parseLayers(joinLayers(segments))).toEqual(segments);
    });
});

describe("filterLayers / getLayerText", () => {
    it("keeps only the visible layers, in document order", () => {
        expect(filterLayers(SAMPLE, { ...ALL_LAYERS_VISIBLE, engine: false })).toBe(
            [
                "Book move until here.",
                "【我的思考】I would play ...d5 to fight for the centre.",
                "【教练】Too early: White gets e4-e5 with tempo.",
            ].join("\n\n"),
        );
        expect(filterLayers(SAMPLE, { plain: false, mine: false, coach: false })).toBe(
            "【引擎】+0.6 after 12. e5",
        );
        expect(filterLayers(SAMPLE, {})).toBe(SAMPLE);
    });

    it("reads one layer's text, joining repeated segments", () => {
        expect(getLayerText(SAMPLE, "coach")).toBe("Too early: White gets e4-e5 with tempo.");
        expect(getLayerText(SAMPLE, "plain")).toBe("Book move until here.");
        expect(getLayerText("【我的思考】a\n\n【引擎】x\n\n【我的思考】b", "mine")).toBe("a\n\nb");
        expect(getLayerText("no layers", "mine")).toBe("");
    });
});

describe("setLayerText", () => {
    it("appends a new layer after the existing comment", () => {
        expect(setLayerText("Book move.", "mine", "I like ...d5")).toBe(
            "Book move.\n\n【我的思考】I like ...d5",
        );
        expect(setLayerText("", "mine", "  first thought ")).toBe("【我的思考】first thought");
    });

    it("replaces the existing layer in place and merges duplicates", () => {
        expect(setLayerText(SAMPLE, "mine", "Changed my mind: ...c5.")).toBe(
            [
                "Book move until here.",
                "【我的思考】Changed my mind: ...c5.",
                "【教练】Too early: White gets e4-e5 with tempo.",
                "【引擎】+0.6 after 12. e5",
            ].join("\n\n"),
        );
        expect(setLayerText("【我的思考】a\n\n【引擎】x\n\n【我的思考】b", "mine", "c")).toBe(
            "【我的思考】c\n\n【引擎】x",
        );
    });

    it("removes the layer when the text is empty and puts plain text first", () => {
        expect(setLayerText(SAMPLE, "coach", "")).toBe(
            [
                "Book move until here.",
                "【我的思考】I would play ...d5 to fight for the centre.",
                "【引擎】+0.6 after 12. e5",
            ].join("\n\n"),
        );
        expect(setLayerText("【引擎】x", "plain", "Intro")).toBe("Intro\n\n【引擎】x");
        expect(setLayerText("", "mine", "")).toBe("");
        expect(setLayerText("【我的思考】only", "mine", "   ")).toBe("");
    });
});

describe("helpers", () => {
    it("recognises prefixes and layer keys", () => {
        expect(layerOfPrefix(`${LAYER_PREFIX.coach}x`)).toBe("coach");
        expect(layerOfPrefix("x【教练】")).toBeNull();
        expect(hasLayers("plain only")).toBe(false);
        expect(hasLayers("see 【引擎】 note")).toBe(true);
        expect(layerLabelKey("mine")).toBe("AnnotateFirst.Layer.mine");
        expect(layerLabelKey("plain")).toBe("AnnotateFirst.Layer.plain");
    });
});
