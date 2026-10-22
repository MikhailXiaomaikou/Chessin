import { Badge, Button, Card, Group, ScrollArea, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconEye, IconPlayerPlay, IconRefresh, IconX } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import FindMoveBoard from "@/chessin/board/FindMoveBoard";
import { type Explanation, ExplanationCard, explainMoment } from "@/chessin/explain";
import { typingGuardOptions } from "@/chessin/keymap/guard";
import ShortcutKbd from "@/chessin/keymap/ShortcutKbd";
import { applyLineAsVariation } from "@/chessin/review/applyLine";
import { startReviewForActiveTab } from "@/chessin/review/commands";
import { lineToSan, moveLabel } from "@/chessin/review/format";
import { gameKeyForOrigin, type Review } from "@/chessin/review/model";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { currentTabAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { guessSessionFamily, setGuessSession } from "./atoms";
import { advanceGuess, guessSummaryText, revealGuess, startGuess, stopGuess } from "./commands";
import { gradeLabelKey, type GuessGrade } from "./scoring";
import {
  answerGuess,
  currentStep,
  currentTarget,
  type GuessSession,
  type GuessTarget,
  guessTotals,
  isFinished,
} from "./session";

/**
 * Guess-the-move inside the 讲解 dock tab (S4-6). Mounted by `ReviewPanel`
 * while `guessSessionFamily(tabId)` holds a session: one `FindMoveBoard`
 * per target ply from the player's side, the grade after each guess, "揭晓"
 * with the played / best moves and the explanation card, and the summary
 * ("27/40 着 · 68 分") at the end. `R` (keymap `REVEAL`) reveals or steps on.
 */

const GRADE_COLOR: Record<GuessGrade, string> = {
  3: "teal",
  2: "blue",
  1: "orange",
  0: "red",
};

export default function GuessPanel({ tabId, review }: { tabId: string; review: Review | null }) {
  const { t } = useTranslation();
  const session = useAtomValue(guessSessionFamily(tabId));
  const store = useContext(TreeStateContext)!;
  const keyMap = useAtomValue(keyMapAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const gameKey = gameKeyForOrigin(currentTab?.gameOrigin);

  const target = session ? currentTarget(session) : null;
  const step = session ? currentStep(session) : null;

  // Follow the session on the main board: the position before the move while
  // guessing, the played move once revealed.
  useEffect(() => {
    if (!target) return;
    store.getState().goToMove(step ? target.path : target.parentPath);
  }, [store, target, step]);

  useHotkeys(
    keyMap.REVEAL.keys,
    (e) => {
      e.preventDefault();
      revealGuess(tabId);
    },
    { ...typingGuardOptions },
    [tabId],
  );

  if (!session) return null;

  const restart = () =>
    void startGuess(tabId, store, gameKey, {
      review,
      from: session.from,
      playerColor: session.playerColor,
    });

  const totals = guessTotals(session);
  const colorLabel =
    session.playerColor === "white" ? t("Review.Color.White") : t("Review.Color.Black");

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack p="sm" gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={600}>{t("Guess.Title")}</Text>
            <Badge size="sm" variant="light">
              {t("Guess.Progress", {
                current: Math.min(session.index + 1, totals.total),
                total: totals.total,
              })}
            </Badge>
            <Badge size="sm" variant="outline" color="gray">
              {t("Guess.Points", { points: totals.points })}
            </Badge>
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            leftSection={<IconX size="0.8rem" />}
            onClick={() => stopGuess(tabId)}
          >
            {t("Guess.Stop")}
          </Button>
        </Group>

        {!session.hasReview && (
          <Card withBorder padding="xs">
            <Stack gap="xs">
              <Text size="sm" c="yellow">
                {t("Guess.NoReview")}
              </Text>
              <Group gap="xs">
                {review ? (
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconRefresh size="0.8rem" />}
                    onClick={restart}
                  >
                    {t("Guess.RestartWithReview")}
                  </Button>
                ) : (
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlayerPlay size="0.8rem" />}
                    onClick={() => void startReviewForActiveTab("full", session.playerColor)}
                  >
                    {t("Guess.StartReview")}
                  </Button>
                )}
              </Group>
            </Stack>
          </Card>
        )}

        {isFinished(session) || !target ? (
          <Summary
            session={session}
            onRestart={restart}
            onClose={() => setGuessSession(tabId, null)}
          />
        ) : (
          <>
            <Text size="sm" c="dimmed">
              {t("Guess.Prompt", { color: colorLabel, move: Math.ceil(target.ply / 2) })}
            </Text>
            <FindMoveBoard
              fen={target.fenBefore}
              orientation={session.playerColor}
              answers={target.answers}
              onAttempt={(uci) => setGuessSession(tabId, answerGuess(session, uci))}
              disabled={step !== null}
              reveal={step !== null}
              size="min(100%, 320px)"
            />
            {step === null ? (
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconEye size="0.8rem" />}
                  onClick={() => revealGuess(tabId)}
                >
                  {t("Guess.Reveal")}
                </Button>
                <ShortcutKbd keys={keyMap.REVEAL.keys} />
              </Group>
            ) : (
              <Reveal
                session={session}
                target={target}
                grade={step.grade}
                guess={step.guess}
                onNext={() => advanceGuess(tabId)}
                revealKeys={keyMap.REVEAL.keys}
              />
            )}
          </>
        )}
      </Stack>
    </ScrollArea>
  );
}

