import {
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconClock } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import FindMoveBoard from "@/chessin/board/FindMoveBoard";
import type { NotebookCard, NotebookRating } from "@/chessin/notebook/cards";
import { fenFromEpd, sanFromUci } from "@/chessin/notebook/chess";
import GradeButtons from "@/chessin/notebook/GradeButtons";
import {
  colorLabel,
  explanationSentences,
  kindLabel,
  SourceLine,
} from "@/chessin/notebook/ReviewSession";
import { currentLang } from "@/chessin/notebook/today";
import type { QueueBuild } from "./build";
import { formatCountdown } from "./estimate";
import { deadlineSuffix, sourceLabel, summaryLine } from "./format";
import { gradeQueueItem } from "./grade";
import { bumpNewGradedToday, recordItemDuration } from "./load";
import type { QueueItem, QueueSettings } from "./model";

/**
 * Runs a built queue: the same attempt → grade flow as the notebook's review
 * session (`FindMoveBoard` + `GradeButtons`), plus a minute countdown
 * (`settings.minutesCap`), "换一题" (the current item moves to the back of
 * the queue) and a stop at the cap with a summary
 * ("完成 23 项 · 12 分钟 · 明天还有 11 项"). Grading goes through
 * `gradeQueueItem` (notebook cards and legacy practice decks); each item's
 * duration feeds the learned estimate and new cards count against the daily cap.
 */

type Phase = "attempt" | "correct" | "revealed";

export type QueueSessionProps = {
  build: QueueBuild;
  settings: QueueSettings;
  onExit: () => void;
  onOpenSource: (card: NotebookCard) => void;
};

