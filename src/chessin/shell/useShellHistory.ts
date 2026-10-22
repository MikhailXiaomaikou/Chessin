import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { activeTabAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { goBack, goForward, type ShellNavigate, shellHistory } from "./history";

/** The router's `navigate` reduced to what the shell history needs (an `href`). */
export function useShellNavigate(): ShellNavigate {
    const navigate = useNavigate();
    return useCallback((href: string) => navigate({ href }), [navigate]);
}

/**
 * React binding of `shellHistory`: records a place on every route change and
 * active-tab change, binds `mod+[` / `mod+]`, and re-renders the caller when
 * the reachable places change. Mounted once, by the command bar.
 */
export function useShellHistory(): {
    back: () => void;
    forward: () => void;
    canBack: boolean;
    canForward: boolean;
} {
    const href = useRouterState({ select: (s) => s.location.href });
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const activeTab = useAtomValue(activeTabAtom);
    const store = useStore();
    const keyMap = useAtomValue(keyMapAtom);
    const navigate = useShellNavigate();

    useEffect(() => {
        // The board page without an active tab is transient (the tab bar is
        // about to create or restore one): not a place to come back to.
        if (pathname === "/" && activeTab === null) return;
        shellHistory.record({ route: href, tabId: pathname === "/" ? activeTab : null });
    }, [href, pathname, activeTab]);

    useSyncExternalStore(shellHistory.subscribe, shellHistory.version, shellHistory.version);

    const back = useCallback(() => {
        goBack(navigate, store);
    }, [navigate, store]);
    const forward = useCallback(() => {
        goForward(navigate, store);
    }, [navigate, store]);

    // Modifier chords: they may fire from text inputs, like the palette and "reopen tab".
    const chordOptions = { enableOnFormTags: true, enableOnContentEditable: true } as const;
    useHotkeys(
        keyMap.NAV_BACK.keys,
        (e) => {
            e.preventDefault();
            back();
        },
        chordOptions,
        [back],
    );
    useHotkeys(
        keyMap.NAV_FORWARD.keys,
        (e) => {
            e.preventDefault();
            forward();
        },
        chordOptions,
        [forward],
    );

    return {
        back,
        forward,
        canBack: shellHistory.canBack(),
        canForward: shellHistory.canForward(),
    };
}
