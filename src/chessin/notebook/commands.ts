import i18n from "i18next";
import { registerCommands } from "@/chessin/commands/registry";

/**
 * Palette commands of the notebook: `notebook.open` ("错题本") and
 * `notebook.review` ("开始复习", opens the notebook and starts a session).
 *
 * Navigation: a mounted `NotebookPage` / `TodayCard` registers the router's
 * `navigate` through `setNotebookNavigator`; before any of them mounted the
 * commands fall back to pushing the path onto the browser history the router
 * listens to (same approach as `openInWorkspace`).
 */

export const NOTEBOOK_PATH = "/notebook";

export type NotebookTarget = { review?: boolean };
export type NotebookNavigator = (target: NotebookTarget) => void;

let navigator: NotebookNavigator | null = null;

export function setNotebookNavigator(next: NotebookNavigator | null): void {
    navigator = next;
}

/** Clears the navigator only when it is still `current` (unmount of the component that set it). */
export function clearNotebookNavigator(current: NotebookNavigator): void {
    if (navigator === current) navigator = null;
}

export function notebookHref(target: NotebookTarget = {}): string {
    return target.review ? `${NOTEBOOK_PATH}?review=true` : NOTEBOOK_PATH;
}

function navigateViaHistory(target: NotebookTarget): void {
    if (typeof window === "undefined") return;
    try {
        window.history.pushState(window.history.state, "", notebookHref(target));
        window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
        // Not in a browser (tests).
    }
}

/** Shows the notebook; with `{ review: true }` a review session starts right away. */
export function openNotebook(target: NotebookTarget = {}): void {
    if (navigator) {
        navigator(target);
        return;
    }
    navigateViaHistory(target);
}

let unregister: (() => void) | null = null;

/** Registers the palette commands once; returns the unregister function. */
export function registerNotebookCommands(): () => void {
    if (!unregister) {
        const off = registerCommands([
            {
                id: "notebook.open",
                section: "navigate",
                title: () => i18n.t("Notebook.Title"),
                aliases: ["notebook", "mistakes", "mistake notebook", "错题本", "错题", "笔记本"],
                run: () => openNotebook(),
            },
            {
                id: "notebook.review",
                section: "navigate",
                title: () => i18n.t("Notebook.StartReview"),
                aliases: ["review cards", "spaced repetition", "练习", "复习", "开始复习", "错题"],
                run: () => openNotebook({ review: true }),
            },
        ]);
        unregister = () => {
            off();
            unregister = null;
        };
    }
    return unregister;
}
