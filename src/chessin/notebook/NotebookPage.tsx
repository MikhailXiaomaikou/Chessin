import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconNotebook, IconPlayerPlay, IconSettings } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  clearQueueStarter,
  registerQueueCommands,
  setQueueStarter,
} from "@/chessin/queue/commands";
import { type LoadedQueue, loadQueue } from "@/chessin/queue/load";
import QueueSession from "@/chessin/queue/QueueSession";
import QueueSettingsModal from "@/chessin/queue/QueueSettingsModal";
import { queueChangedAtom, queueSettingsOpenAtom } from "@/chessin/queue/settings";
import { useStartReviewHotkey } from "@/chessin/queue/useStartReviewHotkey";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import CardList, { type CardFilter } from "./CardList";
import {
  deleteCard,
  listCards,
  type NotebookCard,
  notebookChangedAtom,
  notebookStatsAtom,
  refreshNotebookStats,
} from "./cards";
import { clearNotebookNavigator, type NotebookNavigator, setNotebookNavigator } from "./commands";
import { migrateLegacyDecks } from "./migration";
import { openGameForKey } from "./source";

registerQueueCommands();

/**
 * `/notebook`: stats header, the unified review queue session (left, S4-1)
 * and the card list (right). `?review=true` starts the queue right away.
 */
export default function NotebookPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { review?: boolean };
  const stats = useAtomValue(notebookStatsAtom);
  const changed = useAtomValue(notebookChangedAtom);
  const queueChanged = useAtomValue(queueChangedAtom);
  const openSettings = useSetAtom(queueSettingsOpenAtom);
  const openInWorkspace = useOpenInWorkspace();

  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<LoadedQueue | null>(null);
  // Today's queue while idle: drives the start button and its count.
  const [preview, setPreview] = useState<LoadedQueue | null>(null);
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

  useEffect(() => {
    if (!ready || session) return;
    let alive = true;
    loadQueue()
      .then((loaded) => {
        if (alive) setPreview(loaded);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ready, session, changed, queueChanged]);

  const startSession = useCallback(async () => {
    const loaded = await loadQueue();
    if (loaded.build.items.length === 0) {
      notifications.show({ message: t("Notebook.NothingDue") });
      return;
    }
    setSession(loaded);
  }, [t]);

  // `/notebook?review=true` (Today card, `notebook.review`, `queue.start`) starts a session right away.
  useEffect(() => {
    if (ready && search.review && !autoStarted.current) {
      autoStarted.current = true;
      void startSession();
    }
  }, [ready, search.review, startSession]);

  // `T` and the `queue.start` command start the queue in place while the page is mounted.
  useStartReviewHotkey(() => void startSession(), ready && !session);
  useEffect(() => {
    const starter = () => {
      if (!session) void startSession();
    };
    setQueueStarter(starter);
    return () => clearQueueStarter(starter);
  }, [session, startSession]);

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

  const queueCount = preview ? preview.build.items.length : stats.due;

  return (
    <Stack h="100%" gap={0}>
      <QueueSettingsModal />
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
            <QueueSession
              key={session.builtAt}
              build={session.build}
              settings={session.settings}
              onExit={() => setSession(null)}
              onOpenSource={openSource}
            />
          ) : (
            <Stack align="center" justify="center" h="100%" gap="sm" p="md">
              {stats.total === 0 && queueCount === 0 ? (
                <>
                  <Text fw={600}>{t("Notebook.Empty")}</Text>
                  <Text c="dimmed" fz="sm" ta="center">
                    {t("Notebook.Empty.Hint")}
                  </Text>
                </>
              ) : queueCount === 0 ? (
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
                <Group gap="xs">
                  <Button
                    size="md"
                    variant="light"
                    leftSection={<IconPlayerPlay size={18} />}
                    rightSection={
                      <Badge size="sm" variant="white" color="blue">
                        {queueCount}
                      </Badge>
                    }
                    onClick={() => void startSession()}
                  >
                    {t("Notebook.StartReview")}
                  </Button>
                  <Tooltip label={t("Queue.Command.Settings")}>
                    <ActionIcon
                      size="lg"
                      variant="subtle"
                      aria-label={t("Queue.Command.Settings")}
                      onClick={() => openSettings(true)}
                    >
                      <IconSettings size={18} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              )}
              {preview && queueCount > 0 && (
                <Text c="dimmed" fz="sm">
                  {t("Queue.Preview", { minutes: preview.build.minutes, count: queueCount })}
                </Text>
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
