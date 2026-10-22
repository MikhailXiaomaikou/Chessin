/**
 * Turns an `Explanation` into one sentence through the app's translator.
 *
 * Template keys are `Explain.<id>` and `Explain.<id>.<variant>`; parameters are
 * language-neutral (chessops role names, squares, SAN) and localised here:
 * piece names become 王/后/车/象/马/兵 in Chinese and king/queen/… in English,
 * `pieceOn`-style short forms use 马e5 / Ne5.
 */
import type { Role } from "chessops";
import type { AnyTranslate, Explanation, Lang, Translate } from "./types";

const PIECE_NAMES: Record<Lang, Record<Role, string>> = {
    zh: { king: "王", queen: "后", rook: "车", bishop: "象", knight: "马", pawn: "兵" },
    en: {
        king: "king",
        queen: "queen",
        rook: "rook",
        bishop: "bishop",
        knight: "knight",
        pawn: "pawn",
    },
};

const PIECE_LETTERS: Record<Lang, Record<Role, string>> = {
    zh: PIECE_NAMES.zh,
    en: { king: "K", queen: "Q", rook: "R", bishop: "B", knight: "N", pawn: "P" },
};

const ROLES = new Set<string>(["king", "queen", "rook", "bishop", "knight", "pawn"]);
const ROLE_PARAMS = ["piece", "pinned", "pinner", "target", "captured"] as const;

export const isRole = (v: unknown): v is Role => typeof v === "string" && ROLES.has(v);

/** Localised long piece name ("knight" / "马"). */
export const pieceName = (role: Role, lang: Lang): string => PIECE_NAMES[lang][role];

/** Localised short piece name as used in notation ("N" / "马"). */
export const pieceLetter = (role: Role, lang: Lang): string => PIECE_LETTERS[lang][role];

/** "zh" for any Chinese locale, "en" otherwise. */
export const langOf = (language: string | undefined): Lang =>
    language && language.toLowerCase().startsWith("zh") ? "zh" : "en";

