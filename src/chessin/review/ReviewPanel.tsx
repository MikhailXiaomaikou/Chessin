import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconBulb,
  IconClock,
  IconEye,
  IconNotebook,
  IconPlayerPlay,
  IconRefresh,
  IconX,
  IconZoomCheck,
} from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AnnotateFirstPanel, annotateFirstFamily } from "@/chessin/annotateFirst";
import FindMoveBoard from "@/chessin/board/FindMoveBoard";
import DeviationCards from "@/chessin/deviation/DeviationCards";
import { ExplanationCard, summarizeGame } from "@/chessin/explain";
import { GuessPanel, guessSessionFamily, ReviewModeButtons } from "@/chessin/guess";
import { cancelJob, type Job, jobsAtom, retryJob } from "@/chessin/jobs/queue";
import { accountPlayerNames } from "@/chessin/sync/myGames";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { currentTabAtom, enginesAtom } from "@/state/atoms";
import { applyLineAsVariation, goToMoment } from "./applyLine";
import { registerReviewCommands, startReviewForActiveTab } from "./commands";
import { onReviewSaved } from "./events";
import { formatClock, lineToSan, moveLabel, percent } from "./format";
import { registerReviewJobHandler } from "./jobHandler";
import {
  expectedScore,
  gameKeyForOrigin,
  type KeyMoment,
  type PlayerColor,
  type Review,
  type ReviewPreset,
} from "./model";
import { addReviewToNotebook } from "./notebookBridge";
import { pickReviewEngine, type ReviewJobPayload } from "./reviewGame";
import { getCachedReview, selectedMomentFamily, setCachedReview } from "./selection";
import { getReview } from "./store";

registerReviewCommands();
registerReviewJobHandler();

/** Alternatives within this expected-score distance of the best move also count as correct. */
const ANSWER_TOLERANCE = 0.05;

type ColorChoice = PlayerColor | "both";

const KIND_COLOR: Record<KeyMoment["kind"], string> = {
  blunder: "red",
  missed_win: "red",
  missed_draw: "orange",
  mistake: "orange",
  time_pressure: "yellow",
  only_move: "teal",
};

