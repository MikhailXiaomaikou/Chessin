import { INITIAL_FEN } from "chessops/fen";
import { describe, expect, test } from "vitest";
import type { Token } from "@/bindings";
import {
    ANNOTATION_INFO,
    type Annotation,
    annotationToNag,
    isNagAnnotation,
    NAG_INFO,
    nagToAnnotation,
} from "../annotation";
import {
    escapePgnComment,
    getMoveText,
    getPGN,
    hasMorePriority,
    headersToPGN,
    parsePgnTokens,
    PRE_MOVE_COMMENT_SEPARATOR,
    splitPreMoveComment,
} from "../chess";
import { createNode, type TreeNode } from "../treeReducer";

/**
 * Minimal PGN lexer that mirrors the token stream produced by the Rust
 * `lex_pgn` command (pgn-reader): headers are raw (escapes untouched),
 * comments are everything up to the first `}`, `!`/`?` suffixes become NAG
 * tokens and move numbers are dropped. It lets the parser be exercised in
 * vitest without Tauri.
 */
function lex(pgn: string): Token[] {
    const tokens: Token[] = [];
    const n = pgn.length;
    let i = 0;
    const delimiters = new Set([
        " ",
        "\t",
        "\n",
        "\r",
        "{",
        "}",
        "(",
        ")",
        "!",
        "?",
        "$",
        ";",
        ".",
    ]);
    const tokenEnd = (start: number) => {
        let end = start;
        while (end < n && !delimiters.has(pgn[end])) end++;
        return end;
    };
    const lineEnd = (start: number) => {
        const end = pgn.indexOf("\n", start);
        return end === -1 ? n : end;
    };

    while (i < n) {
        const ch = pgn[i];
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
            i++;
        } else if (ch === "%") {
            i = lineEnd(i) + 1;
        } else if (ch === "[") {
            const leftQuote = pgn.indexOf('"', i);
            const tag = pgn.slice(i + 1, leftQuote).trim();
            let j = leftQuote + 1;
            while (j < n && pgn[j] !== '"' && pgn[j] !== "\n") {
                if (pgn[j] === "\\") j++;
                j++;
            }
            tokens.push({ type: "Header", value: { tag, value: pgn.slice(leftQuote + 1, j) } });
            i = pgn.indexOf("]", j) + 1;
        } else {
            break;
        }
    }

    const suffixNags: Record<string, string> = {
        "!": "$1",
        "?": "$2",
        "!!": "$3",
        "??": "$4",
        "!?": "$5",
        "?!": "$6",
    };

    while (i < n) {
        const ch = pgn[i];
        if (ch === "{") {
            const close = pgn.indexOf("}", i + 1);
            const end = close === -1 ? n : close;
            tokens.push({ type: "Comment", value: pgn.slice(i + 1, end) });
            i = end + 1;
        } else if (ch === ";") {
            i = lineEnd(i);
        } else if (ch === "\n") {
            i++;
            if (pgn[i] === "%") i = lineEnd(i) + 1;
        } else if (ch === "(") {
            tokens.push({ type: "ParenOpen" });
            i++;
        } else if (ch === ")") {
            tokens.push({ type: "ParenClose" });
            i++;
        } else if (ch === "$") {
            const end = tokenEnd(i + 1);
            tokens.push({ type: "Nag", value: `$${Number.parseInt(pgn.slice(i + 1, end), 10)}` });
            i = end;
        } else if (ch === "!" || ch === "?") {
            const two = pgn.slice(i, i + 2);
            const glyph = suffixNags[two] ? two : ch;
            tokens.push({ type: "Nag", value: suffixNags[glyph] });
            i += glyph.length;
        } else if (ch === "*") {
            tokens.push({ type: "Outcome", value: "*" });
            i++;
        } else if (pgn.startsWith("1-0", i)) {
            tokens.push({ type: "Outcome", value: "1-0" });
            i += 3;
        } else if (pgn.startsWith("0-1", i)) {
            tokens.push({ type: "Outcome", value: "0-1" });
            i += 3;
        } else if (pgn.startsWith("1/2-1/2", i)) {
            tokens.push({ type: "Outcome", value: "1/2-1/2" });
            i += 7;
        } else if (ch === " " || ch === "\t" || ch === "\r" || ch === ".") {
            i++;
        } else {
            const end = tokenEnd(i + 1);
            if (ch > "9" || ch === "-") {
                tokens.push({ type: "San", value: pgn.slice(i, end) });
            }
            i = end;
        }
    }
    return tokens;
}

const ALL = { headers: null, glyphs: true, comments: true, variations: true, extraMarkups: true };

