import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconExternalLink,
  IconPlayerPlay,
  IconTrophy,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DeviationDoc, deviationMoveLabel } from "@/chessin/deviation/detect";
import { getDeviationDoc, onDeviationSaved } from "@/chessin/deviation/store";
import { openGameForKey } from "@/chessin/notebook/source";
import { onReviewSaved } from "@/chessin/review/events";
import type { KeyMoment } from "@/chessin/review/model";
import { enqueueReview } from "@/chessin/review/reviewGame";
import { getReview } from "@/chessin/review/store";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import { clearEventsNavigator, type EventsNavigator, setEventsNavigator } from "./commands";
import {
  type EventGameRow,
  type EventGroup,
  groupGames,
  opponentOf,
  type Outcome,
  outcomeFor,
} from "./group";
import { loadEventRows } from "./load";
import { detectThemes, type GameEvidence, keyMoments, type ThemeCard } from "./themes";

// t("Events.Color.white") t("Events.Color.black")
// t("Events.Outcome.win") t("Events.Outcome.draw") t("Events.Outcome.loss") t("Events.Outcome.unknown")
// t("Events.Kind.blunder") t("Events.Kind.mistake") t("Events.Kind.missed_win")
// t("Events.Kind.missed_draw") t("Events.Kind.only_move") t("Events.Kind.time_pressure")
// t("Events.Theme.EarlyRepertoireExit") t("Events.Theme.MidgameLoss")
// t("Events.Theme.UnconvertedWins") t("Events.Theme.TimePressure")

const OUTCOME_COLOR: Record<Outcome, string> = {
  win: "teal",
  draw: "gray",
  loss: "red",
  unknown: "gray",
};

const KIND_COLOR: Record<KeyMoment["kind"], string> = {
  blunder: "red",
  missed_win: "red",
  missed_draw: "orange",
  mistake: "orange",
  time_pressure: "yellow",
  only_move: "teal",
};

