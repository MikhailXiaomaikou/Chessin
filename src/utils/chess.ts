import type { DrawShape } from "@lichess-org/chessground/draw";
import { type Color, type Move, makeSquare, makeUci, parseUci, type Role } from "chessops";
import { type Chess, normalizeMove } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { isPawns, parseComment } from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { commands, type Outcome, type Score, type Token } from "@/bindings";
import {
    type Annotation,
    annotationToNag,
    compareAnnotations,
    isBasicAnnotation,
    nagToAnnotation,
} from "./annotation";
import { parseSanOrUci, positionFromFen } from "./chessops";
import { harmonicMean, isPrefix, mean } from "./misc";
import { formatScore, getAccuracy, getCPLoss, INITIAL_SCORE } from "./score";
import {
    createNode,
    defaultTree,
    type GameHeaders,
    type TreeNode,
    type TreeState,
} from "./treeReducer";
import { unwrap } from "./unwrap";

export interface BestMoves {
    depth: number;
    score: Score;
    uciMoves: string[];
    sanMoves: string[];
    multipv: number;
    nps: number;
}

export interface MoveAnalysis {
    best: BestMoves[];
    novelty: boolean;
    is_sacrifice: boolean;
}

// copied from chessops
export const makeClk = (seconds: number): string => {
    let s = Math.max(0, seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    s = (s % 3600) % 60;
    return `${hours}:${minutes.toString().padStart(2, "0")}:${s.toLocaleString("en", {
        minimumIntegerDigits: 2,
        maximumFractionDigits: 3,
    })}`;
};

/**
 * Separates a comment written *before* a move (`( {Alt} 1. d4 )`) from the
 * node's own comment inside `TreeNode.comment`, since the node model has no
 * dedicated slot for it. The stored form is `${pre}${SEPARATOR}${own}`; the
 * separator (U+2063 INVISIBLE SEPARATOR) renders as nothing in the editor and
 * is split again on export so the comment goes back in front of the move.
 */
export const PRE_MOVE_COMMENT_SEPARATOR = "\u2063";

export function splitPreMoveComment(comment: string): { pre: string; text: string } {
    const index = comment.indexOf(PRE_MOVE_COMMENT_SEPARATOR);
    if (index === -1) {
        return { pre: "", text: comment };
    }
    return {
        pre: comment.slice(0, index),
        text: comment.slice(index + PRE_MOVE_COMMENT_SEPARATOR.length),
    };
}

/**
 * Makes free text safe inside a PGN brace comment. A `}` would terminate the
 * comment, so it is replaced with the fullwidth `｝` (U+FF5D): unlike `]`
 * it keeps the meaning of the text, and it is not mapped back on import since
 * Chinese text legitimately contains fullwidth brackets. `{` is allowed inside
 * a comment by the PGN standard and is kept. Newlines are kept as well (every
 * parser treats a comment as running until the next `}`), only `\r\n` is
 * normalised to `\n`.
 */
export function escapePgnComment(text: string): string {
    return text.replace(/\r\n?/g, "\n").replace(/\}/g, "｝");
}

const SHAPE_COLOR_LETTERS: Record<string, string> = {
    green: "G",
    red: "R",
    yellow: "Y",
    blue: "B",
};

function shapeColorLetter(brush: string | undefined): string | null {
    if (!brush) return "G";
    const normalized = brush.replace(/^pale/, "").toLowerCase();
    return SHAPE_COLOR_LETTERS[normalized] ?? null;
}

function makeEvalTag(tree: TreeNode): string | null {
    if (tree.score === null) return null;
    const { value } = tree.score;
    let text: string;
    if (value.type === "cp") {
        text = formatScore(value);
    } else if (value.type === "mate") {
        text = `#${value.value}`;
    } else {
        return null;
    }
    if (tree.depth !== null && tree.depth !== undefined) {
        text += `,${tree.depth}`;
    }
    return `[%eval ${text}]`;
}

/**
 * Annotations as they appear after the SAN: at most one basic glyph (`!`, `?`,
 * …) is written as a suffix, everything else as numeric `$n` NAGs in
 * ascending order, so `["?", "??"]` becomes `e4? $4`.
 */
