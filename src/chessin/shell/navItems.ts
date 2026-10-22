import {
    type Icon,
    IconBook,
    IconChess,
    IconCpu,
    IconDatabase,
    IconFiles,
    IconHome,
    IconSettings,
    IconTargetArrow,
    IconUsers,
} from "@tabler/icons-react";

/**
 * Chessin shell (S3-6): the six-position left navigation of IA-1
 * (docs/chessbase-teardown.md §8.3) plus the two rows pinned at the bottom.
 *
 * Pure data so the nav, the command-bar breadcrumb and the tests share one
 * definition. Labels are translation keys resolved by the components; the
 * keys are spelled out below for `i18next-cli extract`:
 *
 * t("Nav.Home") t("Nav.Library") t("Nav.Repertoire") t("Nav.Train") t("Nav.Players")
 * t("SideBar.Files") t("SideBar.Board") t("SideBar.Engines") t("SideBar.Settings")
 * t("Nav.ChessBase.Library") t("Nav.ChessBase.Collection") t("Nav.ChessBase.DefaultSource")
 * t("Nav.ChessBase.Repertoire")
 */

export type NavId =
    | "home"
    | "library"
    | "files"
    | "board"
    | "repertoire"
    | "train"
    | "players"
    | "engines"
    | "settings";

export type NavItem = {
    id: NavId;
    /** Route the row links to. */
    to: string;
    /**
     * Translation key of the visible label; it is also the row's `aria-label`,
     * so rows that existed before keep their accessible name (the e2e specs
     * select `a[aria-label="设置"|"Settings"]`).
     */
    labelKey: string;
    icon: Icon;
    /** Indented under the previous row (文件 under the 棋谱库 group). */
    child?: boolean;
    /** "ChessBase 里叫…" tooltip lines (translation keys), for migrating users. */
    chessBaseKeys?: readonly string[];
};

/** The six positions, in order. 棋谱库 is a group: its own row (/databases) plus 文件 (/files). */
export const NAV_ITEMS: readonly NavItem[] = [
    { id: "home", to: "/", labelKey: "Nav.Home", icon: IconHome },
    {
        id: "library",
        to: "/databases",
        labelKey: "Nav.Library",
        icon: IconDatabase,
        chessBaseKeys: [
            "Nav.ChessBase.Library",
            "Nav.ChessBase.Collection",
            "Nav.ChessBase.DefaultSource",
        ],
    },
    { id: "files", to: "/files", labelKey: "SideBar.Files", icon: IconFiles, child: true },
    { id: "board", to: "/", labelKey: "SideBar.Board", icon: IconChess },
    {
        id: "repertoire",
        to: "/repertoire",
        labelKey: "Nav.Repertoire",
        icon: IconBook,
        chessBaseKeys: ["Nav.ChessBase.Repertoire"],
    },
    { id: "train", to: "/notebook", labelKey: "Nav.Train", icon: IconTargetArrow },
    { id: "players", to: "/accounts", labelKey: "Nav.Players", icon: IconUsers },
];

/** Pinned at the bottom of the nav (设置 last, as in the wireframe). */
export const NAV_PINNED: readonly NavItem[] = [
    { id: "engines", to: "/engines", labelKey: "SideBar.Engines", icon: IconCpu },
    { id: "settings", to: "/settings", labelKey: "SideBar.Settings", icon: IconSettings },
];

export const ALL_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, ...NAV_PINNED];

/** AppShell navbar width with text labels. */
export const NAV_WIDTH = "11rem";
/** Width when collapsed to icons (the pre-S3-6 sidebar width). */
export const NAV_COLLAPSED_WIDTH = "3rem";

function pathStartsWith(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The nav position a location belongs to, or `null` for an unknown route.
 * "/" is the board page: it counts as 主页 while the active tab is the
 * new-tab home and as 棋盘 otherwise. The longest matching route wins, so
 * "/databases/x" is 棋谱库 even though "/" is a prefix of everything.
 */
export function navIdForPath(pathname: string, activeTabIsNew: boolean): NavId | null {
    if (pathname === "/" || pathname === "") return activeTabIsNew ? "home" : "board";
    let best: NavItem | null = null;
    for (const item of ALL_NAV_ITEMS) {
        if (item.to === "/") continue;
        if (pathStartsWith(pathname, item.to) && (!best || item.to.length > best.to.length)) {
            best = item;
        }
    }
    return best?.id ?? null;
}

export function isNavActive(item: NavItem, pathname: string, activeTabIsNew: boolean): boolean {
    return navIdForPath(pathname, activeTabIsNew) === item.id;
}

export function navItemById(id: NavId): NavItem {
    const item = ALL_NAV_ITEMS.find((i) => i.id === id);
    if (!item) throw new Error(`unknown nav item ${id}`);
    return item;
}