/** `/events`: the user's games grouped by event, with per-game key moments, repertoire exits and theme cards. */
export default function EventsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { event?: string };
  const [rows, setRows] = useState<EventGameRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `events.open` navigates through the router while the page is mounted.
  useEffect(() => {
    const navigator: EventsNavigator = (target) => {
      void navigate({ to: "/events", search: target.event ? { event: target.event } : {} });
    };
    setEventsNavigator(navigator);
    return () => clearEventsNavigator(navigator);
  }, [navigate]);

  useEffect(() => {
    let alive = true;
    loadEventRows().then(
      (loaded) => {
        if (alive) setRows(loaded);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => groupGames(rows ?? []), [rows]);
  const selected = groups.find((g) => g.id === search.event) ?? groups[0] ?? null;

  return (
    <Stack p="md" gap="md" h="100%" style={{ minHeight: 0 }}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>
            <Group gap="xs">
              <IconTrophy size="1.4rem" />
              {t("Events.Title")}
            </Group>
          </Title>
          <Text c="dimmed" size="sm">
            {t("Events.Desc")}
          </Text>
        </div>
      </Group>
      {error && (
        <Alert color="red" icon={<IconAlertTriangle size="1rem" />}>
          {t("Events.LoadError")}：{error}
        </Alert>
      )}
      {rows === null ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : groups.length === 0 ? (
        <Text c="dimmed">{t("Events.Empty")}</Text>
      ) : (
        <Group align="flex-start" wrap="nowrap" gap="md" style={{ flex: 1, minHeight: 0 }}>
          <ScrollArea h="100%" w={300} style={{ flex: "0 0 300px" }} offsetScrollbars>
            <Stack gap="xs">
              {groups.map((group) => (
                <EventRow
                  key={group.id}
                  group={group}
                  selected={selected?.id === group.id}
                  onSelect={() => void navigate({ to: "/events", search: { event: group.id } })}
                />
              ))}
            </Stack>
          </ScrollArea>
          <ScrollArea h="100%" style={{ flex: 1, minWidth: 0 }} offsetScrollbars>
            {selected && <EventDetail key={selected.id} group={selected} />}
          </ScrollArea>
        </Group>
      )}
    </Stack>
  );
}

function groupTitle(group: EventGroup, t: (key: string) => string): string {
  return group.event || group.site || t("Events.Unnamed");
}

function EventRow({
  group,
  selected,
  onSelect,
}: {
  group: EventGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <UnstyledButton onClick={onSelect} style={{ width: "100%" }}>
      <Card
        withBorder
        padding="sm"
        style={{ borderColor: selected ? "var(--mantine-primary-color-filled)" : undefined }}
      >
        <Stack gap={2}>
          <Text fw={600} size="sm" lineClamp={1}>
            {groupTitle(group, t)}
          </Text>
          <Text size="xs" c="dimmed">
            {group.year !== "?" ? `${group.year} · ` : ""}
            {group.site && group.site !== group.event ? `${group.site} · ` : ""}
            {t("Events.Games", { count: group.games.length })}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Events.Tally", group.tally)}
          </Text>
        </Stack>
      </Card>
    </UnstyledButton>
  );
}

function EventDetail({ group }: { group: EventGroup }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openInWorkspace = useOpenInWorkspace();
  const [evidence, setEvidence] = useState<Map<string, GameEvidence>>(new Map());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        group.games.map(async (g) => {
          const [review, deviation] = await Promise.all([
            getReview(g.key).catch(() => null),
            getDeviationDoc(g.key).catch(() => null),
          ]);
          const item: GameEvidence = {
            key: g.key,
            playerColor: g.playerColor,
            result: g.result,
            review,
            deviation,
          };
          return [g.key, item] as const;
        }),
      );
      if (alive) setEvidence(new Map(entries));
    };
    void load();
    const keys = new Set(group.games.map((g) => g.key));
    const offReview = onReviewSaved((r) => {
      if (keys.has(r.gameKey)) void load();
    });
    const offDeviation = onDeviationSaved((d) => {
      if (keys.has(d.gameKey)) void load();
    });
    return () => {
      alive = false;
      offReview();
      offDeviation();
    };
  }, [group]);

  const themes = useMemo(() => detectThemes(Array.from(evidence.values())), [evidence]);
  const unreviewed = group.games.filter((g) => !evidence.get(g.key)?.review);

  const reviewAll = async () => {
    if (unreviewed.length === 0) {
      notifications.show({ message: t("Events.ReviewAll.Nothing") });
      return;
    }
    let queued = 0;
    for (const g of unreviewed) {
      try {
        await enqueueReview(g.origin, {
          playerColor: g.playerColor,
          title: `${g.white} – ${g.black}`,
        });
        queued++;
      } catch (e) {
        console.warn("events: enqueueReview failed", e);
      }
    }
    notifications.show({ message: t("Events.ReviewAll.Queued", { count: queued }) });
  };

  const openGame = (row: EventGameRow) =>
    openGameForKey(row.key, {
      open: openInWorkspace,
      focus: () => void navigate({ to: "/" }),
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={3}>{groupTitle(group, t)}</Title>
          <Text size="sm" c="dimmed">
            {group.year !== "?" ? `${group.year} · ` : ""}
            {group.site ? `${group.site} · ` : ""}
            {t("Events.Games", { count: group.games.length })} · {t("Events.Tally", group.tally)}
          </Text>
        </div>
        <Tooltip label={t("Events.ReviewAll.Nothing")} disabled={unreviewed.length > 0}>
          <Button
            leftSection={<IconPlayerPlay size="1rem" />}
            variant="light"
            onClick={() => void reviewAll()}
          >
            {t("Events.ReviewAll")}
            {unreviewed.length > 0 ? ` (${unreviewed.length})` : ""}
          </Button>
        </Tooltip>
      </Group>

      <Card withBorder padding="sm">
        <Stack gap="xs">
          <Text fw={600}>{t("Events.Themes")}</Text>
          {themes.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t("Events.Themes.Empty")}
            </Text>
          ) : (
            themes.map((card) => <ThemeRow key={card.id} card={card} />)
          )}
        </Stack>
      </Card>

      <Stack gap="xs">
        {group.games.map((row) => (
          <GameCard
            key={row.key}
            row={row}
            evidence={evidence.get(row.key) ?? null}
            onOpen={() => void openGame(row)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function ThemeRow({ card }: { card: ThemeCard }) {
  const { t } = useTranslation();
  const params: Record<string, string | number> = { ...card.params };
  if (typeof params.color === "string") params.color = t(`Events.Color.${params.color}`);
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Badge variant="light" color="grape" style={{ flex: "0 0 auto" }}>
        {t("Events.Games", { count: card.games.length })}
      </Badge>
      <Text size="sm">{t(card.key, params)}</Text>
    </Group>
  );
}

function exitLine(doc: DeviationDoc | null, t: TFunction): string | null {
  if (!doc) return null;
  if (doc.status === "no_repertoire") return t("Events.Exit.NoRepertoire");
  if (doc.status === "no_match") return t("Events.Exit.NoMatch");
  const d = doc.deviation;
  if (!d) {
    return doc.exit.ply !== null
      ? t("Events.Exit.End", { move: Math.max(1, Math.ceil(doc.exit.ply / 2)) })
      : null;
  }
  const move = Math.max(1, Math.ceil(d.ply / 2));
  const played = deviationMoveLabel(d.ply, d.playedSan);
  return d.kind === "mine"
    ? t("Events.Exit.Mine", { move, played, prepared: d.preparedSan ?? "?" })
    : t("Events.Exit.Theirs", { move, played });
}

function GameCard({
  row,
  evidence,
  onOpen,
}: {
  row: EventGameRow;
  evidence: GameEvidence | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const opponent = opponentOf(row);
  const outcome = outcomeFor(row.result, row.playerColor);
  const moments = keyMoments(evidence?.review);
  const exit = exitLine(evidence?.deviation ?? null, t);
  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            {row.round && row.round !== "?" && (
              <Text size="xs" c="dimmed">
                {t("Events.Round", { round: row.round })}
              </Text>
            )}
            <Badge size="sm" variant="outline" color="gray">
              {t(`Events.Color.${row.playerColor}`)}
            </Badge>
            <Text size="sm" fw={600}>
              {opponent.name || "?"}
              {opponent.elo ? ` (${opponent.elo})` : ""}
            </Text>
            <Badge size="sm" variant="light" color={OUTCOME_COLOR[outcome]}>
              {t(`Events.Outcome.${outcome}`)}
            </Badge>
            {row.date && (
              <Text size="xs" c="dimmed">
                {row.date}
              </Text>
            )}
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconExternalLink size="0.8rem" />}
            onClick={onOpen}
          >
            {t("Events.Open")}
          </Button>
        </Group>
        {!evidence?.review ? (
          <Text size="xs" c="dimmed">
            {t("Events.NotReviewed")}
          </Text>
        ) : moments.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t("Events.Moments.Empty")}
          </Text>
        ) : (
          moments.map((m) => (
            <Group key={m.id} gap="xs" wrap="nowrap">
              <Badge size="xs" variant="light" color={KIND_COLOR[m.kind]}>
                {t(`Events.Kind.${m.kind}`)}
              </Badge>
              <Text size="sm">
                {t("Events.Moment", {
                  played: deviationMoveLabel(m.ply, m.playedSan),
                  best: m.bestSan,
                })}
              </Text>
            </Group>
          ))
        )}
        {exit && (
          <Text size="xs" c="dimmed">
            {exit}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