function makeAnnotationText(annotations: Annotation[]): string {
    const sorted = annotations.filter((annotation) => annotation !== "").sort(compareAnnotations);
    let suffix = "";
    const nags: string[] = [];
    for (const annotation of sorted) {
        if (suffix === "" && isBasicAnnotation(annotation)) {
            suffix = annotation;
        } else {
            nags.push(`$${annotationToNag(annotation)}`);
        }
    }
    return nags.length > 0 ? `${suffix} ${nags.join(" ")}` : suffix;
}

function makeCommentBlock(
    tree: TreeNode,
    text: string,
    opt: { comments: boolean; extraMarkups: boolean },
): string | null {
    const parts: string[] = [];

    if (opt.extraMarkups) {
        const evalTag = makeEvalTag(tree);
        if (evalTag) {
            parts.push(evalTag);
        }
        if (tree.clock !== undefined) {
            parts.push(`[%clk ${makeClk(tree.clock)}]`);
        }
        const squares: string[] = [];
        const arrows: string[] = [];
        for (const shape of tree.shapes) {
            const color = shapeColorLetter(shape.brush);
            if (!color) continue;
            if (shape.dest === undefined || shape.dest === shape.orig) {
                squares.push(color + shape.orig);
            } else {
                arrows.push(color + shape.orig + shape.dest);
            }
        }
        if (squares.length > 0) {
            parts.push(`[%csl ${squares.join(",")}]`);
        }
        if (arrows.length > 0) {
            parts.push(`[%cal ${arrows.join(",")}]`);
        }
    }

    if (opt.comments && text !== "") {
        parts.push(escapePgnComment(text));
    }

    return parts.length > 0 ? `{${parts.join(" ")}}` : null;
}

/**
 * Serialises one node: optional pre-move comment, move number, SAN,
 * annotations and the comment block. Parts are joined by single spaces and the
 * result carries no trailing whitespace.
 */
export function getMoveText(
    tree: TreeNode,
    opt: {
        glyphs: boolean;
        comments: boolean;
        extraMarkups: boolean;
        isFirst?: boolean;
    },
): string {
    const parts: string[] = [];
    const { pre, text } = splitPreMoveComment(tree.comment);

    if (opt.comments && pre !== "") {
        parts.push(`{${escapePgnComment(pre)}}`);
    }

    if (tree.san) {
        const isBlack = tree.halfMoves % 2 === 0;
        const moveNumber = Math.ceil(tree.halfMoves / 2);
        let moveText = "";
        if (isBlack) {
            if (opt.isFirst || (opt.comments && pre !== "")) {
                moveText += `${moveNumber}... `;
            }
        } else {
            moveText += `${moveNumber}. `;
        }
        moveText += tree.san;
        if (opt.glyphs) {
            moveText += makeAnnotationText(tree.annotations);
        }
        parts.push(moveText);
    }

    if (opt.comments || opt.extraMarkups) {
        const block = makeCommentBlock(tree, tree.san ? text : `${pre} ${text}`.trim(), opt);
        if (block) {
            parts.push(block);
        }
    }
    return parts.join(" ");
}

export function getLastMainlinePosition(root: TreeNode): number[] {
    const position = [];
    for (let node = root; node.children.length > 0; node = node.children[0]) {
        if (node.move) {
            position.push(0);
        }
    }
    return position;
}

export function getMainLine(root: TreeNode): string[] {
    return getVariationLine(root, getLastMainlinePosition(root), true);
}

export function uciNormalize(chess: Chess, move: Move) {
    const frcMove = normalizeMove(chess, move);
    return makeUci(frcMove);
}

export function getVariationLine(
    root: TreeNode,
    position: number[],
    includeLastMove = false,
): string[] {
    const moves = [];
    let node = root;
    const [chess] = positionFromFen(root.fen);
    if (!chess) {
        return [];
    }
    for (const pos of position) {
        node = node.children[pos];
        if (node.move) {
            moves.push(uciNormalize(chess, node.move));
            chess.play(node.move);
        }
    }
    if (includeLastMove && node.children.length > 0) {
        moves.push(uciNormalize(chess, node.children[0].move!));
    }
    return moves;
}

