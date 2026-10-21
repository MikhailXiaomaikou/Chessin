import { Badge, Box, Group, Switch, Text, Tooltip } from "@mantine/core";
import { IconCpu, IconDeviceFloppy, IconWifiOff } from "@tabler/icons-react";
import i18n from "i18next";
import { useAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { registerCommand } from "@/chessin/commands/registry";
import { useAppVersion } from "@/chessin/shell/diagnostics";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { enginesAtom } from "@/state/atoms";
import type { Engine } from "@/utils/engines";

/** Height of the bar in px; the shell reserves exactly this much. */
export const STATUS_BAR_HEIGHT = 24;

/**
 * Local engines the user has switched on in the Engines page (`loaded`).
 * Remote engines (chessdb / Lichess cloud) are deliberately excluded: the chip
 * says "local", and cloud sources get their own indicator in S2.
 */
export function countEnabledEngines(engines: readonly Engine[] | undefined): number {
  if (!engines) return 0;
  return engines.filter((e) => e.type === "local" && e.loaded === true && e.enabled !== false)
    .length;
}

/**
 * 24px status bar at the bottom of the app shell.
 *
 * left:   save state (placeholder until the docstore lands)
 * centre: compute chip "本地 · N 引擎" (+ an offline chip when offline)
 * right:  offline switch bound to `offlineModeAtom`, app version
 *
 * Also registers the `status.toggleOffline` command for the palette.
 */
export function StatusBar() {
  const { t } = useTranslation();
  const engines = useAtomValue(enginesAtom);
  const [offline, setOffline] = useAtom(offlineModeAtom);
  const version = useAppVersion();
  const engineCount = countEnabledEngines(engines);

  useEffect(() => {
    return registerCommand({
      id: "status.toggleOffline",
      title: () => i18n.t("StatusBar.ToggleOffline"),
      section: "status",
      run: () => setOffline((prev) => !prev),
      aliases: ["offline", "online", "network", "离线", "联网", "网络"],
    });
  }, [setOffline]);

  return (
    <Box
      role="region"
      aria-label={t("StatusBar.Label")}
      data-chessin-status-bar
      h={STATUS_BAR_HEIGHT}
      px="xs"
      fz="xs"
      bg="var(--mantine-color-body)"
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        flexShrink: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
        borderTop: "1px solid var(--mantine-color-default-border)",
        userSelect: "none",
      }}
    >
      <Group gap={4} wrap="nowrap" data-slot="save-state">
        <IconDeviceFloppy size={12} aria-hidden="true" />
        <Text size="xs" c="dimmed" lh={1} span>
          {t("StatusBar.Saved")}
        </Text>
      </Group>

      <Group gap={6} wrap="nowrap" justify="center">
        <Tooltip label={t("StatusBar.Compute.Hint")} openDelay={400}>
          <Badge
            variant="light"
            size="xs"
            radius="sm"
            tt="none"
            leftSection={<IconCpu size={10} aria-hidden="true" />}
          >
            {t("StatusBar.Compute.Local", { count: engineCount })}
          </Badge>
        </Tooltip>
        {offline && (
          <Tooltip label={t("StatusBar.Offline.Hint")} openDelay={400}>
            <Badge
              variant="light"
              color="yellow"
              size="xs"
              radius="sm"
              tt="none"
              leftSection={<IconWifiOff size={10} aria-hidden="true" />}
            >
              {t("StatusBar.Offline")}
            </Badge>
          </Tooltip>
        )}
      </Group>

      <Group gap="sm" wrap="nowrap" justify="flex-end">
        <Tooltip label={t("StatusBar.Offline.Hint")} openDelay={400}>
          <Switch
            size="xs"
            labelPosition="left"
            label={t("StatusBar.Offline")}
            checked={offline}
            onChange={(event) => setOffline(event.currentTarget.checked)}
            styles={{
              body: { alignItems: "center" },
              label: { fontSize: "var(--mantine-font-size-xs)", paddingInlineEnd: 6 },
            }}
          />
        </Tooltip>
        <Text
          size="xs"
          c="dimmed"
          lh={1}
          span
          miw="4.5em"
          ta="right"
          aria-label={t("StatusBar.Version", { version })}
        >
          {version ? `v${version}` : ""}
        </Text>
      </Group>
    </Box>
  );
}
