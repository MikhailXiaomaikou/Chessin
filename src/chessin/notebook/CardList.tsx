import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconTrash } from "@tabler/icons-react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useTranslation } from "react-i18next";
import type { NotebookCard } from "./cards";
import { moveNumberLabel, sanFromUci } from "./chess";
import { kindLabel } from "./ReviewSession";
import { gameKeyLabel } from "./source";

dayjs.extend(relativeTime);

export type CardFilter = "due" | "all";

function CardRow({
  card,
  now,
  onOpen,
  onDelete,
}: {
  card: NotebookCard;
  now: number;
  onOpen: (card: NotebookCard) => void;
  onDelete: (card: NotebookCard) => void;
}) {
  const { t } = useTranslation();
  const san =
    card.meta.san ?? sanFromUci(card.epd, card.answers[0] ?? "") ?? card.answers[0] ?? "?";
  const ply = card.source?.ply ?? 0;
  const due = dayjs(card.due);
  const overdue = card.due <= now;
  return (
    <Paper p="xs" withBorder radius="sm">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <Badge size="xs" variant="light" color={card.kind === "repertoire" ? "teal" : "blue"}>
              {kindLabel(card.kind, t)}
            </Badge>
            <Text fw={500} size="sm" truncate>
              {ply > 0 ? `${moveNumberLabel(ply)} ${san}` : san}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {card.meta.title ?? (card.source ? gameKeyLabel(card.source.gameKey) : card.epd)}
          </Text>
        </Stack>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Tooltip label={due.format("YYYY-MM-DD HH:mm")}>
            <Text size="xs" c={overdue ? "yellow" : "dimmed"}>
              {t("Notebook.List.DueAt", { when: due.fromNow() })}
            </Text>
          </Tooltip>
          {card.source && (
            <Tooltip label={t("Notebook.Source.Open")}>
              <ActionIcon variant="subtle" size="sm" onClick={() => onOpen(card)}>
                <IconExternalLink size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={t("Notebook.List.Delete")}>
            <ActionIcon variant="subtle" size="sm" color="red" onClick={() => onDelete(card)}>
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </Paper>
  );
}

export default function CardList({
  cards,
  now,
  filter,
  onFilter,
  onOpen,
  onDelete,
}: {
  cards: NotebookCard[];
  /** Time the list was loaded (decides which rows show as overdue). */
  now: number;
  filter: CardFilter;
  onFilter: (filter: CardFilter) => void;
  onOpen: (card: NotebookCard) => void;
  onDelete: (card: NotebookCard) => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={0} h="100%" style={{ overflow: "hidden" }}>
      <Group justify="space-between" p="sm" wrap="nowrap">
        <Group gap="xs">
          <Text fw={600}>{t("Notebook.List.Title")}</Text>
          <Text size="xs" c="dimmed">
            {t("Notebook.List.Count", { count: cards.length })}
          </Text>
        </Group>
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(value) => onFilter(value as CardFilter)}
          data={[
            { label: t("Notebook.List.Filter.Due"), value: "due" },
            { label: t("Notebook.List.Filter.All"), value: "all" },
          ]}
        />
      </Group>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap={4} px="sm" pb="sm">
          {cards.length === 0 && (
            <Text c="dimmed" ta="center" py="lg" fz="sm">
              {t("Notebook.List.Empty")}
            </Text>
          )}
          {cards.map((card) => (
            <CardRow key={card.id} card={card} now={now} onOpen={onOpen} onDelete={onDelete} />
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