function Reveal({
  session,
  target,
  grade,
  guess,
  onNext,
  revealKeys,
}: {
  session: GuessSession;
  target: GuessTarget;
  grade: GuessGrade;
  guess: string | null;
  onNext: () => void;
  revealKeys: string;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;

  const explanations = useMemo<Explanation[]>(() => {
    if (target.explanations.length > 0) return target.explanations;
    if (!target.bestUci || !target.scores || target.bestUci === target.playedUci) return [];
    try {
      return explainMoment({
        fenBefore: target.fenBefore,
        playedUci: target.playedUci,
        bestUci: target.bestUci,
        bestPv: target.bestPv,
        scoreBefore: target.scores.afterBest,
        scoreAfterPlayed: target.scores.afterPlayed,
        scoreAfterBest: target.scores.afterBest,
        playerColor: target.color,
        scoreView: "white",
      });
    } catch {
      return [];
    }
  }, [target]);

  const guessSan =
    guess && guess !== target.playedUci && guess !== target.bestUci
      ? lineToSan(target.fenBefore, [guess], 1)
      : null;
  const bestLine = target.bestPv.length > 0 ? lineToSan(target.fenBefore, target.bestPv) : null;
  const totals = guessTotals(session);

  const demo = (fen: string, line: string[]) => {
    applyLineAsVariation(
      store,
      {
        ply: target.ply,
        fenBefore: fen,
        nodeId: fen === target.fenBefore ? target.nodeId : undefined,
      },
      line,
    );
  };

  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Badge size="sm" color={GRADE_COLOR[grade]} variant="light">
          {t(gradeLabelKey(grade))}
        </Badge>
        <Text size="xs" c="dimmed">
          {t("Guess.Running", { points: totals.points, max: totals.maxSoFar })}
        </Text>
      </Group>
      <Text size="sm">
        <Text span c="dimmed">
          {t("Review.Played")}：
        </Text>
        {moveLabel(target.ply, target.playedSan)}
        {target.bestSan && (
          <>
            {"　"}
            <Text span c="dimmed">
              {t("Review.Best")}：
            </Text>
            <Text span fw={600}>
              {target.bestSan}
            </Text>
          </>
        )}
        {guessSan && (
          <>
            {"　"}
            <Text span c="dimmed">
              {t("Guess.YourGuess")}：
            </Text>
            {guessSan}
          </>
        )}
      </Text>
      {bestLine && (
        <Text size="sm">
          <Text span c="dimmed">
            {t("Review.BestLine")}：
          </Text>
          {bestLine}
        </Text>
      )}
      {explanations.map((e, i) => (
        <ExplanationCard
          key={`${e.id}-${i}`}
          explanation={e}
          compact
          onDemo={(d) => demo(d.fen, d.line)}
        />
      ))}
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconPlayerPlay size="0.8rem" />}
          onClick={onNext}
        >
          {session.index + 1 >= totals.total ? t("Guess.Finish") : t("Guess.Next")}
        </Button>
        <ShortcutKbd keys={revealKeys} />
      </Group>
    </Stack>
  );
}

function Summary({
  session,
  onRestart,
  onClose,
}: {
  session: GuessSession;
  onRestart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Stack gap="xs" align="center">
        <ThemeIcon size="xl" radius="xl" color="green" variant="light">
          <IconCheck size={24} />
        </ThemeIcon>
        <Text fw={600}>{t("Guess.Done")}</Text>
        <Text size="sm">{guessSummaryText(session)}</Text>
        {session.gameKey && session.steps.length > 0 && (
          <Text size="xs" c="dimmed">
            {t("Guess.Saved")}
          </Text>
        )}
        <Group gap="xs">
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<IconRefresh size="0.8rem" />}
            onClick={onRestart}
          >
            {t("Guess.Again")}
          </Button>
          <Button size="compact-sm" variant="subtle" color="gray" onClick={onClose}>
            {t("Guess.Close")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
