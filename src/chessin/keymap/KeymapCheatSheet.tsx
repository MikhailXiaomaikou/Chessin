import { Anchor, Group, Modal, SimpleGrid, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { keymapCheatSheetOpenAtom } from "@/chessin/commands/paletteAtom";
import { keyMapAtom } from "@/state/keybinds";
import { KEYMAP_GROUPS, keybindLabel } from "./labels";
import ShortcutKbd from "./ShortcutKbd";

/** `?` cheat sheet: every keybind from `keyMapAtom`, grouped and translated. */
export default function KeymapCheatSheet() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [opened, setOpened] = useAtom(keymapCheatSheetOpenAtom);
  const keyMap = useAtomValue(keyMapAtom);

  const groups = useMemo(() => {
    const seen = new Set<string>();
    const result = KEYMAP_GROUPS.map((group) => ({
      id: group.id,
      label: group.label(t),
      rows: group.keys
        .filter((key) => key in keyMap)
        .map((key) => {
          seen.add(key);
          return { key, label: keybindLabel(key, t, keyMap[key].name), keys: keyMap[key].keys };
        }),
    })).filter((g) => g.rows.length > 0);
    const other = Object.keys(keyMap)
      .filter((key) => !seen.has(key))
      .map((key) => ({
        key,
        label: keybindLabel(key, t, keyMap[key].name),
        keys: keyMap[key].keys,
      }));
    if (other.length > 0) {
      result.push({ id: "other", label: t("Keymap.Group.Other"), rows: other });
    }
    return result;
  }, [keyMap, t]);

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Keymap.Title")}
      size="xl"
      radius="md"
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg" verticalSpacing="md">
        {groups.map((group) => (
          <Stack key={group.id} gap={4}>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              {group.label}
            </Text>
            {group.rows.map((row) => (
              <Group key={row.key} justify="space-between" wrap="nowrap" gap="sm">
                <Text size="sm" truncate>
                  {row.label}
                </Text>
                <ShortcutKbd keys={row.keys} />
              </Group>
            ))}
          </Stack>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="lg">
        {t("Keymap.Hint")}{" "}
        <Anchor
          size="xs"
          onClick={() => {
            setOpened(false);
            navigate({ to: "/settings" });
          }}
        >
          {t("Settings.Keybinds")}
        </Anchor>
      </Text>
    </Modal>
  );
}