/** Movetext produced by exporting the tree parsed from `pgn`. */
function roundTrip(pgn: string, fen?: string): string {
    return getPGN(parsePgnTokens(lex(pgn), fen).root, ALL);
}

function mainLine(root: TreeNode): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (let node = root; node.children.length > 0; node = node.children[0]) {
        nodes.push(node.children[0]);
    }
    return nodes;
}

function moveNode(san: string, annotations: Annotation[]): TreeNode {
    return {
        ...createNode({ fen: INITIAL_FEN, move: { from: 12, to: 28 }, san, halfMoves: 1 }),
        annotations,
    };
}

test("NAGs are consistent", () => {
    for (const k of Object.keys(ANNOTATION_INFO)) {
        if (k === "") continue;
        const nag = ANNOTATION_INFO[k as Annotation].nag!;
        expect(NAG_INFO.get(`$${nag}`)).toBe(k);
    }
});

test("priority comparison", () => {
    expect(hasMorePriority([0, 0], [0])).toBe(false);
    expect(hasMorePriority([0], [0, 0])).toBe(true);
    expect(hasMorePriority([0], [1])).toBe(true);
    expect(hasMorePriority([1], [0])).toBe(false);
    expect(hasMorePriority([0, 0], [0, 1])).toBe(true);
    expect(hasMorePriority([0, 1], [0, 0])).toBe(false);
    expect(hasMorePriority([0, 1], [0, 2])).toBe(true);
    expect(hasMorePriority([0, 2], [0, 1])).toBe(false);
});

test("PGN headers preserve UTC time", () => {
    const pgn = headersToPGN({
        id: 1,
        fen: "",
        event: "Live Chess",
        site: "https://www.chess.com/game/live/1",
        date: "2026.09.19",
        time: "12:34:56",
        round: "-",
        white: "White",
        black: "Black",
        result: "1-0",
    });

    expect(pgn).toContain('[UTCTime "12:34:56"]');
});

describe("glyphs and NAGs", () => {
    test("one basic glyph as suffix, every other annotation as $n", () => {
        const opt = { glyphs: true, comments: false, extraMarkups: false };
        expect(getMoveText(moveNode("e4", ["?", "??"]), opt).trim()).toBe("1. e4? $4");
        expect(getMoveText(moveNode("e4", ["!"]), opt).trim()).toBe("1. e4!");
        expect(getMoveText(moveNode("e4", ["N", "±", "!"]), opt).trim()).toBe("1. e4! $16 $146");
        expect(getMoveText(moveNode("e4", ["=", "$33"]), opt).trim()).toBe("1. e4 $10 $33");
        expect(getMoveText(moveNode("e4", [""]), opt).trim()).toBe("1. e4");
    });

    test("glyph + NAG combos round-trip", () => {
        expect(roundTrip("1. e4?? $14 e5! $146 2. Nf3!? $16 $7")).toBe(
            "1. e4?? $14 e5! $146 2. Nf3!? $7 $16",
        );
        const root = parsePgnTokens(lex("1. e4 $2 $4 $4")).root;
        expect(root.children[0].annotations).toEqual(["?", "??"]);
    });

    test("unknown NAGs are kept as $n and colour pairs are not merged", () => {
        expect(nagToAnnotation("$32")).toBe("↑↑");
        expect(nagToAnnotation("$33")).toBe("$33");
        expect(nagToAnnotation("$141")).toBe("$141");
        expect(nagToAnnotation(22)).toBe("⨀");
        expect(nagToAnnotation("$23")).toBe("$23");
        expect(annotationToNag("$33")).toBe(33);
        expect(annotationToNag("↑↑")).toBe(32);
        expect(isNagAnnotation("$33")).toBe(true);
        expect(isNagAnnotation("!")).toBe(false);
        // unknown NAGs still have usable annotation info for the UI
        expect(ANNOTATION_INFO["$33"].nag).toBe(33);
        expect(ANNOTATION_INFO["$33"].group).toBeUndefined();
        expect(Object.keys(ANNOTATION_INFO)).not.toContain("$33");

        const root = parsePgnTokens(lex("1. e4 $33 $141 $23 e5 $22")).root;
        expect(root.children[0].annotations).toEqual(["$23", "$33", "$141"]);
        expect(root.children[0].children[0].annotations).toEqual(["⨀"]);
        expect(roundTrip("1. e4 $33 $141 $23 e5 $22")).toBe("1. e4 $23 $33 $141 e5 $22");
    });
});