function isActiveJob(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

function jobGameKey(job: Job): string | null {
  const payload = job.payload as Partial<ReviewJobPayload> | null | undefined;
  return payload && typeof payload.gameKey === "string" ? payload.gameKey : null;
}

export function answersFor(moment: KeyMoment, tolerance = ANSWER_TOLERANCE): string[] {
  const out = [moment.bestUci];
  const best = expectedScore(
    moment.alternatives.find((a) => a.uci === moment.bestUci)?.score ?? Number.NaN,
    moment.color,
  );
  for (const alt of moment.alternatives) {
    if (alt.uci === moment.bestUci || out.includes(alt.uci)) continue;
    if (Number.isNaN(best)) continue;
    if (best - expectedScore(alt.score, moment.color) <= tolerance) out.push(alt.uci);
  }
  return out;
}

function inferPlayerColor(white: string, black: string): ColorChoice {
  const names = accountPlayerNames().map((n) => n.toLowerCase());
  if (names.length === 0) return "both";
  if (names.includes(white.toLowerCase())) return "white";
  if (names.includes(black.toLowerCase())) return "black";
  return "both";
}

export default function ReviewPanel() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const headers = useStore(store, (s) => s.headers);
  const currentTab = useAtomValue(currentTabAtom);
  const tabId = currentTab?.value ?? "";
  const gameKey = gameKeyForOrigin(currentTab?.gameOrigin);
  const engines = useAtomValue(enginesAtom);
  const hasEngine = pickReviewEngine(engines ?? []) !== null;
  // Chessin S4-6: 猜着 / 先自己注释 take over the tab while active (state per tab).
  const guessSession = useAtomValue(guessSessionFamily(tabId));
  const annotateFirst = useAtomValue(annotateFirstFamily(tabId));

  const jobs = useAtomValue(jobsAtom);
  const job = useMemo(() => {
    const mine = jobs.filter((j) => j.kind === "review" && jobGameKey(j) === gameKey);
    return mine.find(isActiveJob) ?? mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [jobs, gameKey]);

  const [loadedReview, setLoadedReview] = useState<Review | null>(null);
  const review =
    loadedReview && loadedReview.gameKey === gameKey
      ? loadedReview
      : (getCachedReview(gameKey) ?? null);

  useEffect(() => {
    if (!gameKey) return;
    let cancelled = false;
    getReview(gameKey).then((r) => {
      if (cancelled) return;
      if (r) setCachedReview(r);
      setLoadedReview(r);
    });
    const off = onReviewSaved((r) => {
      if (r.gameKey === gameKey) setLoadedReview(r);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [gameKey]);

  const [colorChoice, setColorChoice] = useState<ColorChoice | null>(null);
  const color = colorChoice ?? inferPlayerColor(headers.white, headers.black);

  const start = (preset: ReviewPreset) =>
    startReviewForActiveTab(preset, color === "both" ? null : color);

  if (!currentTab) return null;
  if (guessSession) return <GuessPanel tabId={tabId} review={review} />;
  if (annotateFirst) return <AnnotateFirstPanel tabId={tabId} review={review} />;

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack p="sm" gap="sm">
        {!gameKey && (
          <Text size="sm" c="dimmed">
            {t("Review.NoOrigin")}
          </Text>
        )}
        {gameKey && job && isActiveJob(job) && <JobProgress job={job} />}
        {gameKey && job && job.status === "failed" && !review && <JobFailed job={job} />}
        {gameKey && !review && !(job && isActiveJob(job)) && (
          <Card withBorder>
            <Stack gap="xs">
              <Text fw={600}>{t("Review.NotReviewed")}</Text>
              <Text size="sm" c="dimmed">
                {t("Review.NotReviewed.Desc")}
              </Text>
              <ColorPicker value={color} onChange={setColorChoice} />
              {!hasEngine && (
                <Text size="sm" c="red">
                  {t("Review.NoEngine")}
                </Text>
              )}
              <Group>
                <Button
                  leftSection={<IconPlayerPlay size="1rem" />}
                  disabled={!hasEngine}
                  onClick={() => void start("full")}
                >
                  {t("Review.Start")}
                </Button>
                <Tooltip label={t("Review.BlunderCheck.Desc")}>
                  <Button
                    variant="light"
                    leftSection={<IconZoomCheck size="1rem" />}
                    disabled={!hasEngine}
                    onClick={() => void start("blunder_check")}
                  >
                    {t("Review.BlunderCheck")}
                  </Button>
                </Tooltip>
              </Group>
              <ReviewModeButtons tabId={tabId} review={null} />
            </Stack>
          </Card>
        )}
        {gameKey && review && (
          <ReviewView
            review={review}
            tabId={tabId}
            hasEngine={hasEngine}
            busy={!!job && isActiveJob(job)}
            onRerun={start}
            color={color}
            onColorChange={setColorChoice}
          />
        )}
      </Stack>
    </ScrollArea>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: ColorChoice;
  onChange: (value: ColorChoice) => void;
}) {
  const { t } = useTranslation();
  return (
    <Group gap="xs">
      <Text size="sm">{t("Review.Color")}</Text>
      <SegmentedControl
        size="xs"
        value={value}
        onChange={(v) => onChange(v as ColorChoice)}
        data={[
          { value: "white", label: t("Review.Color.White") },
          { value: "black", label: t("Review.Color.Black") },
          { value: "both", label: t("Review.Color.Both") },
        ]}
      />
    </Group>
  );
}

function JobProgress({ job }: { job: Job }) {
  const { t } = useTranslation();
  const pct = Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between">
          <Text size="sm">
            {job.status === "queued"
              ? t("Review.Queued")
              : t("Review.InProgress", { progress: pct })}
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconX size="0.8rem" />}
            onClick={() => void cancelJob(job.id)}
          >
            {t("Review.Cancel")}
          </Button>
        </Group>
        <Progress value={pct} animated={job.status === "running"} />
      </Stack>
    </Card>
  );
}

function JobFailed({ job }: { job: Job }) {
  const { t } = useTranslation();
  const error = job.error ? t(job.error, { defaultValue: job.error }) : "";
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Text size="sm" c="red">
          {t("Review.Failed", { error })}
        </Text>
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconRefresh size="0.8rem" />}
          onClick={() => void retryJob(job.id)}
        >
          {t("Review.Retry")}
        </Button>
      </Group>
    </Card>
  );
}

