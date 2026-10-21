import { Group, Kbd } from "@mantine/core";
import { platform } from "@tauri-apps/plugin-os";

function isMacOS(): boolean {
  try {
    return platform() === "macos";
  } catch {
    return false;
  }
}

const SYMBOLS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  enter: "↵",
  return: "↵",
  escape: "Esc",
  esc: "Esc",
  delete: "Del",
  backspace: "⌫",
  pageup: "PgUp",
  pagedown: "PgDn",
  space: "Space",
  tab: "Tab",
};

/** Formats one token of a hotkey string ("mod", "shift", "arrowleft", "f") for display. */
export function formatKeyToken(token: string, mac = isMacOS()): string {
  const key = token.trim().toLowerCase();
  switch (key) {
    case "mod":
    case "meta":
    case "cmd":
    case "command":
      return mac ? "⌘" : "Ctrl";
    case "ctrl":
    case "control":
      return mac ? "⌃" : "Ctrl";
    case "shift":
      return mac ? "⇧" : "Shift";
    case "alt":
    case "option":
      return mac ? "⌥" : "Alt";
    default:
      if (SYMBOLS[key]) return SYMBOLS[key];
      if (key.length === 1) return key.toUpperCase();
      if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
      return key;
  }
}

/** Renders a hotkey string such as "mod+shift+c" as a row of <Kbd> chips. */
export default function ShortcutKbd({ keys, size = "xs" }: { keys: string; size?: "xs" | "sm" }) {
  const mac = isMacOS();
  const tokens = keys.split("+").filter((k) => k.length > 0);
  return (
    <Group gap={2} wrap="nowrap">
      {tokens.map((token, i) => (
        <Kbd key={`${token}-${i}`} size={size}>
          {formatKeyToken(token, mac)}
        </Kbd>
      ))}
    </Group>
  );
}
