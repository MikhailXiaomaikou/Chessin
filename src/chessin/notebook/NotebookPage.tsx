import { Badge, Button, Group, Paper, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconNotebook, IconPlayerPlay } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import CardList, { type CardFilter } from "./CardList";
import {
  deleteCard,
  dueCards,
  listCards,
  type NotebookCard,
  notebookChangedAtom,
  notebookStatsAtom,
  refreshNotebookStats,
} from "./cards";
import { clearNotebookNavigator, type NotebookNavigator, setNotebookNavigator } from "./commands";
import { migrateLegacyDecks } from "./migration";
import ReviewSession from "./ReviewSession";
import { openGameForKey } from "./source";

/** `/notebook`: stats header, review session (left) and the card list (right). */
export default function NotebookPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { review?: boolean };
  const stats = useAtomValue(notebookStatsAtom);
  const changed = useAtomValue(notebookChangedAtom);
  const openInWorkspace = useOpenInWorkspace();

  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<NotebookCard[] | null>(null);
  const [filter, setFilter] = useState<CardFilter>("due");
  const [cards, setCards] = useState<{ list: NotebookCard[]; loadedAt: number }>({
    list: [],
    loadedAt: 0,
  });
  const autoStarted = useRef(false);

  // Palette commands (`notebook.open` / `notebook.review`) navigate through the router while mounted.
  useEffect(() => {
    const navigator: NotebookNavigator = (target) => {
      void navigate({ to: "/notebook", search: target.review ? { review: true } : {} });
    };
    setNotebookNavigator(navigator);
    return () => clearNotebookNavigator(navigator);
  }, [navigate]);

  // First open: migrate the legacy repertoire decks, then load the stats.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const result = await migrateLegacyDecks();
        if (alive && !result.skipped && result.migrated > 0) {
          notifications.show({
            message: t("Notebook.Migration.Done", { count: result.migrated }),
          });
        }
      } catch (e) {
        console.error("notebook: deck migration failed", e);
      }
      await refreshNotebookStats().catch(() => undefined);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  useEffect(() => {
    let alive = true;
    const loadedAt = Date.now();
    listCards({ dueBefore: filter === "due" ? loadedAt : null, limit: 500 })
      .then((list) => {
        if (alive) setCards({ list, loadedAt });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [filter, changed]);

  const startSession = useCallback(async () => {
    const due = await dueCards(Date.now(), 100);
    if (due.length === 0) {
      notifications.show({ message: t("Notebook.NothingDue") });
      return;
    }
    setSession(due);
  }, [t]);

  // `/notebook?review=true` (Today card, `notebook.review`) starts a session right away.
  useEffect(() => {
    if (ready && search.review && !autoStarted.current) {
      autoStarted.current = true;
      void startSession();
    }
  }, [ready, search.review, startSession]);

  const openSource = useCallback(
    async (card: NotebookCard) => {
      if (!card.source) return;
      const ok = await openGameForKey(card.source.gameKey, {
        ply: card.source.ply,
        open: (args) => openInWorkspace(args),
        focus: () => void navigate({ to: "/" }),
      });
      if (!ok) notifications.show({ color: "red", message: t("Notebook.Source.NotFound") });
    },
    [openInWorkspace, navigate, t],
  );

  const removeCard = useCallback(
    async (card: NotebookCard) => {
      await deleteCard(card.id);
      notifications.show({ message: t("Notebook.List.Deleted") });
    },
    [t],
  );

  return (
    <Stack h="100%" gap={0}>
      <Group justify="space-between" align="center" py="sm" px="lg" wrap="wrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size="lg" variant="light" radius="md">
            <IconNotebook size={20} />
          </ThemeIcon>
          <div>
            <Title order={3}>{t("Notebook.Title")}</Title>
            <Text size="sm" c="dimmed">
              {t("Notebook.Subtitle")}
            </Text>
          </div>
        </Group>
        <Group gap="xs">
          <Badge variant="light" color="yellow" size="lg">
            {t("Notebook.Stats.Due", { count: stats.due })}
          </Badge>
          <Badge variant="light" color="gray" size="lg">
            {t("Notebook.Stats.New", { count: stats.new })}
          </Badge>
          <Badge variant="light" color="green" size="lg">
            {t("Notebook.Stats.ReviewedToday", { count: stats.reviewedToday })}
          </Badge>
        </Group>
      </Group>

      <Group
        align="stretch"
        wrap="nowrap"
        px="md"
        pb="md"
        gap="md"
        style={{ flex: 1, overflow: "hidden" }}
      >
        <Paper withBorder style={{ flex: 3, minWidth: 0, overflow: "hidden" }}>
          {session ? (
            <ReviewSession
              key={session[0]?.id ?? "session"}
              cards={session}
              onExit={() => setSession(null)}
              onOpenSource={openSource}
            />
          ) : (
            <Stack align="center" justify="center" h="100%" gap="sm" p="md">
              {stats.total === 0 ? (
                <>
                  <Text fw={600}>{t("Notebook.Empty")}</Text>
                  <Text c="dimmed" fz="sm" ta="center">
                    {t("Notebook.Empty.Hint")}
                  </Text>
                </>
              ) : stats.due === 0 ? (
                <>
                  <ThemeIcon size="xl" radius="xl" color="green" variant="light">
                    <IconCheck size={24} />
                  </ThemeIcon>
                  <Text fw={600}>{t("Notebook.NothingDue")}</Text>
                  <Text c="dimmed" fz="sm" ta="center">
                    {t("Notebook.NothingDue.Hint")}
                  </Text>
                </>
              ) : (
                <Button
                  size="md"
                  variant="light"
                  leftSection={<IconPlayerPlay size={18} />}
                  rightSection={
                    <Badge size="sm" variant="white" color="blue">
                      {stats.due}
                    </Badge>
                  }
                  onClick={() => void startSession()}
                >
                  {t("Notebook.StartReview")}
                </Button>
              )}
            </Stack>
          )}
        </Paper>
        <Paper withBorder style={{ flex: 2, minWidth: 0, overflow: "hidden" }}>
          <CardList
            cards={cards.list}
            now={cards.loadedAt}
            filter={filter}
            onFilter={setFilter}
            onOpen={openSource}
            onDelete={removeCard}
          />
        </Paper>
      </Group>
    </Stack>
  );
}
