import {
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import FindMoveBoard from "@/chessin/board/FindMoveBoard";
import { type Explanation, renderExplanation } from "@/chessin/explain";
import GradeButtons from "./GradeButtons";
import { gradeCard, type NotebookCard, type NotebookRating } from "./cards";
import { fenFromEpd, sanFromUci, sideToMove } from "./chess";
import { gameKeyLabel } from "./source";
import { currentLang } from "./today";

/**
 * One review session over the due cards: the position on a `FindMoveBoard`,
 * the player tries the move, then grades the card (正确 → 重来/困难/良好/简单;
 * 揭晓 or a skip after wrong attempts → 重来). The source line opens the game.
 */

type Phase = "attempt" | "correct" | "revealed";

export function kindLabel(kind: string, t: TFunction): string {
  const key = `Notebook.Kind.${kind}`;
  const label = t(key);
  return label === key ? kind : label;
}

export function colorLabel(color: "white" | "black", t: TFunction): string {
  return color === "white" ? t("Notebook.Color.White") : t("Notebook.Color.Black");
}

function isExplanation(value: unknown): value is Explanation {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<Explanation>;
  return typeof e.id === "string" && typeof e.evidence === "string" && !!e.params;
}

/** Rendered S2-4 explanations stored on the card (empty when none render). */
export function explanationSentences(card: NotebookCard, t: TFunction): string[] {
  const list = Array.isArray(card.meta.explanations) ? card.meta.explanations : [];
  const lang = currentLang();
  const out: string[] = [];
  for (const item of list) {
    if (!isExplanation(item)) continue;
    try {
      const text = renderExplanation(item, t, lang);
      if (text && text.trim() && text !== `Explain.${item.id}`) out.push(text);
    } catch {
      // A detector this build does not know: skip it.
    }
  }
  return out;
}

export function SourceLine({
  card,
  onOpen,
}: {
  card: NotebookCard;
  onOpen?: (card: NotebookCard) => void;
}) {
  const { t } = useTranslation();
  if (!card.source) return null;
  const color = card.meta.playerColor ?? sideToMove(card.epd);
  const text = t("Notebook.Source", {
    title: card.meta.title ?? gameKeyLabel(card.source.gameKey),
    move: Math.ceil(card.source.ply / 2),
    color: colorLabel(color, t),
  });
  if (!onOpen) {
    return (
      <Text size="sm" c="dimmed">
        {text}
      </Text>
    );
  }
  return (
    <UnstyledButton onClick={() => onOpen(card)} title={t("Notebook.Source.Open")}>
      <Group gap={4} wrap="nowrap">
        <Text size="sm" c="dimmed">
          {text}
        </Text>
        <IconExternalLink size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
      </Group>
    </UnstyledButton>
  );
}

export default function ReviewSession({
  cards,
  onExit,
  onOpenSource,
}: {
  cards: NotebookCard[];
  onExit: () => void;
  onOpenSource: (card: NotebookCard) => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("attempt");
  const [showHint, setShowHint] = useState(false);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [results, setResults] = useState({ reviewed: 0, correct: 0 });
  const [busy, setBusy] = useState(false);
  // Captured when the answer is found so the next-due preview is stable across renders.
  const [answeredAt, setAnsweredAt] = useState(() => Date.now());

  const card: NotebookCard | undefined = cards[index];

  function advance() {
    setIndex((i) => i + 1);
    setPhase("attempt");
    setShowHint(false);
    setWrongAttempts(0);
  }

  async function grade(rating: NotebookRating) {
    if (!card || busy) return;
    setBusy(true);
    try {
      await gradeCard(card.id, rating, Date.now());
      const correct = phase === "correct";
      setResults((r) => ({ reviewed: r.reviewed + 1, correct: r.correct + (correct ? 1 : 0) }));
      advance();
    } catch (e) {
      console.error("notebook: grading failed", e);
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

  useHotkeys("1", () => void grade(1), { enabled: phase === "correct" && !busy }, [
    phase,
    busy,
    card,
  ]);
  useHotkeys("2", () => void grade(2), { enabled: phase === "correct" && !busy }, [
    phase,
    busy,
    card,
  ]);
  useHotkeys("3", () => void grade(3), { enabled: phase === "correct" && !busy }, [
    phase,
    busy,
    card,
  ]);
  useHotkeys("4", () => void grade(4), { enabled: phase === "correct" && !busy }, [
    phase,
    busy,
    card,
  ]);
  useHotkeys("space", () => void grade(1), { enabled: phase === "revealed" && !busy }, [
    phase,
    busy,
    card,
  ]);

  if (!card) {
    return (
      <Stack align="center" justify="center" h="100%" gap="sm" p="md">
        <ThemeIcon size="xl" radius="xl" color="green" variant="light">
          <IconCheck size={24} />
        </ThemeIcon>
        <Text fw={600}>{t("Notebook.Session.Done")}</Text>
        <Text c="dimmed" fz="sm">
          {t("Notebook.Session.DoneSummary", { count: results.reviewed, correct: results.correct })}
        </Text>
        <Button variant="light" onClick={onExit}>
          {t("Notebook.Back")}
        </Button>
      </Stack>
    );
  }

  const fen = fenFromEpd(card.epd);
  const color = card.meta.playerColor ?? sideToMove(card.epd);
  const answerSan =
    card.meta.san ?? sanFromUci(fen, card.answers[0] ?? "") ?? card.answers[0] ?? "?";
  const explanations = phase === "attempt" ? [] : explanationSentences(card, t);

  return (
    <ScrollArea h="100%">
      <Stack p="md" gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              {t("Notebook.Session.Progress", { current: index + 1, total: cards.length })}
            </Text>
            <Badge size="sm" variant="light">
              {kindLabel(card.kind, t)}
            </Badge>
          </Group>
          <Button variant="subtle" size="compact-xs" color="red" onClick={onExit}>
            {t("Notebook.Session.Stop")}
          </Button>
        </Group>

        <SourceLine card={card} onOpen={onOpenSource} />

        <Group align="flex-start" gap="md" wrap="wrap">
          <FindMoveBoard
            fen={fen}
            orientation={color}
            answers={card.answers}
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
                    <Button variant="subtle" size="xs" onClick={advance}>
                      {t("Notebook.Session.Skip")}
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
                {card.meta.playedSan && (
                  <Text fz="sm" c="dimmed">
                    {t("Notebook.Session.YouPlayed", { move: card.meta.playedSan })}
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
                  {card.meta.playedSan && (
                    <Text fz="sm" c="dimmed">
                      {t("Notebook.Session.YouPlayed", { move: card.meta.playedSan })}
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