/** Formats a `role@square;role@square` list: "e5 的车和 g1 的王" / "the rook on e5 and the king on g1". */
export function formatTargets(encoded: string, lang: Lang): string {
    const parts = encoded
        .split(";")
        .map((p) => p.split("@"))
        .filter(([role, square]) => isRole(role) && square)
        .map(([role, square]) =>
            lang === "zh"
                ? `${square} 的${pieceName(role as Role, "zh")}`
                : `the ${pieceName(role as Role, "en")} on ${square}`,
        );
    if (parts.length === 0) return "";
    if (lang === "zh") return parts.join("和 ");
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Template variables for `e`: params with roles localised and a few derived short forms. */
export function templateVars(e: Explanation, lang: Lang): Record<string, string | number> {
    const vars: Record<string, string | number> = { ...e.params };
    for (const key of ROLE_PARAMS) {
        const role = e.params[key];
        if (isRole(role)) {
            vars[key] = pieceName(role, lang);
            vars[`${key}Role`] = role;
            vars[`${key}Letter`] = pieceLetter(role, lang);
        }
    }
    if (isRole(e.params.piece) && typeof e.params.square === "string") {
        vars.pieceOn = `${pieceLetter(e.params.piece, lang)}${e.params.square}`;
    }
    if (typeof e.params.targets === "string") vars.targets = formatTargets(e.params.targets, lang);
    return vars;
}

/** `Explain.<id>` plus the variant-specific key first, when a variant is set. */
export function templateKeys(e: Explanation): string[] {
    const base = `Explain.${e.id}`;
    const variant = e.params.variant;
    return typeof variant === "string" && variant ? [`${base}.${variant}`, base] : [base];
}

export function renderExplanation(e: Explanation, t: AnyTranslate, lang: Lang): string {
    const vars = templateVars(e, lang);
    const translate = t as Translate;
    const keys = templateKeys(e);
    for (const key of keys) {
        const out = translate(key, { ...vars, interpolation: { escapeValue: false } });
        if (typeof out === "string" && out && out !== key) return out;
    }
    return keys[0];
}

/** Evidence badge label key. */
export const evidenceKey = (evidence: Explanation["evidence"]): string =>
    `Explain.Evidence.${evidence}`;

/*
 * Static references so `i18next-cli extract` (removeUnusedKeys) keeps the
 * dynamically built keys. The extractor also scans comments.
 *
 * t("Explain.hanging_piece")
 * t("Explain.hanging_piece.left")
 * t("Explain.hanging_piece.weak")
 * t("Explain.missed_hanging_piece")
 * t("Explain.missed_hanging_piece.weak")
 * t("Explain.fork.allowed")
 * t("Explain.fork.missed")
 * t("Explain.pin.missed")
 * t("Explain.pin.allowed")
 * t("Explain.skewer.missed")
 * t("Explain.skewer.allowed")
 * t("Explain.back_rank")
 * t("Explain.back_rank.in2")
 * t("Explain.missed_mate")
 * t("Explain.missed_mate.likely")
 * t("Explain.allowed_mate")
 * t("Explain.allowed_mate.in2")
 * t("Explain.allowed_mate.likely")
 * t("Explain.trade_when_behind")
 * t("Explain.avoid_trade_when_ahead")
 * t("Explain.king_exposure.shield")
 * t("Explain.king_exposure.walk")
 * t("Explain.passed_pawn.missed")
 * t("Explain.passed_pawn.ignored")
 * t("Explain.piece_activity.develop")
 * t("Explain.piece_activity.castle")
 * t("Explain.piece_activity.centralize")
 * t("Explain.tempo_loss")
 * t("Explain.time_pressure")
 * t("Explain.time_pressure.rushed")
 * t("Explain.Evidence.certain")
 * t("Explain.Evidence.likely")
 * t("Explain.Evidence.heuristic")
 * t("Explain.Demo")
 * t("Explain.Phase.opening")
 * t("Explain.Phase.middlegame")
 * t("Explain.Phase.endgame")
 * t("Explain.Summary.WorstPhase")
 * t("Explain.Summary.NoLoss")
 * t("Explain.Summary.Mistakes")
 * t("Explain.Summary.Clean")
 * t("Explain.Summary.ThrewWins")
 * t("Explain.Summary.TimePressure")
 * t("Explain.Summary.BestPhase")
 */
export const EXPLAIN_TEMPLATE_KEYS: readonly string[] = [
    "Explain.hanging_piece",
    "Explain.hanging_piece.left",
    "Explain.hanging_piece.weak",
    "Explain.missed_hanging_piece",
    "Explain.missed_hanging_piece.weak",
    "Explain.fork.allowed",
    "Explain.fork.missed",
    "Explain.pin.missed",
    "Explain.pin.allowed",
    "Explain.skewer.missed",
    "Explain.skewer.allowed",
    "Explain.back_rank",
    "Explain.back_rank.in2",
    "Explain.missed_mate",
    "Explain.missed_mate.likely",
    "Explain.allowed_mate",
    "Explain.allowed_mate.in2",
    "Explain.allowed_mate.likely",
    "Explain.trade_when_behind",
    "Explain.avoid_trade_when_ahead",
    "Explain.king_exposure.shield",
    "Explain.king_exposure.walk",
    "Explain.passed_pawn.missed",
    "Explain.passed_pawn.ignored",
    "Explain.piece_activity.develop",
    "Explain.piece_activity.castle",
    "Explain.piece_activity.centralize",
    "Explain.tempo_loss",
    "Explain.time_pressure",
    "Explain.time_pressure.rushed",
    "Explain.Evidence.certain",
    "Explain.Evidence.likely",
    "Explain.Evidence.heuristic",
    "Explain.Demo",
    "Explain.Phase.opening",
    "Explain.Phase.middlegame",
    "Explain.Phase.endgame",
    "Explain.Summary.WorstPhase",
    "Explain.Summary.NoLoss",
    "Explain.Summary.Mistakes",
    "Explain.Summary.Clean",
    "Explain.Summary.ThrewWins",
    "Explain.Summary.TimePressure",
    "Explain.Summary.BestPhase",
];
