/**
 * Chessin: open a game in the board workspace ("/") from anywhere.
 *
 * Two entry points share one implementation:
 *
 * - `useOpenInWorkspace()` — for React call sites. Wraps TanStack's
 *   `useNavigate()` and replaces the upstream
 *   `createTab(...); navigate({ to: "/" })` pair (and the
 *   `openFile(...); navigate(...)` pair of the file browser). The only
 *   observable difference is ordering: navigation happens once the tab
 *   exists instead of while the PGN is still being parsed.
 * - `openInWorkspace()` — for non-React code (commands, jobs, notebook
 *   links). It writes the tab to the global jotai store and then navigates
 *   through whichever navigator is available: an explicit `navigate`
 *   argument, the navigator registered by the most recently mounted
 *   `useOpenInWorkspace()` (every call site registers its own, so one is
 *   available as soon as any of them has rendered), or — as a last resort —
 *   the browser history the router listens to.
 *
 * The router instance itself lives in `src/App.tsx` and is not exported, so
 * nothing here imports it; `setWorkspaceNavigator` is the one-line hook the
 * root route can call if a navigator is ever needed before any call site
 * has mounted.
 */
import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore } from "jotai";
import { useCallback, useEffect } from "react";
import type { FileMetadata } from "@/components/files/file";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { openFile } from "@/utils/files";
import { createTab, type GameOrigin, type Tab } from "@/utils/tabs";
import type { GameHeaders } from "@/utils/treeReducer";

type JotaiStore = ReturnType<typeof getDefaultStore>;

/** Minimal shape of a TanStack `navigate` function (only what we call). */
export type WorkspaceNavigate = (opts: { to: "/" }) => unknown;

/** `createTab` arguments (the common case: a game or position). */
export type OpenTabArgs = {
    tab: Omit<Tab, "value" | "gameOrigin">;
    pgn?: string;
    headers?: GameHeaders;
    gameOrigin?: GameOrigin;
    position?: number[];
};

/** `openFile` arguments (the file browser: PGN file + game number). */
export type OpenFileArgs = {
    file: string | FileMetadata;
    gameNumber?: number;
    pgn?: string;
};

export type OpenInWorkspaceOptions = {
    /** Navigate to the board after creating the tab. Default `true`. */
    focus?: boolean;
    /** Explicit navigator (React call sites pass `useNavigate()`). */
    navigate?: WorkspaceNavigate;
    /**
     * Jotai store for `tabsAtom` / `activeTabAtom` (tests). Defaults to the
     * global store, which is also what `openFile` uses for the recent-files
     * list and the practice tab mode.
     */
    store?: JotaiStore;
};

export type OpenInWorkspaceArgs = (OpenTabArgs | OpenFileArgs) & OpenInWorkspaceOptions;

export const WORKSPACE_PATH = "/";

let registeredNavigator: WorkspaceNavigate | null = null;

/**
 * Registers the navigator non-React callers fall back to. Every mounted
 * `useOpenInWorkspace()` does this; the root route may also call it once.
 */
export function setWorkspaceNavigator(navigate: WorkspaceNavigate | null): void {
    registeredNavigator = navigate;
}

export function getWorkspaceNavigator(): WorkspaceNavigate | null {
    return registeredNavigator;
}

function isOnWorkspace(): boolean {
    if (typeof window === "undefined") return true;
    return window.location.pathname === WORKSPACE_PATH;
}

/**
 * Last-resort navigation when no navigator is known. The router is created
 * with the default browser history, which patches `history.pushState` and
 * listens to `popstate`, so pushing the path makes it load "/" in place
 * (no reload). Outside a browser this is a no-op: the tab is already active,
 * so the board shows it on the next visit.
 */
function navigateViaHistory(): void {
    if (typeof window === "undefined") return;
    try {
        window.history.pushState(window.history.state, "", WORKSPACE_PATH);
        window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
        // jsdom without history support, or a sandboxed webview.
    }
}

/** Brings the board route into view when it is not already shown. */
export function focusWorkspace(navigate?: WorkspaceNavigate | null): void {
    if (isOnWorkspace()) return;
    const nav = navigate ?? registeredNavigator;
    if (nav) {
        void nav({ to: WORKSPACE_PATH });
        return;
    }
    navigateViaHistory();
}

function isFileArgs(args: OpenTabArgs | OpenFileArgs): args is OpenFileArgs {
    return "file" in args;
}

/**
 * Creates the tab on the jotai store and (by default) brings the board into
 * view. Resolves to the new tab id.
 */
export async function openInWorkspace(args: OpenInWorkspaceArgs): Promise<string> {
    const { focus = true, navigate, store = getDefaultStore() } = args;
    const setTabs: React.Dispatch<React.SetStateAction<Tab[]>> = (update) =>
        store.set(tabsAtom, update);
    const setActiveTab: React.Dispatch<React.SetStateAction<string | null>> = (update) =>
        store.set(activeTabAtom, update);

    let id: string;
    if (isFileArgs(args)) {
        id = await openFile(args.file, setTabs, setActiveTab, {
            gameNumber: args.gameNumber,
            pgn: args.pgn,
        });
    } else {
        id = await createTab({
            tab: args.tab,
            setTabs,
            setActiveTab,
            pgn: args.pgn,
            headers: args.headers,
            gameOrigin: args.gameOrigin,
            position: args.position,
        });
    }
    if (focus) {
        focusWorkspace(navigate);
    }
    return id;
}

/**
 * React hook: returns `openInWorkspace` bound to this component's router
 * navigator, and keeps that navigator registered for non-React callers.
 */
export function useOpenInWorkspace(): (
    args: OpenTabArgs | OpenFileArgs,
    options?: Omit<OpenInWorkspaceOptions, "navigate" | "store">,
) => Promise<string> {
    const navigate = useNavigate();
    useEffect(() => {
        registeredNavigator = navigate;
    }, [navigate]);
    return useCallback(
        (args, options) => openInWorkspace({ ...args, ...options, navigate }),
        [navigate],
    );
}