describe("comments", () => {
    test("closing braces are replaced and newlines kept", () => {
        expect(escapePgnComment("a } b { c")).toBe("a ｝ b { c");
        expect(escapePgnComment("line1\r\nline2")).toBe("line1\nline2");

        const root = parsePgnTokens(lex("1. e4 {first\n\nsecond **bold** [link](x)} e5")).root;
        expect(root.children[0].comment).toBe("first\n\nsecond **bold** [link](x)");
        const exported = getPGN(root, ALL);
        expect(exported).toBe("1. e4 {first\n\nsecond **bold** [link](x)} 1... e5");
        expect(roundTrip(exported)).toBe(exported);

        const node = moveNode("e4", []);
        node.comment = "see {diagram}";
        expect(getMoveText(node, { glyphs: true, comments: true, extraMarkups: true })).toBe(
            "1. e4 {see {diagram｝}",
        );
        expect(roundTrip("1. e4 {see {diagram｝} e5")).toBe("1. e4 {see {diagram｝} 1... e5");
    });

    test("consecutive comments are concatenated instead of overwritten", () => {
        const root = parsePgnTokens(lex("1. e4 {a} {b} {[%clk 0:01:00]} e5")).root;
        expect(root.children[0].comment).toBe("a b");
        expect(root.children[0].clock).toBe(60);
    });

    test("comments before the first move of a variation survive", () => {
        const pgn = "1. e4 ( {Alt} 1. d4 d5 ( {deeper} 1... Nf6 {after} 2. c4 ) ) e5 (1... c5)";
        const root = parsePgnTokens(lex(pgn)).root;
        const d4 = root.children[1];
        expect(d4.san).toBe("d4");
        expect(splitPreMoveComment(d4.comment)).toEqual({ pre: "Alt", text: "" });
        const nf6 = d4.children[1];
        expect(nf6.san).toBe("Nf6");
        expect(nf6.comment).toBe(`deeper${PRE_MOVE_COMMENT_SEPARATOR}after`);
        expect(splitPreMoveComment(nf6.comment)).toEqual({ pre: "deeper", text: "after" });
        expect(splitPreMoveComment("plain")).toEqual({ pre: "", text: "plain" });

        const exported = getPGN(root, ALL);
        expect(exported).toBe(
            "1. e4 ({Alt} 1. d4 d5 ({deeper} 1... Nf6 {after} 2. c4)) 1... e5 (1... c5)",
        );
        expect(roundTrip(exported)).toBe(exported);
    });

    test("markup before a variation's first move goes to the parent position", () => {
        const root = parsePgnTokens(
            lex("1. e4 ( {[%cal Gd2d4] [%eval 0.20,18]} 1. d4 ) e5 ( {[%cal Gd2d4]} 1... c5 )"),
        ).root;
        expect(root.shapes).toEqual([{ orig: "d2", dest: "d4", brush: "green" }]);
        expect(root.score).toEqual({ value: { type: "cp", value: 20 }, wdl: null });
        expect(root.depth).toBe(18);
        expect(root.children[1].shapes).toEqual([]);
        expect(root.children[0].shapes).toEqual([{ orig: "d2", dest: "d4", brush: "green" }]);
    });

    test("a variation with only a comment is not lost", () => {
        const root = parsePgnTokens(lex("1. e4 {x} ( {orphan} ) e5")).root;
        expect(root.comment).toBe("orphan");
        expect(root.children[0].comment).toBe("x");
        expect(getPGN(root, ALL)).toBe("{orphan} 1. e4 {x} 1... e5");
    });

    test("chess.com timestamps are stripped", () => {
        const root = parsePgnTokens(lex("1. e4 {[%timestamp 12] text [%clk 0:02:59.9]} e5")).root;
        expect(root.children[0].comment).toBe("text");
        expect(root.children[0].clock).toBeCloseTo(179.9);
    });
});

