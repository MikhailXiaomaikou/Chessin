import {
  Box,
  Divider,
  Group,
  Kbd,
  Modal,
  ScrollArea,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { resolve, tempDir } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ShortcutKbd from "@/chessin/keymap/ShortcutKbd";
import { getActiveTreeStore } from "@/chessin/keymap/treeStores";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { openFile } from "@/utils/files";
import { handleDeepLink } from "@/utils/launch";
import { createTab } from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";
import { detectIntent, type QueryIntent } from "./detect";
import { commandPaletteOpenAtom } from "./paletteAtom";
import { isPinyinLoaded, loadPinyin } from "./pinyin";
import { useCommands } from "./registry";
import { buildFuse, indexCommands, searchCommands } from "./search";
import { sectionLabel, sectionRank } from "./sections";

type PaletteItem = {
  key: string;
  title: string;
  section: string;
  shortcut?: string;
  enabled: boolean;
  reason?: string;
  run: () => void | Promise<void>;
};

type PaletteGroup = { section: string; items: { item: PaletteItem; index: number }[] };

function groupItems(items: PaletteItem[], keepOrder: boolean): PaletteGroup[] {
  const groups = new Map<string, PaletteGroup>();
  items.forEach((item, index) => {
    let group = groups.get(item.section);
    if (!group) {
      group = { section: item.section, items: [] };
      groups.set(item.section, group);
    }
    group.items.push({ item, index });
  });
  const list = Array.from(groups.values());
  if (!keepOrder) {
    list.sort((a, b) => sectionRank(a.section) - sectionRank(b.section));
  }
  return list;
}

/** Command palette (mod+k). The modal unmounts its content when closed, so `PaletteContent` starts fresh on every open. */
export default function CommandPalette() {
  const { t } = useTranslation();
  const [opened, setOpened] = useAtom(commandPaletteOpenAtom);
  const [pinyinReady, setPinyinReady] = useState(isPinyinLoaded());

  useEffect(() => {
    if (!opened || isPinyinLoaded()) return;
    loadPinyin()
      .then(() => setPinyinReady(true))
      .catch(() => {});
  }, [opened]);

  const close = useCallback(() => setOpened(false), [setOpened]);

  return (
    <Modal
      opened={opened}
      onClose={close}
      withCloseButton={false}
      size="lg"
      yOffset="10vh"
      padding={0}
      radius="md"
      transitionProps={{ duration: 100 }}
      styles={{ body: { padding: 0 } }}
      aria-label={t("Keymap.COMMAND_PALETTE")}
    >
      <PaletteContent close={close} pinyinReady={pinyinReady} />
    </Modal>
  );
}

function PaletteContent({ close, pinyinReady }: { close: () => void; pinyinReady: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const commands = useCommands();
  const keyMap = useAtomValue(keyMapAtom);
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const [query, setQuery] = useState("");
  const [rawActive, setRawActive] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Memoised by the React Compiler on (commands, pinyinReady). Titles are resolved
  // through t() at index time; the content is remounted on every open, so a
  // language switch is picked up the next time the palette opens.
  const entries = indexCommands(commands, { pinyin: pinyinReady });
  const fuse = buildFuse(entries);

  const intent: QueryIntent = useMemo(() => detectIntent(query), [query]);

  const openFen = useCallback(
    async (fen: string) => {
      const tree = defaultTree(fen);
      tree.headers.fen = fen;
      await createTab({
        tab: { name: t("Home.Card.AnalysisBoard.Title"), type: "analysis" },
        setTabs,
        setActiveTab,
        pgn: "",
        headers: tree.headers,
      });
      navigate({ to: "/" });
    },
    [navigate, setActiveTab, setTabs, t],
  );

  const importPgn = useCallback(
    async (pgn: string) => {
      const tempFile = await resolve(await tempDir(), `import_${Date.now()}.pgn`);
      await writeTextFile(tempFile, pgn);
      await openFile(tempFile, setTabs, setActiveTab);
      navigate({ to: "/" });
    },
    [navigate, setActiveTab, setTabs],
  );

  const importGameUrl = useCallback(
    (url: string) =>
      handleDeepLink(`chessin://import?url=${encodeURIComponent(url)}`, setTabs, setActiveTab, () =>
        navigate({ to: "/" }),
      ),
    [navigate, setActiveTab, setTabs],
  );

  const goToMove = useCallback((move: number) => {
    const store = getActiveTreeStore();
    if (!store) return;
    const state = store.getState();
    const ply = Math.max(0, 2 * move - 1);
    const path: number[] = [];
    let node = state.root;
    while (path.length < ply && node.children.length > 0) {
      path.push(0);
      node = node.children[0];
    }
    state.goToMove(path);
  }, []);

  const items: PaletteItem[] = useMemo(() => {
    const hasBoard = getActiveTreeStore() !== undefined;
    switch (intent.kind) {
      case "fen":
        return [
          {
            key: "detected.fen",
            title: t("Palette.OpenFenInNewBoard"),
            section: "detected",
            enabled: true,
            run: () => openFen(intent.fen),
          },
        ];
      case "pgn":
        return [
          {
            key: "detected.pgn",
            title: t("Palette.ImportPgn"),
            section: "detected",
            enabled: true,
            run: () => importPgn(intent.pgn),
          },
        ];
      case "gameUrl":
        return [
          {
            key: "detected.url",
            title: t("Palette.ImportGameUrl"),
            section: "detected",
            enabled: true,
            run: () => importGameUrl(intent.url),
          },
        ];
      case "goToMove":
        return [
          {
            key: "detected.goto",
            title: t("Palette.GoToMove", { move: intent.move }),
            section: "detected",
            enabled: hasBoard,
            reason: hasBoard ? undefined : t("Palette.NoBoard"),
            run: () => goToMove(intent.move),
          },
        ];
      case "commands":
      case "search": {
        return searchCommands(entries, fuse, intent.query).map((e) => {
          const enabled = e.cmd.enabled ? e.cmd.enabled() : true;
          return {
            key: e.id,
            title: e.title,
            section: e.section,
            shortcut: e.cmd.shortcutKey ? keyMap[e.cmd.shortcutKey]?.keys : undefined,
            enabled,
            reason: enabled ? undefined : (e.cmd.disabledReason?.() ?? t("Palette.Unavailable")),
            run: e.cmd.run,
          };
        });
      }
    }
  }, [intent, entries, fuse, keyMap, t, openFen, importPgn, importGameUrl, goToMove]);

  const searching =
    (intent.kind === "search" || intent.kind === "commands") && intent.query.length > 0;
  const groups = useMemo(() => groupItems(items, searching), [items, searching]);

  // Clamp during render instead of resetting in an effect; `setQuery` resets it to 0.
  const active = items.length === 0 ? 0 : Math.min(rawActive, items.length - 1);

  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runItem = useCallback(
    async (item: PaletteItem | undefined) => {
      if (!item || !item.enabled) return;
      close();
      try {
        await item.run();
      } catch (e) {
        notifications.show({
          title: t("Common.Error"),
          message: e instanceof Error ? e.message : String(e),
          color: "red",
        });
      }
    },
    [close, t],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Never steal Enter / arrows from an IME composition (pinyin input).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setRawActive(items.length === 0 ? 0 : (active + 1) % items.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setRawActive(items.length === 0 ? 0 : (active - 1 + items.length) % items.length);
        break;
      case "Enter":
        e.preventDefault();
        void runItem(items[active]);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      default:
        break;
    }
  };

  return (
    <>
      <TextInput
        data-autofocus
        variant="unstyled"
        size="md"
        px="md"
        py={4}
        leftSection={<IconSearch size="1.1rem" />}
        placeholder={t("Palette.Placeholder")}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setRawActive(0);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls="chessin-palette-list"
      />
      <Divider />
      <ScrollArea.Autosize mah="50vh" type="auto" offsetScrollbars>
        <Box id="chessin-palette-list" role="listbox" p="xs">
          {items.length === 0 && (
            <Text c="dimmed" ta="center" py="md" size="sm">
              {t("Palette.NoResults")}
            </Text>
          )}
          {groups.map((group) => (
            <Box key={group.section} mb={4}>
              <Text size="xs" c="dimmed" fw={600} px="sm" pt={6} pb={2} tt="uppercase">
                {sectionLabel(group.section, t)}
              </Text>
              {group.items.map(({ item, index }) => {
                const isActive = index === active;
                const row = (
                  <UnstyledButton
                    key={item.key}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={!item.enabled}
                    w="100%"
                    px="sm"
                    py={6}
                    style={{
                      borderRadius: "var(--mantine-radius-sm)",
                      background: isActive ? "var(--mantine-color-default-hover)" : undefined,
                      opacity: item.enabled ? 1 : 0.5,
                      cursor: item.enabled ? "pointer" : "not-allowed",
                    }}
                    onMouseMove={() => {
                      if (!isActive) setRawActive(index);
                    }}
                    onClick={() => void runItem(item)}
                  >
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                      <Text size="sm" truncate>
                        {item.title}
                      </Text>
                      {item.shortcut && <ShortcutKbd keys={item.shortcut} />}
                    </Group>
                  </UnstyledButton>
                );
                if (!item.enabled && item.reason) {
                  return (
                    <Tooltip key={item.key} label={item.reason} position="right" withArrow>
                      {row}
                    </Tooltip>
                  );
                }
                return row;
              })}
            </Box>
          ))}
        </Box>
      </ScrollArea.Autosize>
      <Divider />
      <Group gap="md" px="md" py={6} wrap="nowrap">
        <Group gap={4} wrap="nowrap">
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd>
          <Text size="xs" c="dimmed">
            {t("Palette.Hint.Navigate")}
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Kbd size="xs">↵</Kbd>
          <Text size="xs" c="dimmed">
            {t("Palette.Hint.Run")}
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Kbd size="xs">&gt;</Kbd>
          <Text size="xs" c="dimmed">
            {t("Palette.Hint.CommandsOnly")}
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Kbd size="xs">:N</Kbd>
          <Text size="xs" c="dimmed">
            {t("Palette.Hint.GoToMove")}
          </Text>
        </Group>
      </Group>
    </>
  );
}
