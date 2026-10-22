import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useSetAtom } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getActiveTreeState, getActiveTreeStore } from "@/chessin/keymap/treeStores";
import { recentlyClosedAtom, reopenLastClosedTab } from "@/chessin/store/recentlyClosed";
import { allEnabledAtom, enableAllAtom } from "@/state/atoms";
import { keymapCheatSheetOpenAtom } from "./paletteAtom";
import { type Command, registerCommands } from "./registry";

/**
 * Registers the app-wide commands that do not belong to a menu entry in
 * `__root.tsx`: board-level actions routed through the active tab's tree
 * store, engine toggling, navigation and the shortcut cheat sheet.
 *
 * These are palette entries only; the per-board hotkeys stay where they are
 * (GameNotation, Board, BoardAnalysis…). Undo / redo hotkeys live in
 * `ChessinMounts`.
 */
export function useGlobalCommands(): void {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setCheatSheet = useSetAtom(keymapCheatSheetOpenAtom);

  useEffect(() => {
    const hasBoard = () => getActiveTreeStore() !== undefined;
    const noBoard = () => t("Palette.NoBoard");

    const nav = (id: string, to: string, title: () => string, aliases: string[]): Command => ({
      id,
      section: "navigate",
      title,
      aliases,
      run: () => {
        navigate({ to });
      },
    });

    const commands: Command[] = [
      {
        id: "edit.undo",
        section: "edit",
        title: () => t("Menu.Edit.Undo"),
        shortcutKey: "UNDO",
        aliases: ["undo", "撤销", "撤消", "回退"],
        enabled: () => {
          const s = getActiveTreeState();
          return !!s && typeof s.undo === "function" && (s.canUndo ?? true);
        },
        disabledReason: () => (hasBoard() ? t("Palette.NothingToUndo") : noBoard()),
        run: () => getActiveTreeState()?.undo?.(),
      },
      {
        id: "edit.redo",
        section: "edit",
        title: () => t("Menu.Edit.Redo"),
        shortcutKey: "REDO",
        aliases: ["redo", "重做", "恢复"],
        enabled: () => {
          const s = getActiveTreeState();
          return !!s && typeof s.redo === "function" && (s.canRedo ?? true);
        },
        disabledReason: () => (hasBoard() ? t("Palette.NothingToRedo") : noBoard()),
        run: () => getActiveTreeState()?.redo?.(),
      },
      {
        id: "board.copyPgn",
        section: "board",
        title: () => t("Palette.Command.CopyPgn"),
        shortcutKey: "COPY_PGN",
        aliases: ["copy pgn", "copy game", "复制棋谱", "复制对局", "pgn"],
        enabled: hasBoard,
        disabledReason: noBoard,
        run: () => getActiveTreeState()?.copyPgn(),
      },
      {
        id: "board.flip",
        section: "board",
        title: () => t("Palette.Command.FlipBoard"),
        shortcutKey: "SWAP_ORIENTATION",
        aliases: ["flip board", "swap orientation", "rotate", "翻转", "换边", "旋转棋盘"],
        enabled: hasBoard,
        disabledReason: noBoard,
        run: () => {
          const s = getActiveTreeState();
          if (!s) return;
          s.setHeaders({
            ...s.headers,
            orientation: s.headers.orientation === "black" ? "white" : "black",
          });
        },
      },
      {
        id: "board.clearShapes",
        section: "board",
        title: () => t("Palette.Command.ClearShapes"),
        shortcutKey: "CLEAR_SHAPES",
        aliases: ["clear arrows", "clear shapes", "清除箭头", "清除标记"],
        enabled: hasBoard,
        disabledReason: noBoard,
        run: () => getActiveTreeState()?.clearShapes(),
      },
      {
        id: "engines.toggleAll",
        section: "engines",
        title: () => t("Palette.Command.ToggleEngines"),
        shortcutKey: "TOGGLE_ALL_ENGINES",
        aliases: ["engine", "engines", "stockfish", "analyse", "analyze", "引擎", "分析"],
        enabled: hasBoard,
        disabledReason: noBoard,
        run: () => {
          const store = getDefaultStore();
          store.set(enableAllAtom, !store.get(allEnabledAtom));
        },
      },
      {
        // Hotkey (`REOPEN_TAB`, mod+shift+t) is bound in ChessinMounts.
        id: "view.reopenClosedTab",
        section: "view",
        title: () => t("Keymap.REOPEN_TAB", { defaultValue: "Reopen closed tab" }),
        shortcutKey: "REOPEN_TAB",
        aliases: [
          "reopen tab",
          "reopen closed tab",
          "recently closed",
          "重新打开",
          "恢复标签页",
          "最近关闭",
        ],
        enabled: () => getDefaultStore().get(recentlyClosedAtom).length > 0,
        run: () => void reopenLastClosedTab(),
      },
      {
        id: "help.keyboardShortcuts",
        section: "help",
        title: () => t("Keymap.Title"),
        shortcutKey: "KEYBOARD_SHORTCUTS",
        aliases: ["shortcuts", "keybinds", "hotkeys", "keyboard", "快捷键", "键位", "热键"],
        run: () => setCheatSheet(true),
      },
      nav("nav.board", "/", () => t("SideBar.Board"), ["board", "home", "棋盘", "主页"]),
      nav("nav.accounts", "/accounts", () => t("SideBar.User"), [
        "accounts",
        "user",
        "lichess",
        "chess.com",
        "账号",
        "用户",
      ]),
      nav("nav.files", "/files", () => t("SideBar.Files"), ["files", "文件", "棋谱"]),
      nav("nav.databases", "/databases", () => t("SideBar.Databases"), [
        "databases",
        "database",
        "数据库",
        "棋谱集",
      ]),
      nav("nav.engines", "/engines", () => t("SideBar.Engines"), ["engines", "stockfish", "引擎"]),
    ];

    return registerCommands(commands);
  }, [t, navigate, setCheatSheet]);
}