export default function QueueSession({ build, settings, onExit, onOpenSource }: QueueSessionProps) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<QueueItem[]>(() => build.items);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("attempt");
  const [showHint, setShowHint] = useState(false);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState({ done: 0, correct: 0 });
  const [finished, setFinished] = useState(() => build.items.length === 0);
  const [answeredAt, setAnsweredAt] = useState(() => Date.now());
  const [startedAt] = useState(() => Date.now());
  const [deadlineAt, setDeadlineAt] = useState(() => startedAt + settings.minutesCap * 60_000);
  const [tick, setTick] = useState(() => Date.now());
  // When the current item appeared (seeded from the session start; reset per item).
  const shownAt = useRef(startedAt);

  useEffect(() => {
    if (finished) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [finished]);

  const item: QueueItem | undefined = finished ? undefined : queue[index];
  const remainingSeconds = Math.ceil((deadlineAt - tick) / 1000);
  const timeUp = remainingSeconds <= 0;
  const left = queue.length - results.done;
  const remainingTomorrow = left + build.dropped + build.newCapped;

  function resetItem() {
    setPhase("attempt");
    setShowHint(false);
    setWrongAttempts(0);
    shownAt.current = Date.now();
  }

  function advance() {
    const next = index + 1;
    setIndex(next);
    resetItem();
    if (next >= queue.length || timeUp) setFinished(true);
  }

  /** 换一题: the current item goes to the back of the queue. */
  function swap() {
    if (!item || queue.length - index <= 1) return;
    setQueue((q) => [...q.slice(0, index), ...q.slice(index + 1), q[index]]);
    resetItem();
  }

  async function grade(rating: NotebookRating) {
    if (!item || busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      await gradeQueueItem(item, rating, now);
      const seconds = (now - shownAt.current) / 1000;
      recordItemDuration(item.source, seconds).catch(() => undefined);
      if (item.isNew) bumpNewGradedToday(now).catch(() => undefined);
      const correct = phase === "correct";
      setResults((r) => ({ done: r.done + 1, correct: r.correct + (correct ? 1 : 0) }));
      advance();
    } catch (e) {
      console.error("queue: grading failed", e);
      notifications.show({
        color: "red",
        message: t("Queue.Session.GradeFailed", { error: String(e) }),
      });
    } finally {
      setBusy(false);
    }
  }

  function onAttempt(_uci: string, correct: boolean) {
    if (phase !== "attempt") return;
    if (correct) {
      setAnsweredAt(Date.now());
      setPhase("correct");
    } else {
      setWrongAttempts((n) => n + 1);
    }
  }

  function continueSession() {
    setDeadlineAt(Date.now() + settings.minutesCap * 60_000);
    setTick(Date.now());
    shownAt.current = Date.now();
    setFinished(false);
  }

  const canGrade = phase === "correct" && !busy && !!item;
  useHotkeys("1", () => void grade(1), { enabled: canGrade }, [canGrade, item]);
  useHotkeys("2", () => void grade(2), { enabled: canGrade }, [canGrade, item]);
  useHotkeys("3", () => void grade(3), { enabled: canGrade }, [canGrade, item]);
  useHotkeys("4", () => void grade(4), { enabled: canGrade }, [canGrade, item]);
  useHotkeys("space", () => void grade(1), { enabled: phase === "revealed" && !busy && !!item }, [
    phase,
    busy,
    item,
  ]);

  if (!item) {
    const minutes = results.done > 0 ? Math.max(1, Math.round((tick - startedAt) / 60_000)) : 0;
    return (
      <Stack align="center" justify="center" h="100%" gap="sm" p="md">
        <ThemeIcon size="xl" radius="xl" color="green" variant="light">
          <IconCheck size={24} />
        </ThemeIcon>
        <Text fw={600}>
          {build.items.length === 0 ? t("Queue.Session.Empty") : t("Queue.Session.SummaryTitle")}
        </Text>
        {build.items.length > 0 && (
          <Text fz="sm" data-testid="queue-summary">
            {summaryLine(results.done, minutes, remainingTomorrow, t)}
          </Text>
        )}
        {results.done > 0 && (
          <Text c="dimmed" fz="sm">
            {t("Notebook.Session.DoneSummary", { count: results.done, correct: results.correct })}
          </Text>
        )}
        {build.catchUp && build.dropped > 0 && (
          <Text c="dimmed" fz="sm">
            {t("Queue.Session.CatchUp", { count: build.dropped })}
          </Text>
        )}
        <Group gap="xs">
          {index < queue.length && (
            <Button variant="light" onClick={continueSession}>
              {t("Queue.Session.Continue", { minutes: settings.minutesCap })}
            </Button>
          )}
          <Button variant={index < queue.length ? "subtle" : "light"} onClick={onExit}>
            {t("Notebook.Back")}
          </Button>
        </Group>
      </Stack>
    );
  }

  const card = item.payload.card;
  const fen = item.payload.fen ?? fenFromEpd(item.payload.epd);
  const color = item.payload.orientation;
  const answerSan =
    item.payload.san ??
    sanFromUci(fen, item.payload.answers[0] ?? "") ??
    item.payload.answers[0] ??
    "?";
  const explanations = phase === "attempt" ? [] : explanationSentences(card, t);
  const lang = currentLang();
  const deadline = deadlineSuffix(item.deadline, tick, t, lang).trim();

  return (
    <ScrollArea h="100%">
      <Stack p="md" gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="wrap">
            <Text size="sm" c="dimmed">
              {t("Queue.Session.Progress", { current: results.done + 1, total: queue.length })}
            </Text>
            <Badge size="sm" variant="light">
              {sourceLabel(item.source, t, { opponent: item.payload.opponent })}
            </Badge>
            {item.kind !== "find_move" && item.kind !== "repertoire" && (
              <Badge size="sm" variant="outline" color="gray">
                {kindLabel(item.kind, t)}
              </Badge>
            )}
            {item.extraPass && (
              <Badge size="sm" variant="light" color="orange">
                {t("Queue.Session.ExtraPass")}
              </Badge>
            )}
            {deadline && (
              <Badge size="sm" variant="light" color="grape">
                {deadline}
              </Badge>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Tooltip
              label={t("Queue.Session.TimeLeft", { time: formatCountdown(remainingSeconds) })}
            >
              <Group gap={4} wrap="nowrap" data-testid="queue-countdown">
                <IconClock size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
                <Text size="sm" c={timeUp ? "red" : remainingSeconds < 60 ? "orange" : "dimmed"}>
                  {formatCountdown(remainingSeconds)}
                </Text>
              </Group>
            </Tooltip>
            <Button
              variant="subtle"
              size="compact-xs"
              color="red"
              onClick={() => setFinished(true)}
            >
              {t("Queue.Session.Stop")}
            </Button>
          </Group>
        </Group>

        {timeUp && (
          <Text size="sm" c="orange">
            {t("Queue.Session.TimeUp")}
          </Text>
        )}

        <SourceLine card={card} onOpen={card.source ? onOpenSource : undefined} />

        <Group align="flex-start" gap="md" wrap="wrap">
          <FindMoveBoard
            fen={fen}
            orientation={color}
            answers={item.payload.answers}
            onAttempt={onAttempt}
            showHint={showHint}
            disabled={phase !== "attempt"}
            reveal={phase === "revealed"}
            size="min(100%, 420px)"
          />
          <Stack gap="sm" style={{ flex: 1, minWidth: 220 }}>
            {phase === "attempt" && (
              <Paper p="sm" withBorder>
                <Stack gap="xs">
                  <Text fw={500}>
                    {t("Notebook.Session.Prompt", { color: colorLabel(color, t) })}
                  </Text>
                  {wrongAttempts > 0 && (
                    <Text c="red" fz="sm">
                      {t("Notebook.Session.Incorrect")}
                    </Text>
                  )}
                  <Group gap="xs">
                    <Button
                      variant="light"
                      size="xs"
                      disabled={showHint}
                      onClick={() => setShowHint(true)}
                    >
                      {t("Notebook.Session.Hint")}
                    </Button>
                    <Button
                      variant="light"
                      size="xs"
                      color="orange"
                      onClick={() => setPhase("revealed")}
                    >
                      {t("Notebook.Session.Reveal")}
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      disabled={queue.length - index <= 1}
                      onClick={swap}
                    >
                      {t("Queue.Session.Swap")}
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            )}

            {phase === "correct" && (
              <>
                <Group gap="xs">
                  <ThemeIcon size="md" color="green" variant="light" radius="xl">
                    <IconCheck size={16} />
                  </ThemeIcon>
                  <Text fw={500} c="green">
                    {t("Notebook.Session.Correct")}
                  </Text>
                  <Text fz="sm" c="dimmed">
                    {answerSan}
                  </Text>
                </Group>
                {item.payload.playedSan && (
                  <Text fz="sm" c="dimmed">
                    {t("Notebook.Session.YouPlayed", { move: item.payload.playedSan })}
                  </Text>
                )}
                <GradeButtons
                  card={card.fsrs}
                  now={answeredAt}
                  onRate={(rating) => void grade(rating)}
                  disabled={busy}
                  prompt={t("Notebook.Session.HowDifficult")}
                />
              </>
            )}

            {phase === "revealed" && (
              <Paper p="sm" withBorder>
                <Stack gap="xs">
                  <Text fw={500} c="orange">
                    {t("Notebook.Session.AnswerWas", { move: answerSan })}
                  </Text>
                  {item.payload.playedSan && (
                    <Text fz="sm" c="dimmed">
                      {t("Notebook.Session.YouPlayed", { move: item.payload.playedSan })}
                    </Text>
                  )}
                  <Button variant="light" size="sm" loading={busy} onClick={() => void grade(1)}>
                    {t("Notebook.Session.Next")}
                  </Button>
                </Stack>
              </Paper>
            )}

            {explanations.length > 0 && (
              <Paper p="sm" withBorder>
                <Stack gap={4}>
                  <Text fz="xs" fw={600} c="dimmed" tt="uppercase">
                    {t("Notebook.Explanation.Title")}
                  </Text>
                  {explanations.map((sentence) => (
                    <Text key={sentence} fz="sm">
                      {sentence}
                    </Text>
                  ))}
                </Stack>
              </Paper>
            )}
          </Stack>
        </Group>
      </Stack>
    </ScrollArea>
  );
}
