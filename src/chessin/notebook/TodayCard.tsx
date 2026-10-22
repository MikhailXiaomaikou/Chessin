import { ActionIcon, Button, Card, Group, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { IconNotebook, IconPlayerPlay, IconSettings } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ShortcutKbd from "@/chessin/keymap/ShortcutKbd";
import { registerQueueCommands } from "@/chessin/queue/commands";
import { queueLine } from "@/chessin/queue/format";
import QueueSettingsModal from "@/chessin/queue/QueueSettingsModal";
import { queueChangedAtom, queueSettingsOpenAtom } from "@/chessin/queue/settings";
import { useStartReviewHotkey } from "@/chessin/queue/useStartReviewHotkey";
import { keyMapAtom } from "@/state/keybinds";
import { notebookChangedAtom, notebookStatsAtom, refreshNotebookStats } from "./cards";
import { clearNotebookNavigator, type NotebookNavigator, setNotebookNavigator } from "./commands";
import { currentLang, loadTodayExtras, type TodayExtras } from "./today";

// `queue.start` / `queue.settings` live in the palette from the first render of the home tab.
registerQueueCommands();

/**
 * "今天" card at the top of the "+" tab (S4-1): the unified review queue
 * ("18 分钟 · 34 项（开局体系 12、赛事失误 9、备战对王某 8（周六比赛）…）")
 * with 开始 (T), synced games waiting for a review, and one sentence about
 * the latest review.
 */
export default function TodayCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stats = useAtomValue(notebookStatsAtom);
  const changed = useAtomValue(notebookChangedAtom);
  const queueChanged = useAtomValue(queueChangedAtom);
  const openSettings = useSetAtom(queueSettingsOpenAtom);
  const keyMap = useAtomValue(keyMapAtom);
  const [extras, setExtras] = useState<TodayExtras | null>(null);

  useEffect(() => {
    let alive = true;
    refreshNotebookStats().catch(() => undefined);
    loadTodayExtras().then((result) => {
      if (alive) setExtras(result);
    });
    return () => {
      alive = false;
    };
  }, [changed, queueChanged]);

  useEffect(() => {
    const navigator: NotebookNavigator = (target) => {
      void navigate({ to: "/notebook", search: target.review ? { review: true } : {} });
    };
    setNotebookNavigator(navigator);
    return () => clearNotebookNavigator(navigator);
  }, [navigate]);

  const queue = extras?.queue ?? null;
  const count = queue?.build.items.length ?? 0;
  const pending = extras?.pendingReviews ?? 0;
  const latest = extras?.latest ?? null;
  const startKeys = keyMap.START_REVIEW?.keys?.trim() ?? "";

  const start = useCallback(() => {
    if (count === 0) return;
    void navigate({ to: "/notebook", search: { review: true } });
  }, [count, navigate]);
  useStartReviewHotkey(start, count > 0);

  let line: string;
  if (queue) {
    line =
      count > 0 ? queueLine(queue.build, t, currentLang(), queue.builtAt) : t("Today.Queue.Empty");
  } else {
    line = stats.due > 0 ? t("Today.Due", { count: stats.due }) : t("Today.NoDue");
  }

  return (
    <Card shadow="sm" p="lg" radius="md" withBorder data-testid="today-card">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="md" align="flex-start" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
          <ThemeIcon size={48} radius="md" variant="light">
            <IconNotebook size={28} />
          </ThemeIcon>
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Text fw={600} size="lg">
              {t("Today.Title")}
            </Text>
            <Text size="sm" data-testid="today-queue-line">
              {line}
            </Text>
            {queue?.build.catchUp && queue.build.dropped > 0 && (
              <Text size="sm" c="dimmed">
                {t("Today.Queue.CatchUp", { count: queue.build.dropped })}
              </Text>
            )}
            {queue && queue.build.newCapped > 0 && (
              <Text size="sm" c="dimmed">
                {t("Today.Queue.NewCapped", { count: queue.build.newCapped })}
              </Text>
            )}
            {pending > 0 && (
              <Text size="sm" c="dimmed">
                {t("Today.PendingReview", { count: pending })}
              </Text>
            )}
            {latest && (
              <Text size="sm" c="dimmed" lineClamp={2}>
                {latest.title
                  ? t("Today.LatestReviewOf", { title: latest.title, sentence: latest.sentence })
                  : t("Today.LatestReview", { sentence: latest.sentence })}
              </Text>
            )}
          </Stack>
        </Group>
        <Group gap="xs" style={{ flexShrink: 0 }}>
          <Button
            variant="light"
            radius="md"
            leftSection={<IconPlayerPlay size={16} />}
            rightSection={startKeys ? <ShortcutKbd keys={startKeys} /> : undefined}
            disabled={count === 0}
            onClick={start}
            data-testid="today-start"
          >
            {t("Today.Start")}
          </Button>
          <Tooltip label={t("Queue.Command.Settings")}>
            <ActionIcon
              variant="subtle"
              radius="md"
              size="lg"
              aria-label={t("Queue.Command.Settings")}
              onClick={() => openSettings(true)}
            >
              <IconSettings size={18} />
            </ActionIcon>
          </Tooltip>
          <Button variant="subtle" radius="md" onClick={() => void navigate({ to: "/notebook" })}>
            {t("Today.OpenNotebook")}
          </Button>
        </Group>
      </Group>
      <QueueSettingsModal />
    </Card>
  );
}
