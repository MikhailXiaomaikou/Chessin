import { useAtomValue } from "jotai";
import { useHotkeys } from "react-hotkeys-hook";
import { typingGuardOptions } from "@/chessin/keymap/guard";
import { keyMapAtom } from "@/state/keybinds";

/**
 * `START_REVIEW` (T by default): a single-key binding, guarded against text
 * inputs and IME composition. Bound by the pages that can start a session
 * (the Today card on the "+" tab and the notebook); a preset may unbind it.
 */
export function useStartReviewHotkey(handler: () => void, enabled = true): void {
    const keyMap = useAtomValue(keyMapAtom);
    const keys = keyMap.START_REVIEW?.keys?.trim() ?? "";
    useHotkeys(
        keys || "t",
        (e) => {
            e.preventDefault();
            handler();
        },
        { ...typingGuardOptions, enabled: enabled && keys !== "" },
        [handler, enabled, keys],
    );
}