function ReviewView({
  review,
  tabId,
  hasEngine,
  busy,
  onRerun,
  color,
  onColorChange,
}: {
  review: Review;
  tabId: string;
  hasEngine: boolean;
  busy: boolean;
  onRerun: (preset: ReviewPreset) => void;
  color: ColorChoice;
  onColorChange: (value: ColorChoice) => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const [selected, setSelected] = useAtom(selectedMomentFamily(tabId));
  const moments = review.moments;
  const selectedIndex = moments.length === 0 ? -1 : Math.min(selected, moments.length - 1);
  const { summary, phases } = review;

  const sentences = useMemo(() => {
    const colors: PlayerColor[] = review.playerColor ? [review.playerColor] : ["white", "black"];
    const out: { color: PlayerColor; text: string }[] = [];
    for (const c of colors) {
      try {
        for (const text of summarizeGame(review.plies, { playerColor: c, t })) {
          if (text) out.push({ color: c, text });
        }
      } catch {
        // S2-4 in flight: no sentences.
      }
    }
    return out;
  }, [review, t]);

  const addToNotebook = async () => {
    const result = await addReviewToNotebook(review);
    if (!result) {
      notifications.show({ color: "yellow", message: t("Review.AddToNotebook.Unavailable") });
      return;
    }
    notifications.show({
      message: t("Review.AddToNotebook.Done", { count: result.added + result.updated }),
    });
  };

  return (
    <>
      <Card withBorder>
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text fw={600}>{t("Review.Tab")}</Text>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconRefresh size="0.8rem" />}
                disabled={!hasEngine || busy}
                onClick={() => onRerun("full")}
              >
                {t("Review.Rerun")}
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={!hasEngine || busy}
                onClick={() => onRerun("blunder_check")}
              >
                {t("Review.BlunderCheck")}
              </Button>
            </Group>
          </Group>
          {/* Chessin S4-3: event badge + 我偏离了 / 对手偏离了 cards (before the summary strip). */}
          <DeviationCards gameKey={review.gameKey} />
          <SimpleGrid cols={2} spacing="xs">
            <Stat
              label={t("Review.Summary.Accuracy")}
              value={`${t("Common.WHITE")} ${summary.accuracy.white.toFixed(0)}% · ${t("Common.BLACK")} ${summary.accuracy.black.toFixed(0)}%`}
            />
            <Stat
              label={t("Review.Summary.CPL")}
              value={`${t("Common.WHITE")} ${summary.cpl.white.toFixed(0)} · ${t("Common.BLACK")} ${summary.cpl.black.toFixed(0)}`}
            />
            <Stat
              label={t("Review.Summary.Phases")}
              value={`${t("Review.Phase.Opening")} ${phases.opening.loss.toFixed(1)} · ${t("Review.Phase.Middlegame")} ${phases.middlegame.loss.toFixed(1)} · ${t("Review.Phase.Endgame")} ${phases.endgame.loss.toFixed(1)}`}
            />
            <Stat
              label={t("Review.Summary.TimePressure")}
              value={String(summary.timePressureMoves.length)}
            />
          </SimpleGrid>
          <Text size="sm">
            {t("Review.Summary.Counts", {
              blunders: summary.blunders,
              mistakes: summary.mistakes,
              inaccuracies: summary.inaccuracies,
            })}
          </Text>
          {sentences.map((s, i) => (
            <Text key={`${s.color}-${i}`} size="sm" c="dimmed">
              {review.playerColor
                ? s.text
                : `${s.color === "white" ? t("Common.WHITE") : t("Common.BLACK")}：${s.text}`}
            </Text>
          ))}
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t("Review.Summary.Engine", { engine: review.engine, depth: review.depth })}
              {" · "}
              {t("Review.ReviewedAt", { date: new Date(review.createdAt).toLocaleString() })}
            </Text>
            <ColorPicker value={color} onChange={onColorChange} />
          </Group>
          <ReviewModeButtons tabId={tabId} review={review} />
        </Stack>
      </Card>

      <Group justify="space-between">
        <Text fw={600}>{t("Review.Moments")}</Text>
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconNotebook size="0.8rem" />}
          disabled={moments.length === 0}
          onClick={() => void addToNotebook()}
        >
          {t("Review.AddToNotebook")}
        </Button>
      </Group>
      {moments.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("Review.Moments.Empty")}
        </Text>
      )}
      {review.preset === "blunder_check" && (
        <Text size="xs" c="dimmed">
          {t("Review.Moments.BlunderCheckOnly")}
        </Text>
      )}
      {moments.map((moment, index) => (
        <MomentCard
          key={moment.id}
          moment={moment}
          review={review}
          selected={index === selectedIndex}
          onSelect={() => {
            setSelected(index);
            goToMoment(store, moment);
          }}
        />
      ))}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {value}
      </Text>
    </Box>
  );
}

type MomentUiState = {
  id: string;
  attempt: { uci: string; correct: boolean } | null;
  revealed: boolean;
  hint: boolean;
};

