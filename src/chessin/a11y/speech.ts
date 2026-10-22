/**
 * Spoken forms for the board's screen-reader output (plan X-9).
 *
 * Three jobs, all pure and language-aware:
 *  - `sanToSpeech`: a SAN move becomes a sentence in the UI language
 *    ("马吃 e5，将军" / "Knight takes e5, check") for the live region;
 *  - `squareLabel`: the `aria-label` of one ARIA grid cell ("e4，白马" /
 *    "e4, white knight"; "e4，空" / "e4, empty");
 *  - `describePosition`: the material of both sides for the "描述局面"
 *    command ("白方：王、后、2 个车…。黑方走棋。").
 *
 * Vocabulary comes from the translator (`A11y.Speech.*`, `A11y.Color.*`,
 * `A11y.Square.*`, `A11y.Describe.*`); piece names reuse the explanation
 * renderer's table (王后车象马兵 / king…pawn) so both features say the same
 * words. Chinese and English compose differently; any other UI language gets
 * the English word order with its own vocabulary.
 */
import type { Color, Role } from "chessops";
import { langOf, pieceName } from "@/chessin/explain/render";
import type { AnyTranslate, Lang, Translate } from "@/chessin/explain/types";
import { positionFromFen } from "@/utils/chessops";

export { langOf };

export type SanParts = {
    castle?: "short" | "long";
    role: Role;
    /** Disambiguating file, rank or both ("b", "1", "b1"); empty when none. */
    from: string;
    capture: boolean;
    to: string;
    promotion?: Role;
    check: boolean;
    mate: boolean;
};

const ROLE_OF_LETTER: Record<string, Role> = {
    K: "king",
    Q: "queen",
    R: "rook",
    B: "bishop",
    N: "knight",
    P: "pawn",
};

const ROLES_IN_ORDER: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];
const PIECE_VALUES: Record<Role, number> = {
    king: 0,
    queen: 9,
    rook: 5,
    bishop: 3,
    knight: 3,
    pawn: 1,
};

