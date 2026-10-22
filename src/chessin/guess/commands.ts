import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { notifications } from "@mantine/notifications";
import { registerCommands } from "@/chessin/commands/registry";
import { getActiveTreeStore, getTreeStore } from "@/chessin/keymap/treeStores";
import { gameKeyForOrigin, type PlayerColor, type Review } from "@/chessin/review/model";
import { getCachedReview } from "@/chessin/review/selection";
import { getReview } from "@/chessin/review/store";
import { accountPlayerNames } from "@/chessin/sync/myGames";
import { currentTabAtom, currentTabSelectedAtom } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { getGuessSession, setGuessSession } from "./atoms";
import {
    createGuessSession,
    finishSession,
    type GuessSession,
    guessTotals,
    isFinished,
    nextTarget,
    revealOrNext,
    saveGuessResult,
} from "./session";

/**
 * Palette commands `guess.start`, `guess.reveal`, `guess.stop` and the
 * helpers the panel shares with them. Registered once at import time
 * (`registerGuessCommands` is idempotent).
 */

let unregister: (() => void) | null = null;

// Keys reached through `tr()` below, spelled out for the i18n extractor:
// t("Guess.Summary") t("Guess.Empty") t("Guess.ResultTitle") t("Guess.Done")
// t("Guess.Command.Start") t("Guess.Command.Reveal") t("Guess.Command.Stop") t("Guess.Command.NoSession")
// t("Review.Color.White") t("Review.Color.Black") t("Palette.NoBoard")
function tr(key: string, options?: Record<string, unknown>): string {
    const value = i18n.t(key, options);
    return typeof value === "string" ? value : key;
}

/** The dock tab that hosts the review panel (and the guess panel while it runs). */
const REVIEW_DOCK_TAB = "review";

function showReviewTab(): void {
    try {
        getDefaultStore().set(currentTabSelectedAtom, REVIEW_DOCK_TAB);
    } catch {
        // No current tab: nothing to switch.
    }
}

/** The side the account plays in this game, else the review's side, else White. */
export function inferGuessColor(
    headers: { white: string; black: string },
    review: Review | null,
): PlayerColor {
    if (review?.playerColor) return review.playerColor;
    const names = accountPlayerNames().map((n) => n.toLowerCase());
    if (names.includes(headers.white.toLowerCase())) return "white";
    if (names.includes(headers.black.toLowerCase())) return "black";
    return "white";
}

/** The ply to start from: the move after the current position when the board is on the main line, else 1. */
export function startPlyFor(position: number[]): number {
    return position.every((i) => i === 0) ? position.length + 1 : 1;
}

export function guessSummaryText(session: GuessSession): string {
    const totals = guessTotals(session);
    return tr("Guess.Summary", {
        correct: totals.correct,
        total: totals.total,
        points: totals.points,
        max: totals.max,
    });
}

export type StartGuessOptions = {
    playerColor?: PlayerColor;
    /** Defaults to `startPlyFor(current position)`. */
    from?: number;
    /** Reuse a review already in hand (skips the store lookup). */
    review?: Review | null;
};

/** Builds and starts a session for the tab's game; returns it, or null when there is no board or nothing to guess. */
export async function startGuess(
    tabId: string,
    store: TreeStore,
    gameKey: string | null,
    options: StartGuessOptions = {},
): Promise<GuessSession | null> {
    const state = store.getState();
    let review: Review | null = options.review ?? null;
    if (review === null && gameKey) {
        review = getCachedReview(gameKey) ?? (await getReview(gameKey));
    }
    const playerColor = options.playerColor ?? inferGuessColor(state.headers, review);
    const session = createGuessSession({
        review,
        tree: { root: state.root },
        playerColor,
        from: options.from ?? startPlyFor(state.position),
        gameKey,
    });
    if (session.targets.length === 0) {
        notifications.show({
            color: "yellow",
            message: tr("Guess.Empty", {
                color:
                    playerColor === "white" ? tr("Review.Color.White") : tr("Review.Color.Black"),
            }),
        });
        return null;
    }
    setGuessSession(tabId, session);
    showReviewTab();
    return session;
}