/** PGN tag values escape `"` and `\` with a backslash. */
function encodePgnHeaderValue(value: string | number): string {
    return String(value).replace(/[\\"]/g, "\\$&");
}

function decodePgnHeaderValue(value: string): string {
    return value.replace(/\\(["\\])/g, "$1");
}

function pgnTag(name: string, value: string | number): string {
    return `[${name} "${encodePgnHeaderValue(value)}"]\n`;
}

export function headersToPGN(game: GameHeaders): string {
    let headers = pgnTag("Event", game.event || "?");
    headers += pgnTag("Site", game.site || "?");
    headers += pgnTag("Date", game.date || "????.??.??");
    headers += pgnTag("Round", game.round || "?");
    headers += pgnTag("White", game.white || "?");
    headers += pgnTag("Black", game.black || "?");
    headers += pgnTag("Result", game.result);
    if (game.time) {
        headers += pgnTag("UTCTime", game.time);
    }
    if (game.white_elo !== undefined && game.white_elo !== null) {
        headers += pgnTag("WhiteElo", game.white_elo === 0 ? "-" : game.white_elo);
    }
    if (game.black_elo !== undefined && game.black_elo !== null) {
        headers += pgnTag("BlackElo", game.black_elo === 0 ? "-" : game.black_elo);
    }
    if (game.start && game.start.length > 0) {
        headers += pgnTag("Start", JSON.stringify(game.start));
    }
    if (game.orientation) {
        headers += pgnTag("Orientation", game.orientation);
    }
    if (game.time_control) {
        headers += pgnTag("TimeControl", game.time_control);
    }
    if (game.white_time_control) {
        headers += pgnTag("WhiteTimeControl", game.white_time_control);
    }
    if (game.black_time_control) {
        headers += pgnTag("BlackTimeControl", game.black_time_control);
    }
    if (game.eco) {
        headers += pgnTag("ECO", game.eco);
    }
    if (game.variant) {
        headers += pgnTag("Variant", game.variant);
    }
    for (const [key, value] of Object.entries(game.other ?? {})) {
        headers += pgnTag(key, value);
    }
    return headers;
}

export function defaultPGN() {
    return `[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n\n*`;
}

type MovetextOptions = {
    glyphs: boolean;
    comments: boolean;
    variations: boolean;
    extraMarkups: boolean;
};

/**
 * Movetext of the line starting below `node` (the node itself is not
 * written). With `path` only that line is followed and variations are
 * omitted; otherwise the first child is the main line and the other children
 * are written as `(…)` variations right after it. A black move gets its move
 * number when it opens a line or follows a comment or variation.
 */
function getMovetextParts(
    node: TreeNode,
    opt: MovetextOptions,
    isFirst: boolean,
    path: number[] | null,
): string[] {
    const parts: string[] = [];
    let current = node;
    let needsNumber = isFirst;
    let remaining = path;
    while (current.children.length > 0) {
        const index = remaining ? remaining[0] : 0;
        const child = current.children[index];
        if (!child || (remaining && remaining.length === 0)) {
            break;
        }
        const moveText = getMoveText(child, { ...opt, isFirst: needsNumber });
        parts.push(moveText);
        needsNumber = moveText.endsWith("}");

        if (!remaining && opt.variations) {
            for (const variation of current.children.slice(1)) {
                const inner = [
                    getMoveText(variation, { ...opt, isFirst: true }),
                    ...getMovetextParts(variation, opt, false, null),
                ];
                parts.push(`(${inner.join(" ")})`);
                needsNumber = true;
            }
        }

        current = child;
        remaining = remaining ? remaining.slice(1) : null;
    }
    return parts;
}

export function getPGN(
    tree: TreeNode,
    {
        headers,
        glyphs,
        comments,
        variations,
        extraMarkups,
        root = true,
        path = null,
    }: {
        headers: GameHeaders | null;
        glyphs: boolean;
        comments: boolean;
        variations: boolean;
        extraMarkups: boolean;
        root?: boolean;
        path?: number[] | null;
    },
): string {
    if (path && path.length === 0) {
        return "";
    }
    let pgn = "";
    if (headers) {
        pgn += headersToPGN(headers);
    }
    if (root && tree.fen !== INITIAL_FEN) {
        pgn += pgnTag("SetUp", "1");
        pgn += pgnTag("FEN", tree.fen);
    }
    pgn += "\n";

    const opt = { glyphs, comments, variations, extraMarkups };
    const parts: string[] = [];
    if (root) {
        const rootText = getMoveText(tree, opt);
        if (rootText !== "") {
            parts.push(rootText);
        }
    }
    parts.push(...getMovetextParts(tree, opt, root, path));
    if (root && headers) {
        parts.push(headers.result);
    }
    return (pgn + parts.join(" ")).trim();
}

export function parseKeyboardMove(san: string, fen: string) {
    function cleanSan(san: string) {
        // Normalize castling: O, o, or 0 with optional hyphens
        if (/^[oO0]-?[oO0]-?[oO0]$/.test(san)) return "O-O-O";
        if (/^[oO0]-?[oO0]$/.test(san)) return "O-O";
        // Uppercase piece letters for non-castling moves
        return san.replace(/^([kqbnr])/i, (_, match) => match.toUpperCase());
    }

    const [pos] = positionFromFen(fen);
    if (!pos) {
        return null;
    }
    const move = parseSanOrUci(pos, san);
    if (move) {
        return move;
    }
    const newSan = cleanSan(san);
    const newMove = parseSanOrUci(pos, newSan);
    if (newMove) {
        return newMove;
    }
    return null;
}

export async function getOpening(root: TreeNode, position: number[]): Promise<string> {
    const fens: string[] = [root.fen];
    let currentNode = root;

    for (const index of position) {
        if (!currentNode.children || index >= currentNode.children.length) {
            break;
        }
        currentNode = currentNode.children[index];
        fens.push(currentNode.fen);
    }

    const res = await commands.getOpeningFromFens(fens);
    if (res.status !== "error") {
        return res.data;
    }

    return "";
}

function appendComment(node: TreeNode, text: string) {
    if (text === "") return;
    node.comment = node.comment === "" ? text : `${node.comment} ${text}`;
}

function addShapes(node: TreeNode, shapes: DrawShape[]) {
    for (const shape of shapes) {
        const exists = node.shapes.some(
            (s) => s.orig === shape.orig && s.dest === shape.dest && s.brush === shape.brush,
        );
        if (!exists) {
            node.shapes.push(shape);
        }
    }
}

/** Applies a `{…}` comment token (text and `[%…]` markups) to `node`. */
function applyComment(node: TreeNode, raw: string) {
    const comment = parseComment(raw);

    if (comment.evaluation) {
        const { evaluation } = comment;
        node.score = {
            value: isPawns(evaluation)
                ? { type: "cp", value: Math.round(evaluation.pawns * 100) }
                : { type: "mate", value: evaluation.mate },
            wdl: null,
        };
        node.depth = evaluation.depth ?? null;
    }

    if (comment.shapes.length > 0) {
        addShapes(
            node,
            comment.shapes.map((shape) => ({
                orig: makeSquare(shape.from),
                dest: shape.to === shape.from ? undefined : makeSquare(shape.to),
                brush: shape.color,
            })),
        );
    }

    if (comment.clock !== undefined) {
        node.clock = comment.clock;
    }

    // Strip [%timestamp N] annotations (chess.com export format) from comment text
    let text = comment.text.replace(/\s?\[%timestamp\s+\d+\]\s?/g, " ").trim();
    // The node model has no slot for elapsed move time, so `[%emt]` is kept in
    // the comment text (canonical form, in front) and written back verbatim.
    if (comment.emt !== undefined) {
        text = `[%emt ${makeClk(comment.emt)}]${text === "" ? "" : ` ${text}`}`;
    }
    appendComment(node, text);
}

function innerParsePGN(tokens: Token[], fen: string = INITIAL_FEN, halfMoves = 0): TreeState {
    const tree = defaultTree(fen);
    let root = tree.root;
    let prevNode = root;
    root.halfMoves = halfMoves;
    const setup = parseFen(fen).unwrap();

    if (halfMoves === 0 && setup.turn === "black") {
        root.halfMoves += 1;
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.type === "Comment") {
            applyComment(root, token.value);
        } else if (token.type === "ParenOpen") {
            const variation = [];
            let subvariations = 0;
            i++;
            while (i < tokens.length && (subvariations > 0 || tokens[i].type !== "ParenClose")) {
                if (tokens[i].type === "ParenOpen") {
                    subvariations++;
                } else if (tokens[i].type === "ParenClose") {
                    subvariations--;
                }
                variation.push(tokens[i]);
                i++;
            }
            const newTree = innerParsePGN(variation, prevNode.fen, root.halfMoves - 1);
            const variationRoot = newTree.root;
            const first = variationRoot.children[0];
            if (first) {
                prevNode.children.push(first);
                // A comment before the variation's first move belongs to that
                // move; the node model has no field for it, so it is stored in
                // front of the node's own comment behind a separator.
                if (variationRoot.comment !== "") {
                    first.comment = `${variationRoot.comment}${PRE_MOVE_COMMENT_SEPARATOR}${first.comment}`;
                }
            } else {
                appendComment(prevNode, variationRoot.comment);
            }
            // Markups before the first move describe the parent position.
            addShapes(prevNode, variationRoot.shapes);
            if (prevNode.score === null && variationRoot.score !== null) {
                prevNode.score = variationRoot.score;
                prevNode.depth = variationRoot.depth;
            }
            if (prevNode.clock === undefined && variationRoot.clock !== undefined) {
                prevNode.clock = variationRoot.clock;
            }
        } else if (token.type === "ParenClose") {
        } else if (token.type === "Nag") {
            const annotation = nagToAnnotation(token.value);
            if (annotation !== "" && !root.annotations.includes(annotation)) {
                root.annotations.push(annotation);
                root.annotations.sort(compareAnnotations);
            }
        } else if (token.type === "San") {
            const [pos, error] = positionFromFen(root.fen);
            if (error) {
                continue;
            }
            let move = parseSan(pos, token.value);
            if (!move) {
                move = parseUci(token.value);
                if (!move) {
                    continue;
                }
            }
            const san = makeSan(pos, move);
            pos.play(move);

            const newTree = createNode({
                fen: makeFen(pos.toSetup()),
                move,
                san,
                halfMoves: root.halfMoves + 1,
            });
            root.children.push(newTree);

            prevNode = root;
            root = newTree;
        } else if (token.type === "Outcome") {
            break;
        }
    }
    return tree;
}

/** Builds the game tree from the token stream of the `lex_pgn` command. */
export function parsePgnTokens(tokens: Token[], initialFen?: string): TreeState {
    const headers = getPgnHeaders(tokens);
    const fen = initialFen?.trim() || headers.fen.trim();

    const [pos] = positionFromFen(fen);

    const tree = innerParsePGN(tokens, fen, pos?.turn === "black" ? 1 : 0);
    tree.headers = headers;
    tree.position = headers.start ?? [];
    return tree;
}

export async function parsePGN(pgn: string, initialFen?: string): Promise<TreeState> {
    const tokens = unwrap(await commands.lexPgn(pgn));
    return parsePgnTokens(tokens, initialFen);
}

function getPgnHeaders(tokens: Token[]): GameHeaders {
    const headersN = new Map<string, string>();

    for (const token of tokens) {
        if (token.type === "Header") {
            const { tag, value } = token.value;
            headersN.set(tag, decodePgnHeaderValue(value));
        } else if (token.type === "Outcome") {
            headersN.set("Result", token.value);
        }
    }

    const {
        Black,
        White,
        BlackElo,
        WhiteElo,
        Date,
        UTCTime,
        Site,
        Event,
        Result,
        FEN,
        Round,
        Start,
        Orientation,
        TimeControl,
        Variant,
        ...other
    } = Object.fromEntries(headersN);

    const isValidOutcome = (value: string): value is Outcome => {
        return ["*", "1-0", "0-1", "1/2-1/2"].includes(value);
    };

    const isValidOrientation = (value: string): value is "white" | "black" => {
        return ["white", "black"].includes(value);
    };

    const headers: GameHeaders = {
        id: 0,
        fen: FEN ?? INITIAL_FEN,
        result: isValidOutcome(Result) ? Result : "*",
        black: Black ?? "?",
        white: White ?? "?",
        round: Round ?? "?",
        black_elo: BlackElo === "-" ? 0 : BlackElo ? Number.parseInt(BlackElo) : undefined,
        white_elo: WhiteElo === "-" ? 0 : WhiteElo ? Number.parseInt(WhiteElo) : undefined,
        date: Date ?? "",
        time: UTCTime,
        site: Site ?? "",
        event: Event ?? "",
        start: JSON.parse(Start ?? "[]"),
        orientation: isValidOrientation(Orientation) ? Orientation : "white",
        time_control: TimeControl,
        variant: Variant,
        other: other,
    };
    return headers;
}

type ColorMap<T> = {
    [key in Color]: T;
};

export function getGameStats(root: TreeNode) {
    const whiteAnnotations = {
        "??": 0,
        "?": 0,
        "?!": 0,
        "!!": 0,
        "!": 0,
        "!?": 0,
    };

    const blackAnnotations = {
        "??": 0,
        "?": 0,
        "?!": 0,
        "!!": 0,
        "!": 0,
        "!?": 0,
    };

    if (root.children.length === 0) {
        return {
            whiteCPL: 0,
            blackCPL: 0,
            whiteAccuracy: 0,
            blackAccuracy: 0,
            whiteAnnotations,
            blackAnnotations,
        };
    }

    let prevScore: Score = root.score ?? INITIAL_SCORE;
    const cplosses: ColorMap<number[]> = {
        white: [],
        black: [],
    };
    const accuracies: ColorMap<number[]> = {
        white: [],
        black: [],
    };
    let node = root;
    while (node.children.length > 0) {
        node = node.children[0];
        for (const annotation of node.annotations) {
            if (isBasicAnnotation(annotation)) {
                if (node.halfMoves % 2 === 1) {
                    whiteAnnotations[annotation]++;
                } else {
                    blackAnnotations[annotation]++;
                }
            }
        }
        const color = node.halfMoves % 2 === 1 ? "white" : "black";
        if (node.score) {
            cplosses[color].push(getCPLoss(prevScore.value, node.score.value, color));
            accuracies[color].push(getAccuracy(prevScore.value, node.score.value, color));
            prevScore = node.score;
        }
    }
    const whiteCPL = mean(cplosses.white);
    const blackCPL = mean(cplosses.black);
    const whiteAccuracy = harmonicMean(accuracies.white);
    const blackAccuracy = harmonicMean(accuracies.black);

    return {
        whiteCPL,
        blackCPL,
        whiteAccuracy,
        blackAccuracy,
        whiteAnnotations,
        blackAnnotations,
    };
}

export type PiecesCount = {
    p: number;
    n: number;
    b: number;
    r: number;
    q: number;
};

export function getMaterialDiff(fen: string) {
    const res = parseFen(fen);
    if (res.isErr) {
        return null;
    }
    const board = res.unwrap().board;
    const { white, black } = board;

    const startingCounts = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const roles: { key: keyof PiecesCount; role: Role }[] = [
        { key: "p", role: "pawn" },
        { key: "n", role: "knight" },
        { key: "b", role: "bishop" },
        { key: "r", role: "rook" },
        { key: "q", role: "queen" },
    ];

    const pieces: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const whiteCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const blackCaptured: PiecesCount = { p: 0, n: 0, b: 0, r: 0, q: 0 };

    for (const { key, role } of roles) {
        const whiteCount = white.intersect(board[role]).size();
        const blackCount = black.intersect(board[role]).size();
        pieces[key] = whiteCount - blackCount;
        whiteCaptured[key] = Math.max(0, startingCounts[key] - blackCount);
        blackCaptured[key] = Math.max(0, startingCounts[key] - whiteCount);
    }

    const diff = pieces.p * 1 + pieces.n * 3 + pieces.b * 3 + pieces.r * 5 + pieces.q * 9;

    return { pieces, whiteCaptured, blackCaptured, diff };
}

export function stripClock(fen: string): string {
    return fen.split(" ").slice(0, -2).join(" ");
}

export function hasMorePriority(position1: number[], position2: number[]): boolean {
    if (isPrefix(position1, position2)) {
        return true;
    }

    // remove common beggining of the arrays
    let i = 0;
    while (i < position1.length && i < position2.length && position1[i] === position2[i]) {
        i++;
    }

    return position1[i] < position2[i];
}
