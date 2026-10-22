/**
 * Settings-search synonyms (plan X-10): what a ChessBase (or Lichess, or
 * everyday) word is called in Chessin, so searching "参考库" finds "默认来源"
 * and "Medals" finds "亮点". Terms follow src/chessin/i18n/terms.yaml
 * (`chessbase_en` column) plus the words users actually type.
 *
 * Each entry maps a list of `terms` (what the user may type, any language)
 * to `targets` (words that appear in a Chessin settings row's title,
 * description or keywords). `synonymsFor(query)` returns the targets whose
 * term matches the query; the search then runs those targets as extra queries
 * and tells the user "“参考库”在 Chessin 里叫“默认来源”".
 */

export type SettingSynonym = {
    terms: string[];
    targets: string[];
};

export type SynonymHit = { term: string; target: string };

export const SETTING_SYNONYMS: readonly SettingSynonym[] = [
    // ChessBase vocabulary (terms.yaml, chessbase_en)
    {
        terms: ["参考库", "参考数据库", "reference database", "reference db", "reference"],
        targets: ["默认来源", "default source", "来源", "source"],
    },
    { terms: ["奖章", "medals", "medal"], targets: ["亮点", "highlight"] },
    {
        terms: ["livebook", "live book", "在线开局书", "云开局库"],
        targets: ["来源芯片", "source chip", "开局探索器", "opening explorer", "来源", "source"],
    },
    {
        terms: ["引擎管理", "engine management", "uci 引擎", "uci engine", "uci"],
        targets: ["引擎", "engine"],
    },
    {
        terms: ["快捷键", "热键", "hotkey", "hotkeys", "shortcut", "shortcuts", "按键", "键盘"],
        targets: ["键位方案", "keymap", "keybinds", "快捷键"],
    },
    { terms: ["开局库", "ctg", "polyglot", "opening book"], targets: ["开局书", "book"] },
    {
        terms: ["残局库", "tablebase", "tablebases", "syzygy", "nalimov", "endgame"],
        targets: ["残局库目录", "tablebase", "残局"],
    },
    {
        terms: ["我的数据库", "my databases"],
        targets: ["棋谱库", "library", "数据库目录", "databases"],
    },
    { terms: ["数据库", "database"], targets: ["数据库目录", "databases"] },
    {
        terms: ["棋盘设计", "board design", "棋盘颜色", "board colors", "board colours"],
        targets: ["棋盘背景图", "board image", "棋子样式", "piece set"],
    },
    {
        terms: ["figurine", "figurines", "符号记谱", "图形记谱", "字母记谱"],
        targets: ["记谱风格", "notation"],
    },
    // Everyday words
    {
        terms: ["字号", "字体", "font", "text size", "放大", "zoom"],
        targets: ["字体大小", "font size"],
    },
    {
        terms: ["深色模式", "夜间模式", "dark mode", "night mode", "浅色", "light mode"],
        targets: ["主题", "theme"],
    },
    { terms: ["翻转", "旋转棋盘", "flip", "rotate"], targets: ["自动翻转棋盘", "flip board"] },
    { terms: ["升变", "promotion", "queen"], targets: ["自动升变", "auto promotion"] },
    {
        terms: ["音效", "声音", "sound", "audio", "静音", "mute"],
        targets: ["音量", "volume", "声音集", "sound collection"],
    },
    {
        terms: [
            "色盲",
            "色弱",
            "colorblind",
            "colourblind",
            "color blind",
            "colour blind",
            "okabe",
            "箭头颜色",
            "arrow colors",
            "arrow colours",
            "无障碍",
            "accessibility",
        ],
        targets: ["注释配色", "annotation colours", "annotation colors"],
    },
    {
        terms: ["搬家", "chessbase 导入", "import chessbase", "cbh", "en croissant"],
        targets: ["迁移", "migrate"],
    },
    {
        terms: ["账号", "账户", "account", "lichess", "chess.com"],
        targets: ["自动同步", "auto sync", "同步"],
    },
    { terms: ["拼写", "spelling"], targets: ["拼写检查", "spell check"] },
    { terms: ["坐标", "coordinates", "a-h", "1-8"], targets: ["坐标", "coordinates"] },
    { terms: ["语言", "language", "中文", "english", "locale"], targets: ["语言", "language"] },
    { terms: ["备份", "backup", "备份目录"], targets: ["备份", "backup"] },
    { terms: ["3d", "三维", "立体"], targets: ["3D 模式", "3d mode"] },
    {
        terms: ["间隔重复", "spaced repetition", "anki", "错题本", "notebook"],
        targets: ["自动难度", "auto difficulty", "开局体系", "repertoire"],
    },
];

function normalize(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Targets whose term matches `query` (either contains the other, case-insensitive;
 * single Latin letters never match so "a" does not expand to everything).
 */
export function synonymsFor(query: string): SynonymHit[] {
    const q = normalize(query);
    if (q.length === 0) return [];
    const hits: SynonymHit[] = [];
    const seen = new Set<string>();
    for (const entry of SETTING_SYNONYMS) {
        const term = entry.terms.find((candidate) => {
            const c = normalize(candidate);
            if (c.length === 0) return false;
            if (c === q) return true;
            const shorter = c.length < q.length ? c : q;
            if (shorter.length < 2) return false;
            // A multi-word query must match a term as a whole ("font 升变" is not a synonym query).
            if (q.includes(" ")) return c.includes(q);
            return c.includes(q) || q.includes(c);
        });
        if (!term) continue;
        for (const target of entry.targets) {
            const key = normalize(target);
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({ term, target });
        }
    }
    return hits;
}
