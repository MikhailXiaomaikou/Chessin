import { useAtomValue, useSetAtom } from "jotai";
import { useHotkeys } from "react-hotkeys-hook";
import { useGlobalCommands } from "@/chessin/commands/builtins";
import CommandPalette from "@/chessin/commands/CommandPalette";
import { commandPaletteOpenAtom, keymapCheatSheetOpenAtom } from "@/chessin/commands/paletteAtom";
import { typingGuardOptions } from "@/chessin/keymap/guard";
import KeymapCheatSheet from "@/chessin/keymap/KeymapCheatSheet";
import { getActiveTreeState } from "@/chessin/keymap/treeStores";
import FirstRun from "@/chessin/onboarding/FirstRun";
import { keyMapAtom } from "@/state/keybinds";

/**
 * Chessin shell mounts, rendered once from `src/routes/__root.tsx`:
 * the command palette (mod+k), the `?` shortcut cheat sheet, the first-run
 * screen, the global commands and the app-wide undo / redo hotkeys.
 * The status bar is placed by `__root.tsx` in the AppShell footer.
 */
export default function ChessinMounts() {
  const keyMap = useAtomValue(keyMapAtom);
  const setPaletteOpen = useSetAtom(commandPaletteOpenAtom);
  const setCheatSheetOpen = useSetAtom(keymapCheatSheetOpenAtom);

  useGlobalCommands();

  // The palette must open from anywhere, including text inputs.
  useHotkeys(
    keyMap.COMMAND_PALETTE.keys,
    (e) => {
      e.preventDefault();
      setPaletteOpen((open) => !open);
    },
    { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
    [setPaletteOpen],
  );

  // Undo / redo of the active tab's tree. Text inputs and the rich-text
  // editor keep their native undo (hotkeys are not enabled on form tags).
  useHotkeys(
    keyMap.UNDO.keys,
    (e) => {
      const state = getActiveTreeState();
      if (!state?.undo) return;
      e.preventDefault();
      state.undo();
    },
    { enableOnFormTags: false, enableOnContentEditable: false },
  );
  useHotkeys(
    keyMap.REDO.keys,
    (e) => {
      const state = getActiveTreeState();
      if (!state?.redo) return;
      e.preventDefault();
      state.redo();
    },
    { enableOnFormTags: false, enableOnContentEditable: false },
  );

  // `?` is a single-key binding: guarded against typing targets and IME composition.
  useHotkeys(
    keyMap.KEYBOARD_SHORTCUTS.keys,
    (e) => {
      e.preventDefault();
      setCheatSheetOpen((open) => !open);
    },
    { ...typingGuardOptions },
    [setCheatSheetOpen],
  );

  return (
    <>
      <CommandPalette />
      <KeymapCheatSheet />
      <FirstRun />
    </>
  );
}