export async function startGuessForActiveTab(options: StartGuessOptions = {}): Promise<boolean> {
    const tab = getDefaultStore().get(currentTabAtom);
    const store = getActiveTreeStore();
    if (!tab || !store) {
        notifications.show({ color: "yellow", message: tr("Palette.NoBoard") });
        return false;
    }
    const session = await startGuess(tab.value, store, gameKeyForOrigin(tab.gameOrigin), options);
    return session !== null;
}

/** Stores the finished session's result once (keyed by its start time). */
const saved = new Set<string>();

async function persist(session: GuessSession, title: string): Promise<void> {
    if (!session.gameKey || session.steps.length === 0) return;
    const key = `${session.gameKey}:${session.startedAt}`;
    if (saved.has(key)) return;
    saved.add(key);
    try {
        await saveGuessResult(session, tr("Guess.ResultTitle", { title }));
    } catch (error) {
        saved.delete(key);
        console.error("[chessin/guess] saving the result failed", error);
    }
}

function tabTitle(tabId: string): string {
    const tab = getDefaultStore().get(currentTabAtom);
    if (tab && tab.value === tabId) return tab.name;
    const headers = getTreeStore(tabId)?.getState().headers;
    return headers ? `${headers.white || "?"} – ${headers.black || "?"}` : tabId;
}

/** "揭晓": reveals the current target, or steps past it when already revealed. Saves the result on the last one. */
export function revealGuess(tabId: string): boolean {
    const session = getGuessSession(tabId);
    if (!session || isFinished(session)) return false;
    const next = revealOrNext(session);
    setGuessSession(tabId, next);
    if (isFinished(next)) void persist(next, tabTitle(tabId));
    return true;
}

/** Moves to the next target (no-op until the current one is revealed). */
export function advanceGuess(tabId: string): boolean {
    const session = getGuessSession(tabId);
    if (!session || isFinished(session)) return false;
    const next = nextTarget(session);
    if (next === session) return false;
    setGuessSession(tabId, next);
    if (isFinished(next)) void persist(next, tabTitle(tabId));
    return true;
}

/** Ends the session: stores what was answered, shows the summary, clears the tab's session. */
export function stopGuess(tabId: string): boolean {
    const session = getGuessSession(tabId);
    if (!session) return false;
    const finished = finishSession(session);
    if (finished.steps.length > 0) {
        void persist(finished, tabTitle(tabId));
        notifications.show({
            id: "chessin-guess-summary",
            title: tr("Guess.Done"),
            message: guessSummaryText(finished),
        });
    }
    setGuessSession(tabId, null);
    return true;
}

export function registerGuessCommands(): () => void {
    if (unregister) return unregister;
    const store = getDefaultStore();
    const hasBoard = () => getActiveTreeStore() !== undefined;
    const activeSession = () => {
        const tab = store.get(currentTabAtom);
        return tab ? getGuessSession(tab.value) : null;
    };

    unregister = registerCommands([
        {
            id: "guess.start",
            section: "board",
            title: () => tr("Guess.Command.Start"),
            aliases: ["guess the move", "guess", "猜着", "猜棋", "猜一猜", "猜着法"],
            enabled: hasBoard,
            disabledReason: () => tr("Palette.NoBoard"),
            run: () => {
                void startGuessForActiveTab();
            },
        },
        {
            id: "guess.reveal",
            section: "board",
            title: () => tr("Guess.Command.Reveal"),
            shortcutKey: "REVEAL",
            aliases: ["reveal", "揭晓", "下一着", "next guess"],
            enabled: () => {
                const session = activeSession();
                return !!session && !isFinished(session);
            },
            disabledReason: () => tr("Guess.Command.NoSession"),
            run: () => {
                const tab = store.get(currentTabAtom);
                if (tab) revealGuess(tab.value);
            },
        },
        {
            id: "guess.stop",
            section: "board",
            title: () => tr("Guess.Command.Stop"),
            aliases: ["stop guessing", "结束猜着", "退出猜着"],
            enabled: () => activeSession() !== null,
            disabledReason: () => tr("Guess.Command.NoSession"),
            run: () => {
                const tab = store.get(currentTabAtom);
                if (tab) stopGuess(tab.value);
            },
        },
    ]);
    return unregister;
}

registerGuessCommands();