const CASTLE_RE = /^(O-O-O|O-O|0-0-0|0-0)([+#])?$/;
const MOVE_RE = /^([KQRBNP])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=?([QRBN]))?([+#])?$/;

/** Strips NAG glyphs and "e.p." suffixes: "Nxe5!?" → "Nxe5", "exd6e.p." → "exd6". */
function cleanSan(san: string): string {
    return san
        .trim()
        .replace(/\s*e\.p\.$/i, "")
        .replace(/[!?]+$/, "")
        .trim();
}

/** Parses SAN into its spoken parts; `null` for anything that is not a move ("--", "Z0"). */
export function parseSanParts(san: string): SanParts | null {
    const clean = cleanSan(san);
    const castle = CASTLE_RE.exec(clean);
    if (castle) {
        const long = castle[1].length === 5;
        return {
            castle: long ? "long" : "short",
            role: "king",
            from: "",
            capture: false,
            to: "",
            check: castle[2] === "+",
            mate: castle[2] === "#",
        };
    }
    const m = MOVE_RE.exec(clean);
    if (!m) return null;
    const [, letter, file, rank, capture, to, promotion, suffix] = m;
    return {
        role: letter ? ROLE_OF_LETTER[letter] : "pawn",
        from: `${file ?? ""}${rank ?? ""}`,
        capture: capture === "x",
        to,
        promotion: promotion ? ROLE_OF_LETTER[promotion] : undefined,
        check: suffix === "+",
        mate: suffix === "#",
    };
}

function capitalize(text: string): string {
    return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function zhMove(p: SanParts, t: Translate): string {
    const takes = t("A11y.Speech.Takes");
    const to = t("A11y.Speech.To");
    const piece = pieceName(p.role, "zh");
    let body: string;
    if (p.role === "pawn") {
        body = p.capture ? `${p.from} ${piece}${takes} ${p.to}` : `${piece}${to} ${p.to}`;
    } else {
        const from = p.from ? ` ${p.from} ` : "";
        body = `${piece}${from}${p.capture ? takes : to} ${p.to}`;
    }
    if (p.promotion) {
        body += `，${t("A11y.Speech.PromotesTo", { piece: pieceName(p.promotion, "zh") })}`;
    }
    return body;
}

function enMove(p: SanParts, t: Translate): string {
    const takes = t("A11y.Speech.Takes");
    const to = t("A11y.Speech.To");
    const piece = pieceName(p.role, "en");
    let body: string;
    if (p.role === "pawn") {
        body = p.capture ? `${p.from} ${takes} ${p.to}` : p.to;
    } else {
        const from = p.from ? ` ${p.from}` : "";
        const link = p.capture ? ` ${takes}` : p.from ? ` ${to}` : "";
        body = `${piece}${from}${link} ${p.to}`;
    }
    if (p.promotion) {
        body += `, ${t("A11y.Speech.PromotesTo", { piece: pieceName(p.promotion, "en") })}`;
    }
    return body;
}

/**
 * "Nxe5+" → "马吃 e5，将军" (zh) / "Knight takes e5, check" (en).
 * Unparseable input is returned verbatim so nothing is silently dropped.
 */
export function sanToSpeech(san: string, lang: Lang, translate: AnyTranslate): string {
    const t = translate as Translate;
    const p = parseSanParts(san);
    if (!p) return san;
    let body: string;
    if (p.castle) {
        body = t(p.castle === "short" ? "A11y.Speech.CastleShort" : "A11y.Speech.CastleLong");
    } else {
        body = lang === "zh" ? zhMove(p, t) : enMove(p, t);
    }
    const suffix = p.mate ? t("A11y.Speech.Checkmate") : p.check ? t("A11y.Speech.Check") : "";
    if (lang === "zh") return suffix ? `${body}，${suffix}` : body;
    const text = suffix ? `${body}, ${suffix}` : body;
    // Pawn moves start with a square ("e4"); a capital would read as a different name.
    return p.role === "pawn" && !p.castle ? text : capitalize(text);
}

export function colorName(color: Color, translate: AnyTranslate): string {
    const t = translate as Translate;
    return t(color === "white" ? "A11y.Color.White" : "A11y.Color.Black");
}

export function sideName(color: Color, translate: AnyTranslate): string {
    const t = translate as Translate;
    return t(color === "white" ? "A11y.Side.White" : "A11y.Side.Black");
}

/** "白马" / "white knight". */
export function pieceLabel(role: Role, color: Color, lang: Lang, translate: AnyTranslate): string {
    const name = pieceName(role, lang);
    const colour = colorName(color, translate);
    return lang === "zh" ? `${colour}${name}` : `${colour} ${name}`;
}

/** `aria-label` of a grid cell: "e4，白马" / "e4, white knight"; "e4，空" / "e4, empty". */
export function squareLabel(
    square: string,
    piece: { role: Role; color: Color } | undefined,
    lang: Lang,
    translate: AnyTranslate,
): string {
    const t = translate as Translate;
    if (!piece) return t("A11y.Square.Empty", { square });
    return t("A11y.Square.Piece", {
        square,
        color: colorName(piece.color, t),
        piece: pieceName(piece.role, lang),
    });
}

function countPieces(n: number, role: Role, lang: Lang): string {
    const name = pieceName(role, lang);
    if (lang === "zh") return n === 1 ? name : `${n} 个${name}`;
    return n === 1 ? name : `${n} ${name}s`;
}

/** Spoken list of a side's material: "王、后、2 个车" / "king, queen, 2 rooks". */
export function materialSpeech(fen: string, color: Color, lang: Lang): string | null {
    const [pos] = positionFromFen(fen);
    if (!pos) return null;
    const parts: string[] = [];
    for (const role of ROLES_IN_ORDER) {
        const n = pos.board[color].intersect(pos.board[role]).size();
        if (n > 0) parts.push(countPieces(n, role, lang));
    }
    return parts.join(lang === "zh" ? "、" : ", ");
}

/**
 * The "描述局面 / Describe position" text: material per side, the material
 * balance and who is to move (with "in check" when applicable).
 */
export function describePosition(fen: string, lang: Lang, translate: AnyTranslate): string | null {
    const t = translate as Translate;
    const [pos] = positionFromFen(fen);
    if (!pos) return null;
    const sentences: string[] = [];
    let balance = 0;
    for (const color of ["white", "black"] as const) {
        const pieces = materialSpeech(fen, color, lang) || t("A11y.Describe.None");
        sentences.push(t("A11y.Describe.Side", { side: sideName(color, t), pieces }));
        for (const role of ROLES_IN_ORDER) {
            const n = pos.board[color].intersect(pos.board[role]).size();
            balance += (color === "white" ? 1 : -1) * n * PIECE_VALUES[role];
        }
    }
    sentences.push(
        balance === 0
            ? t("A11y.Describe.MaterialEqual")
            : t("A11y.Describe.MaterialUp", {
                  side: sideName(balance > 0 ? "white" : "black", t),
                  n: Math.abs(balance),
              }),
    );
    sentences.push(
        t(pos.isCheck() ? "A11y.Describe.ToMoveCheck" : "A11y.Describe.ToMove", {
            side: sideName(pos.turn, t),
        }),
    );
    return lang === "zh" ? `${sentences.join("。")}。` : `${sentences.join(". ")}.`;
}
