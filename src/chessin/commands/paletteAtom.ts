import { atom, getDefaultStore } from "jotai";

/** Whether the command palette (mod+k) is open. */
export const commandPaletteOpenAtom = atom(false);

/** Whether the keyboard-shortcut cheat sheet (`?`) is open. */
export const keymapCheatSheetOpenAtom = atom(false);

/** Opens the command palette from non-React code. */
export function openCommandPalette(): void {
    getDefaultStore().set(commandPaletteOpenAtom, true);
}

export function closeCommandPalette(): void {
    getDefaultStore().set(commandPaletteOpenAtom, false);
}

/** Opens the keyboard-shortcut cheat sheet from non-React code. */
export function openKeymapCheatSheet(): void {
    getDefaultStore().set(keymapCheatSheetOpenAtom, true);
}
