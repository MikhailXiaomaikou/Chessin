import { Button, Card, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconNotebook, IconPlayerPlay } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { notebookChangedAtom, notebookStatsAtom, refreshNotebookStats } from "./cards";
import { clearNotebookNavigator, type NotebookNavigator, setNotebookNavigator } from "./commands";
import { loadTodayExtras, type TodayExtras } from "./today";

/**
 * "今天" card at the top of the "+" tab: cards due + 开始复习, synced games
 * waiting for a review, and one sentence about the latest review.
 */
export default function TodayCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stats = useAtomValue(notebookStatsAtom);
  const changed = useAtomValue(notebookChangedAtom);
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
  }, [changed]);

  useEffect(() => {
    const navigator: NotebookNavigator = (target) => {
      void navigate({ to: "/notebook", search: target.review ? { review: true } : {} });
    };
    setNotebookNavigator(navigator);
    return () => clearNotebookNavigator(navigator);
  }, [navigate]);

  const pending = extras?.pendingReviews ?? 0;
  const latest = extras?.latest ?? null;

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
            <Text size="sm">
              {stats.due > 0 ? t("Today.Due", { count: stats.due }) : t("Today.NoDue")}
            </Text>
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
            disabled={stats.due === 0}
            onClick={() => void navigate({ to: "/notebook", search: { review: true } })}
          >
            {t("Today.StartReview")}
          </Button>
          <Button variant="subtle" radius="md" onClick={() => void navigate({ to: "/notebook" })}>
            {t("Today.OpenNotebook")}
          </Button>
        </Group>
      </Group>
    </Card>
  );
}