describe("extra markups", () => {
    test("clk, emt and eval (with depth and mate) round-trip", () => {
        const pgn =
            "1. e4 {[%eval 0.30,20] [%clk 0:03:00] [%emt 0:00:05] text} e5 {[%eval #-3,12]} 2. Nf3 {[%eval #2] [%emt 0:01:02.5]} Nc6 {[%clk 1:02:03] [%eval -1.5]}";
        const root = parsePgnTokens(lex(pgn)).root;
        const [e4, e5, nf3, nc6] = mainLine(root);
        expect(e4.score).toEqual({ value: { type: "cp", value: 30 }, wdl: null });
        expect(e4.depth).toBe(20);
        expect(e4.clock).toBe(180);
        expect(e4.comment).toBe("[%emt 0:00:05] text");
        expect(e5.score).toEqual({ value: { type: "mate", value: -3 }, wdl: null });
        expect(e5.depth).toBe(12);
        expect(nf3.score).toEqual({ value: { type: "mate", value: 2 }, wdl: null });
        expect(nf3.depth).toBeNull();
        expect(nf3.comment).toBe("[%emt 0:01:02.5]");
        expect(nc6.score).toEqual({ value: { type: "cp", value: -150 }, wdl: null });
        expect(nc6.clock).toBe(3723);

        const exported = getPGN(root, ALL);
        expect(exported).toBe(
            "1. e4 {[%eval +0.30,20] [%clk 0:03:00] [%emt 0:00:05] text} 1... e5 {[%eval #-3,12]} 2. Nf3 {[%eval #2] [%emt 0:01:02.5]} 2... Nc6 {[%eval -1.50] [%clk 1:02:03]}",
        );
        expect(roundTrip(exported)).toBe(exported);
    });

    test("arrows and squares round-trip", () => {
        const pgn = "1. e4 {[%csl Ge4,Rd5][%cal Gg1f3,Bb1c3] plan} e5";
        const root = parsePgnTokens(lex(pgn)).root;
        expect(root.children[0].shapes).toEqual([
            { orig: "e4", dest: undefined, brush: "green" },
            { orig: "d5", dest: undefined, brush: "red" },
            { orig: "g1", dest: "f3", brush: "green" },
            { orig: "b1", dest: "c3", brush: "blue" },
        ]);
        expect(root.children[0].comment).toBe("plan");
        const exported = getPGN(root, ALL);
        expect(exported).toBe("1. e4 {[%csl Ge4,Rd5] [%cal Gg1f3,Bb1c3] plan} 1... e5");
        expect(roundTrip(exported)).toBe(exported);
    });

    test("markups are omitted when disabled", () => {
        const root = parsePgnTokens(lex("1. e4 {[%eval 0.30] [%clk 0:03:00] text} e5")).root;
        expect(getPGN(root, { ...ALL, extraMarkups: false })).toBe("1. e4 {text} 1... e5");
        expect(getPGN(root, { ...ALL, extraMarkups: false, comments: false })).toBe("1. e4 e5");
    });
});

describe("headers", () => {
    test("quotes and backslashes are escaped and decoded", () => {
        const headers = headersToPGN({
            id: 1,
            fen: "",
            event: 'Say "hi"',
            site: "C:\\games",
            date: "",
            round: "",
            white: "",
            black: "",
            result: "*",
            other: { Annotator: 'Me "the" one' },
        });
        expect(headers).toContain('[Event "Say \\"hi\\""]');
        expect(headers).toContain('[Site "C:\\\\games"]');
        expect(headers).toContain('[Annotator "Me \\"the\\" one"]');

        const tree = parsePgnTokens(lex(`${headers}\n1. e4 *`));
        expect(tree.headers.event).toBe('Say "hi"');
        expect(tree.headers.site).toBe("C:\\games");
        expect(tree.headers.other?.Annotator).toBe('Me "the" one');
    });
});

test("full game round-trips and is idempotent", () => {
    const pgn = `[Event "Test"]
[Site "?"]
[Date "2026.10.21"]
[Round "?"]
[White "A"]
[Black "B"]
[Result "1-0"]
[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]

{Pre-game} 1. e4 {[%eval 0.30,20] [%clk 0:03:00] open} e5 $14 ( {Sicilian} 1... c5 $13 2. Nf3 ( 2. c3 $5 {Alapin} ) d6 ) 2. Nf3!? $33 Nc6 {[%csl Gc6][%cal Gf3e5] the knight} 3. Bb5?! {Ruy｝Lopez} a6 1-0`;
    const tree = parsePgnTokens(lex(pgn));
    expect(tree.headers.result).toBe("1-0");
    const exported = getPGN(tree.root, { ...ALL, headers: tree.headers });
    expect(exported).toBe(
        `[Event "Test"]
[Site "?"]
[Date "2026.10.21"]
[Round "?"]
[White "A"]
[Black "B"]
[Result "1-0"]
[Orientation "white"]

{Pre-game} 1. e4 {[%eval +0.30,20] [%clk 0:03:00] open} 1... e5 $14 ({Sicilian} 1... c5 $13 2. Nf3 (2. c3!? {Alapin}) 2... d6) 2. Nf3!? $33 Nc6 {[%csl Gc6] [%cal Gf3e5] the knight} 3. Bb5?! {Ruy｝Lopez} 3... a6 1-0`,
    );
    const again = parsePgnTokens(lex(exported));
    expect(getPGN(again.root, { ...ALL, headers: again.headers })).toBe(exported);
});
