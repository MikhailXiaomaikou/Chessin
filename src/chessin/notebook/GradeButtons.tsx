import { Button, Paper, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import type { Card } from "ts-fsrs";
import { useTranslation } from "react-i18next";
import { formatReviewInterval } from "@/components/files/opening";
import { type NotebookRating, nextReviewTimes } from "./cards";

/**
 * 重来 / 困难 / 良好 / 简单 with the next-due preview of each rating
 * (same layout as the practice panel's quality rating, keyed 1–4).
 */
export default function GradeButtons({
  card,
  now,
  onRate,
  disabled = false,
  prompt,
}: {
  card: Card;
  /** Reference time of the preview (captured by the parent when the answer was found). */
  now: number;
  onRate: (rating: NotebookRating) => void;
  disabled?: boolean;
  prompt?: string;
}) {
  const { t } = useTranslation();
  const times = nextReviewTimes(card, now);
  const grades: { rating: NotebookRating; color: string; label: string }[] = [
    { rating: 1, color: "red", label: t("Notebook.Grade.Again") },
    { rating: 2, color: "orange", label: t("Notebook.Grade.Hard") },
    { rating: 3, color: "blue", label: t("Notebook.Grade.Good") },
    { rating: 4, color: "green", label: t("Notebook.Grade.Easy") },
  ];
  return (
    <Paper p="sm" withBorder>
      <Stack gap="sm" align="center">
        {prompt && (
          <Text fz="sm" c="dimmed">
            {prompt}
          </Text>
        )}
        <SimpleGrid cols={4} spacing="xs" style={{ width: "100%" }}>
          {grades.map((g) => (
            <Tooltip key={g.rating} label={formatReviewInterval(times[g.rating])}>
              <Button
                color={g.color}
                variant="light"
                size="compact-md"
                disabled={disabled}
                onClick={() => onRate(g.rating)}
                style={{ height: "auto", padding: "4px 0" }}
                data-rating={g.rating}
              >
                <Stack gap={0} align="center">
                  <Text fz="xs" fw={600}>
                    {g.label}
                  </Text>
                  <Text fz={10} c="dimmed">
                    {formatReviewInterval(times[g.rating])}
                  </Text>
                </Stack>
              </Button>
            </Tooltip>
          ))}
        </SimpleGrid>
        <Text fz={10} c="dimmed">
          {t("Notebook.Session.KeyboardHint")}
        </Text>
      </Stack>
    </Paper>
  );
}