function MomentCard({
  moment,
  review,
  selected,
  onSelect,
}: {
  moment: KeyMoment;
  review: Review;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const [ui, setUi] = useState<MomentUiState | null>(null);
  const state: MomentUiState =
    ui && ui.id === moment.id ? ui : { id: moment.id, attempt: null, revealed: false, hint: false };
  const update = (patch: Partial<MomentUiState>) => setUi({ ...state, ...patch });

  const answers = useMemo(() => answersFor(moment), [moment]);
  const solved = state.revealed || state.attempt !== null;
  const bestLine = useMemo(
    () => lineToSan(moment.fenBefore, moment.bestPv.length > 0 ? moment.bestPv : [moment.bestUci]),
    [moment],
  );

  const demo = (fen: string, line: string[]) => {
    const result = applyLineAsVariation(
      store,
      {
        ply: moment.ply,
        fenBefore: fen,
        nodeId: fen === moment.fenBefore ? moment.nodeId : undefined,
      },
      line,
    );
    notifications.show({
      id: "chessin-review-demo",
      color: result ? undefined : "yellow",
      message: result ? t("Review.ShowOnBoard.Done") : t("Review.ShowOnBoard.Failed"),
      autoClose: 2500,
    });
  };

  const playedLabel = moveLabel(moment.ply, moment.playedSan);
  // t("Review.Kind.blunder") t("Review.Kind.mistake") t("Review.Kind.missed_win")
  // t("Review.Kind.missed_draw") t("Review.Kind.only_move") t("Review.Kind.time_pressure")
  const kindLabel = t(`Review.Kind.${moment.kind}`);
  const underPressure = review.summary.timePressureMoves.includes(moment.ply);

  return (
    <Card
      withBorder
      padding="sm"
      style={{
        cursor: "pointer",
        borderColor: selected ? "var(--mantine-primary-color-filled)" : undefined,
      }}
      onClick={() => {
        if (!selected) onSelect();
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={600}>{playedLabel}</Text>
            <Badge size="sm" color={KIND_COLOR[moment.kind]} variant="light">
              {kindLabel}
            </Badge>
            <Badge size="sm" variant="outline" color="gray">
              {t(`Review.Phase.${moment.phase[0].toUpperCase()}${moment.phase.slice(1)}`)}
            </Badge>
            {underPressure && moment.clock !== undefined && (
              <Tooltip label={t("Review.Clock", { time: formatClock(moment.clock) })}>
                <IconClock size="1rem" color="var(--mantine-color-yellow-6)" />
              </Tooltip>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {moment.kind !== "only_move" && (
              <Text size="xs" c="red">
                {t("Review.Drop", { percent: percent(moment.drop) })}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {t("Review.Findability", { percent: percent(moment.findability) })}
            </Text>
          </Group>
        </Group>

        {selected && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              {t("Review.TryFirst")}
              {" — "}
              {t("Review.TryFirst.Desc")}
            </Text>
            <FindMoveBoard
              fen={moment.fenBefore}
              orientation={moment.color}
              answers={answers}
              onAttempt={(uci, correct) => update({ attempt: { uci, correct } })}
              showHint={state.hint}
              reveal={state.revealed || state.attempt?.correct === false}
              disabled={state.revealed || state.attempt?.correct === true}
              size="min(100%, 320px)"
            />
            {state.attempt && (
              <Text size="sm" c={state.attempt.correct ? "teal" : "red"}>
                {state.attempt.correct
                  ? t("Review.Attempt.Correct", { move: moment.bestSan })
                  : t("Review.Attempt.Wrong", {
                      move: lineToSan(moment.fenBefore, [state.attempt.uci], 1),
                    })}
              </Text>
            )}
            {!solved && (
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconBulb size="0.8rem" />}
                  onClick={() => update({ hint: true })}
                  disabled={state.hint}
                >
                  {t("Review.Hint")}
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconEye size="0.8rem" />}
                  onClick={() => update({ revealed: true })}
                >
                  {t("Review.Reveal")}
                </Button>
              </Group>
            )}
            {solved && (
              <Stack gap={4}>
                <Text size="sm">
                  <Text span c="dimmed">
                    {t("Review.Played")}：
                  </Text>
                  {moment.playedSan}
                  {"　"}
                  <Text span c="dimmed">
                    {t("Review.Best")}：
                  </Text>
                  <Text span fw={600}>
                    {moment.bestSan}
                  </Text>
                </Text>
                <Text size="sm">
                  <Text span c="dimmed">
                    {t("Review.BestLine")}：
                  </Text>
                  {bestLine}
                </Text>
                {moment.alternatives.length > 1 && (
                  <Text size="xs" c="dimmed">
                    {t("Review.Alternatives")}：
                    {moment.alternatives
                      .filter((a) => a.uci !== moment.bestUci)
                      .map((a) => a.san)
                      .join("、")}
                  </Text>
                )}
                <Text size="sm" fw={600}>
                  {t("Review.Explanations")}
                </Text>
                {moment.explanations && moment.explanations.length > 0 ? (
                  moment.explanations.map((e, i) => (
                    <ExplanationCard
                      key={`${e.id}-${i}`}
                      explanation={e}
                      compact
                      onDemo={(d) => demo(d.fen, d.line)}
                    />
                  ))
                ) : (
                  <Text size="sm" c="dimmed">
                    {t("Review.Explanations.Empty")}
                  </Text>
                )}
                <Group gap="xs">
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlayerPlay size="0.8rem" />}
                    onClick={() =>
                      demo(
                        moment.fenBefore,
                        moment.bestPv.length > 0 ? moment.bestPv : [moment.bestUci],
                      )
                    }
                  >
                    {t("Review.ShowOnBoard")}
                  </Button>
                </Group>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
