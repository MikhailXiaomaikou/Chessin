import { Badge, Button, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowBackUp,
  IconBook,
  IconClockPause,
  IconNotebook,
  IconPlus,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { eventIdForHeaders } from "@/chessin/events/group";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { tabsAtom } from "@/state/atoms";
import {
  dismissDeviation,
  findOpenRepertoireStore,
  openRepertoireAtDeviation,
  registerDeviationListener,
  setAsMyMove,
  snoozeDeviation,
  trainLine,
} from "./actions";
import { registerDeviationCommands } from "./commands";
import { type DeviationDoc, deviationMoveLabel } from "./detect";
import { getDeviationDoc, onDeviationSaved } from "./store";

registerDeviationCommands();
registerDeviationListener();

// t("Deviation.Badge.Mine") t("Deviation.Badge.Theirs") — chosen by a ternary below.

/**
 * Mounted once in the review panel's header (S4-3): the event badge that
 * opens `/events` for this game's event, and — once a review exists and a
 * deviation was detected — the 我偏离了 / 对手偏离了 card with its actions.
 */
export default function DeviationCards({ gameKey }: { gameKey: string }) {
  const [doc, setDoc] = useState<DeviationDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDeviationDoc(gameKey).then((d) => {
      if (!cancelled) setDoc(d);
    });
    const off = onDeviationSaved((d) => {
      if (d.gameKey === gameKey) setDoc(d);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [gameKey]);

  const show = doc && doc.gameKey === gameKey ? doc : null;
  const visible = show?.deviation && !show.dismissed && !show.snoozed ? show : null;

  return (
    <>
      <EventBadge />
      {visible && <DeviationCard doc={visible} />}
    </>
  );
}

/** "Event" badge of the game on the board; opens the event's review page. */
function EventBadge() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext);
  const headers = useStore(store!, (s) => s.headers);
  const navigate = useNavigate();
  const event = (headers.event ?? "").trim();
  const id = eventIdForHeaders(headers);
  if (!id || !event || event === "?") return null;
  return (
    <Group gap="xs">
      <Tooltip label={t("Events.Badge.Tooltip")}>
        <Badge
          variant="light"
          color="grape"
          leftSection={<IconTrophy size="0.8rem" />}
          style={{ cursor: "pointer" }}
          onClick={() => void navigate({ to: "/events", search: { event: id } })}
        >
          {event}
        </Badge>
      </Tooltip>
    </Group>
  );
}

function DeviationCard({ doc }: { doc: DeviationDoc }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openInWorkspace = useOpenInWorkspace();
  const tabs = useAtomValue(tabsAtom);
  const d = doc.deviation!;
  const move = Math.max(1, Math.ceil(d.ply / 2));
  const played = deviationMoveLabel(d.ply, d.playedSan);
  const mine = d.kind === "mine";
  // Re-evaluated whenever the tabs change (the board registers its store on mount).
  const repertoireStore = tabs ? findOpenRepertoireStore(d.repertoire.path) : undefined;

  const train = async () => {
    const result = await trainLine(doc);
    notifications.show({
      color: result ? undefined : "yellow",
      message: result
        ? t("Deviation.Train.Done", {
            move: deviationMoveLabel(d.ply, d.preparedSan ?? ""),
          })
        : t("Deviation.Train.Failed"),
    });
  };

  const setMine = () => {
    if (!repertoireStore) {
      notifications.show({ color: "yellow", message: t("Deviation.OpenFirst") });
      return;
    }
    const ok = setAsMyMove(repertoireStore, d);
    notifications.show({
      color: ok ? undefined : "yellow",
      message: ok
        ? t("Deviation.SetAsMine.Done", { move: played })
        : t("Deviation.SetAsMine.Failed"),
    });
  };

  const openRepertoire = async () => {
    const ok = await openRepertoireAtDeviation(doc, {
      open: openInWorkspace,
      focus: () => void navigate({ to: "/" }),
    });
    if (!ok) notifications.show({ color: "yellow", message: t("Deviation.FillReply.Failed") });
  };

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <Badge color={mine ? "orange" : "blue"} variant="light">
            {t(mine ? "Deviation.Badge.Mine" : "Deviation.Badge.Theirs")}
          </Badge>
          <Text size="sm" fw={600}>
            {played}
          </Text>
        </Group>
        <Text size="sm">
          {mine
            ? t("Deviation.Mine.Desc", {
                move,
                played,
                prepared: d.preparedSan ?? "?",
                repertoire: d.repertoire.name,
              })
            : t("Deviation.Theirs.Desc", { move, played, repertoire: d.repertoire.name })}
        </Text>
        {!mine && (
          <Text size="xs" c="dimmed">
            {d.popularity === null || d.popularity === undefined
              ? t("Deviation.Theirs.NoData")
              : t("Deviation.Theirs.Popularity", {
                  percent: (d.popularity * 100).toFixed(d.popularity < 0.1 ? 1 : 0),
                })}
          </Text>
        )}
        {!mine && d.replies && d.replies.length > 0 && (
          <Text size="xs" c="dimmed">
            {t("Deviation.Theirs.Replies")}：
            {d.replies.map((r) => `${r.san} ${(r.share * 100).toFixed(0)}%`).join("、")}
          </Text>
        )}
        <Group gap="xs">
          {mine ? (
            <>
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconNotebook size="0.8rem" />}
                disabled={!d.preparedUci}
                onClick={() => void train()}
              >
                {t("Deviation.Train")}
              </Button>
              <Tooltip label={t("Deviation.OpenFirst")} disabled={!!repertoireStore}>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconArrowBackUp size="0.8rem" />}
                  data-disabled={!repertoireStore || undefined}
                  onClick={setMine}
                >
                  {t("Deviation.SetAsMine", { move: d.playedSan })}
                </Button>
              </Tooltip>
              {!repertoireStore && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconBook size="0.8rem" />}
                  onClick={() => void openRepertoire()}
                >
                  {t("Deviation.OpenRepertoire")}
                </Button>
              )}
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconX size="0.8rem" />}
                onClick={() => void dismissDeviation(doc.gameKey)}
              >
                {t("Deviation.Ignore")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconPlus size="0.8rem" />}
                onClick={() => void openRepertoire()}
              >
                {t("Deviation.FillReply")}
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconClockPause size="0.8rem" />}
                onClick={() => void snoozeDeviation(doc.gameKey)}
              >
                {t("Deviation.Snooze")}
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
