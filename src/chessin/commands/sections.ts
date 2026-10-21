import type { TFunction } from "i18next";

/** Display order of palette sections; unknown sections go last in first-seen order. */
export const SECTION_ORDER = [
    "detected",
    "file",
    "edit",
    "board",
    "engines",
    "view",
    "navigate",
    "sources",
    "status",
    "onboarding",
    "app",
    "help",
];

export function sectionLabel(section: string, t: TFunction): string {
    switch (section) {
        case "detected":
            return t("Palette.Section.Detected");
        case "file":
            return t("Menu.File");
        case "edit":
            return t("Menu.Edit");
        case "view":
            return t("Menu.View");
        case "help":
            return t("Menu.Help");
        case "board":
            return t("Palette.Section.Board");
        case "engines":
            return t("SideBar.Engines");
        case "navigate":
            return t("Palette.Section.Navigate");
        case "sources":
            return t("Palette.Section.Sources");
        case "status":
            return t("Palette.Section.Status");
        case "onboarding":
            return t("Palette.Section.Onboarding");
        case "app":
            return t("Palette.Section.App");
        default:
            return section;
    }
}

export function sectionRank(section: string): number {
    const i = SECTION_ORDER.indexOf(section);
    return i === -1 ? SECTION_ORDER.length : i;
}
