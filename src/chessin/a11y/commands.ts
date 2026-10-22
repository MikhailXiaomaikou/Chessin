import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { registerCommands } from "@/chessin/commands/registry";
import { getActiveTreeState } from "@/chessin/keymap/treeStores";
import { announce, canFocusBoard, focusBoard } from "./announce";
import { describePosition, langOf } from "./speech";

/**
 * Palette commands of the accessible board (plan X-9):
 *  - `board.focus` ("棋盘键盘模式", key `BOARD_FOCUS` = F6): moves keyboard
 *    focus into the mounted board's ARIA grid;
 *  - `board.describe` ("描述局面"): reads the material of both sides and who
 *    is to move through the live region, and shows the same text as a
 *    notification for sighted keyboard users.
 *
 * Registered once by `BoardA11y` at import time; both commands are greyed
 * out until a board is mounted.
 */

let unregister: (() => void) | null = null;

/** The "描述局面" text of the active tab's position; announced and shown. `null` without a board. */
export function describeActivePosition(): string | null {
    const state = getActiveTreeState();
    if (!state) return null;
    const text = describePosition(state.currentNode().fen, langOf(i18n.language), i18n.t);
    if (!text) return null;
    announce(text);
    notifications.show({ id: "chessin-a11y-describe", message: text, autoClose: 8000 });
    return text;
}

export function registerA11yCommands(): () => void {
    if (!unregister) {
        const noBoard = () => i18n.t("Palette.NoBoard");
        const off = registerCommands([
            {
                id: "board.focus",
                section: "board",
                title: () => i18n.t("A11y.Command.Focus"),
                shortcutKey: "BOARD_FOCUS",
                aliases: [
                    "keyboard",
                    "focus board",
                    "accessibility",
                    "screen reader",
                    "键盘模式",
                    "键盘走棋",
                    "无障碍",
                    "读屏",
                ],
                enabled: canFocusBoard,
                disabledReason: noBoard,
                run: () => {
                    focusBoard();
                },
            },
            {
                id: "board.describe",
                section: "board",
                title: () => i18n.t("A11y.Command.Describe"),
                aliases: [
                    "describe",
                    "material",
                    "read position",
                    "描述局面",
                    "子力",
                    "读出局面",
                    "无障碍",
                ],
                enabled: () => getActiveTreeState() !== undefined,
                disabledReason: noBoard,
                run: () => {
                    describeActivePosition();
                },
            },
        ]);
        unregister = () => {
            off();
            unregister = null;
        };
    }
    return unregister;
}
