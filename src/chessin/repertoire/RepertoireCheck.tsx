import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Menu,
  Paper,
  Popover,
  Progress,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowRight,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";
import { useAtom, useAtomValue, useStore as useJotaiStore } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { currentTabAtom, sessionsAtom } from "@/state/atoms";
import { getTabFile } from "@/utils/tabs";
import type { TreeNode } from "@/utils/treeReducer";
import {
  cancelRepertoireCheck,
  checkStateFamily,
  restoreLastCheck,
  runRepertoireCheck,
} from "./check";
import type { ColdNode } from "./cold";
import { pendingFillGapAtom } from "./commands";
import { type Conflict, unifyConflict } from "./conflicts";
import { explorerQueryFor, getExplorerCache } from "./explorerCache";
import { fillGap } from "./fill";
import { type Gap, type Reply, topReplies } from "./gaps";
import { formatLine, formatLineWithMove, moveLabel } from "./lines";
import { draftFromMeta, type MetaDraft, RepertoireMetaFields } from "./MetaFields";
import {
  defaultMeta,
  formatEloRange,
  loadRepertoireMeta,
  type RepertoireMeta,
  repertoireMetaId,
  saveRepertoireMeta,
} from "./model";

// t("Repertoire.Check.Title") t("Repertoire.Check.Recompute") t("Repertoire.Check.Querying")
// t("Repertoire.Check.Gauge") t("Repertoire.Check.GaugeMasters") t("Repertoire.Check.OfflineBadge")

const GAPS_PREVIEW = 8;

type ReplyState = { loading: boolean; replies: Reply[]; offline: boolean };

function coverageColor(covered: number): string {
  if (covered < 0.5) return "red";
  if (covered < 0.8) return "yellow";
  return "green";
}

function percent(value: number, digits = 0): string {
  return (value * 100).toFixed(digits);
}

export default function RepertoireCheck() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const jotaiStore = useJotaiStore();
  const currentTab = useAtomValue(currentTabAtom);
  const sessions = useAtomValue(sessionsAtom);
  const offline = useAtomValue(offlineModeAtom);
  const tabFile = getTabFile(currentTab);
  const filePath = tabFile?.path ?? "";
  const fileName = tabFile?.name ?? "";
  const isRepertoire = tabFile?.metadata.type === "repertoire";
  const repertoireId = repertoireMetaId(filePath);
  const state = useAtomValue(checkStateFamily(repertoireId));
  const [pendingFill, setPendingFill] = useAtom(pendingFillGapAtom);

  const [meta, setMeta] = useState<RepertoireMeta | null>(null);
  const [open, setOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<MetaDraft | null>(null);
  const [repliesFor, setRepliesFor] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const [filled, setFilled] = useState<Record<string, string>>({});
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [showCold, setShowCold] = useState(false);

  const orientation = headers.orientation ?? "white";

  useEffect(() => {
    if (!filePath) return;
    let alive = true;
    const fallback = defaultMeta({ color: orientation, startFen: headers.fen, sessions });
    loadRepertoireMeta(filePath, fallback).then(({ meta: loaded }) => {
      if (alive) setMeta({ ...loaded, color: orientation });
    });
    return () => {
      alive = false;
    };
  }, [filePath, orientation, headers.fen, sessions]);

  useEffect(() => {
    if (!filePath) return;
    void restoreLastCheck(repertoireId, jotaiStore);
  }, [filePath, repertoireId, jotaiStore]);

  const result = state.result;
  const running = state.status === "running";

  const openReplies = useCallback(
    async (gap: Gap) => {
      if (!meta) return;
      setOpen(true);
      setRepliesFor(gap.id);
      if (replies[gap.id] || !gap.childFen) return;
      setReplies((r) => ({ ...r, [gap.id]: { loading: true, replies: [], offline: false } }));
      const lookup = await getExplorerCache().lookup(gap.childFen, explorerQueryFor(meta));
      setReplies((r) => ({
        ...r,
        [gap.id]: {
          loading: false,
          replies: lookup.stats ? topReplies(lookup.stats, meta.color, 3) : [],
          offline: lookup.offline,
        },
      }));
    },
    [meta, replies],
  );

  useEffect(() => {
    if (!pendingFill || !result) return;
    const gap = result.gaps.find((g) => g.id === pendingFill);
    // Consume the request outside the render cycle of this effect.
    queueMicrotask(() => {
      setPendingFill(null);
      if (gap) void openReplies(gap);
    });
  }, [pendingFill, result, openReplies, setPendingFill]);

  const run = useCallback(async () => {
    if (!meta || !filePath) return;
    setFilled({});
    setReplies({});
    setRepliesFor(null);
    try {
      await runRepertoireCheck({ treeStore: store, repertoireId, meta, store: jotaiStore });
    } catch {
      // the state atom carries the error
    }
  }, [meta, filePath, store, repertoireId, jotaiStore]);

  const chooseReply = useCallback(
    (gap: Gap, reply: Reply) => {
      if (!fillGap(store, gap, reply.san)) return;
      setFilled((f) => ({ ...f, [gap.id]: reply.san }));
      setRepliesFor(null);
    },
    [store],
  );

  const unify = useCallback(
    (conflict: Conflict, san: string) => {
      const n = unifyConflict(store, conflict, san);
      notifications.show({ message: t("Repertoire.Conflicts.Unified", { n, san }) });
    },
    [store, t],
  );

  const saveSettings = useCallback(async () => {
    if (!meta || !draft || !filePath) return;
    const next: RepertoireMeta = { ...meta, ...draft };
    setMeta(next);
    setSettingsOpen(false);
    await saveRepertoireMeta(filePath, fileName || filePath, next);
  }, [meta, draft, filePath, fileName]);

  const gauge = useMemo(() => {
    if (!result) return null;
    const pct = percent(result.coverage.covered);
    return result.meta.ratingSource === "fide"
      ? t("Repertoire.Check.GaugeMasters", { depth: result.depthMoves, pct })
      : t("Repertoire.Check.Gauge", {
          range: formatEloRange(result.meta.eloRange),
          depth: result.depthMoves,
          pct,
        });
  }, [result, t]);

  if (!isRepertoire || !filePath) return null;

  const gaps = result?.gaps ?? [];
  const visibleGaps = showAllGaps ? gaps : gaps.slice(0, GAPS_PREVIEW);

  return (
    <>
      <Divider my="xs" />
      <Group justify="space-between" wrap="nowrap" px="xs">
        <UnstyledButton onClick={() => setOpen((v) => !v)}>
          <Group gap={4} wrap="nowrap">
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            <Text fz="sm" fw={600}>
              {t("Repertoire.Check.Title")}
            </Text>
          </Group>
        </UnstyledButton>
        <Group gap="xs" wrap="nowrap">
          {offline && (
            <Badge size="xs" color="gray" variant="light">
              {t("Repertoire.Check.OfflineBadge")}
            </Badge>
          )}
          <Popover
            opened={settingsOpen}
            onChange={setSettingsOpen}
            position="bottom-end"
            withinPortal
            width={300}
          >
            <Popover.Target>
              <Tooltip label={t("Repertoire.Settings.Title")} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  aria-label={t("Repertoire.Settings.Title")}
                  disabled={!meta}
                  onClick={() => {
                    if (meta) setDraft(draftFromMeta(meta));
                    setSettingsOpen((v) => !v);
                  }}
                >
                  <IconSettings size={16} />
                </ActionIcon>
              </Tooltip>
            </Popover.Target>
            <Popover.Dropdown>
              {draft && (
                <Stack gap="xs">
                  <RepertoireMetaFields value={draft} onChange={setDraft} showDepth size="xs" />
                  <Group justify="flex-end" gap="xs">
                    <Button size="xs" variant="subtle" onClick={() => setSettingsOpen(false)}>
                      {t("Common.Cancel")}
                    </Button>
                    <Button size="xs" onClick={() => void saveSettings()}>
                      {t("Common.Save")}
                    </Button>
                  </Group>
                </Stack>
              )}
            </Popover.Dropdown>
          </Popover>
          {running ? (
            <Button size="xs" variant="subtle" onClick={() => cancelRepertoireCheck(repertoireId)}>
              {t("Common.Cancel")}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              disabled={!meta || root.children.length === 0}
              onClick={() => void run()}
            >
              {result ? t("Repertoire.Check.Recompute") : t("Repertoire.Check.Run")}
            </Button>
          )}
        </Group>
      </Group>

      {open && (
        <ScrollArea.Autosize mah={300} px="xs" mt="xs">
          <Stack gap="xs">
            {running && (
              <Group gap="xs">
                <Loader size={12} />
                <Text fz="xs" c="dimmed">
                  {t("Repertoire.Check.Querying", {
                    done: state.progress.done,
                    total: state.progress.total,
                  })}
                </Text>
              </Group>
            )}
            {state.status === "error" && state.error && (
              <Text fz="xs" c="red">
                {t("Repertoire.Check.Failed", { error: state.error })}
              </Text>
            )}
            {!result && !running && (
              <Text fz="xs" c="dimmed">
                {root.children.length === 0
                  ? t("Repertoire.Check.Empty")
                  : t("Repertoire.Check.NoResult")}
              </Text>
            )}

            {result && (
              <>
                <Paper withBorder p="xs">
                  <Stack gap={6}>
                    <Text fz="sm">{gauge}</Text>
                    <Progress
                      value={Math.max(result.coverage.covered * 100, 2)}
                      color={coverageColor(result.coverage.covered)}
                      size="sm"
                      radius="xl"
                    />
                    <Text fz="xs" c="dimmed">
                      {t("Repertoire.Check.LastRun", {
                        time: new Date(result.at).toLocaleString(),
                      })}
                      {" · "}
                      {t("Repertoire.Check.Lookups", {
                        requests: result.coverage.requests,
                        cached: result.coverage.cached,
                      })}
                      {result.offline && (
                        <>
                          {" · "}
                          {result.partial
                            ? t("Repertoire.Check.OfflinePartial")
                            : t("Repertoire.Check.OfflineResult")}
                        </>
                      )}
                    </Text>
                  </Stack>
                </Paper>

                <Text fz="xs" fw={600}>
                  {t("Repertoire.Gaps.Title")} ({gaps.length})
                </Text>
                {gaps.length === 0 ? (
                  <Text fz="xs" c="dimmed">
                    {t("Repertoire.Gaps.None", { target: result.meta.coverageTarget })}
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {visibleGaps.map((gap) => (
                      <GapRow
                        key={gap.id}
                        gap={gap}
                        root={root}
                        filled={filled[gap.id]}
                        open={repliesFor === gap.id}
                        replies={replies[gap.id]}
                        onGoTo={() => goToMove(gap.path)}
                        onFill={() => void openReplies(gap)}
                        onChoose={(reply) => chooseReply(gap, reply)}
                      />
                    ))}
                    {gaps.length > GAPS_PREVIEW && !showAllGaps && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => setShowAllGaps(true)}
                      >
                        {t("Repertoire.Gaps.ShowMore", { n: gaps.length - GAPS_PREVIEW })}
                      </Button>
                    )}
                  </Stack>
                )}

                <Text fz="xs" fw={600}>
                  {t("Repertoire.Conflicts.Title")} ({result.conflicts.length})
                </Text>
                {result.conflicts.length === 0 ? (
                  <Text fz="xs" c="dimmed">
                    {t("Repertoire.Conflicts.None")}
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {result.conflicts.map((conflict) => (
                      <ConflictRow
                        key={conflict.epd}
                        conflict={conflict}
                        onGoTo={(path) => goToMove(path)}
                        onUnify={(san) => unify(conflict, san)}
                      />
                    ))}
                  </Stack>
                )}

                <Group gap="xs" wrap="nowrap">
                  <Text fz="xs" fw={600}>
                    {t("Repertoire.Cold.Title")}
                  </Text>
                  <Text fz="xs" c="dimmed">
                    {result.cold.count === 0
                      ? t("Repertoire.Cold.None")
                      : t("Repertoire.Cold.Count", {
                          n: result.cold.count,
                          pct: percent(result.cold.threshold, 1),
                        })}
                  </Text>
                  {result.cold.heads.length > 0 && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => setShowCold((v) => !v)}
                    >
                      {showCold ? t("Repertoire.Cold.Hide") : t("Repertoire.Cold.Show")}
                    </Button>
                  )}
                </Group>
                {showCold && result.cold.heads.length > 0 && (
                  <Stack gap={2}>
                    <Text fz="xs" c="dimmed">
                      {t("Repertoire.Cold.Hint")}
                    </Text>
                    {result.cold.heads.map((head) => (
                      <ColdRow
                        key={head.nodeId}
                        head={head}
                        root={root}
                        onGoTo={() => goToMove(head.path)}
                      />
                    ))}
                  </Stack>
                )}
              </>
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </>
  );
}

function GapRow({
  gap,
  root,
  filled,
  open,
  replies,
  onGoTo,
  onFill,
  onChoose,
}: {
  gap: Gap;
  root: TreeNode;
  filled: string | undefined;
  open: boolean;
  replies: ReplyState | undefined;
  onGoTo: () => void;
  onFill: () => void;
  onChoose: (reply: Reply) => void;
}) {
  const { t } = useTranslation();
  const line = formatLineWithMove(root, gap.path, gap.san);
  return (
    <Paper withBorder p={6}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <UnstyledButton onClick={onGoTo} style={{ minWidth: 0, flex: 1 }}>
          <Text fz="xs" truncate title={line}>
            {line}
          </Text>
          <Group gap={6} wrap="nowrap">
            <Text fz="xs" c="dimmed">
              {t("Repertoire.Gaps.Probability", { pct: percent(gap.probability, 1) })}
            </Text>
            {gap.evalLoss !== null ? (
              <Text fz="xs" c="dimmed">
                {t("Repertoire.Gaps.Danger", { pct: percent(gap.evalLoss) })}
              </Text>
            ) : (
              <Text fz="xs" c="dimmed">
                {t("Repertoire.Gaps.EvalUnknown")}
              </Text>
            )}
            {gap.inTree && (
              <Badge size="xs" variant="light" color="orange">
                {t("Repertoire.Gaps.InTree")}
              </Badge>
            )}
          </Group>
        </UnstyledButton>
        {filled ? (
          <Badge size="xs" color="green" variant="light">
            {filled}
          </Badge>
        ) : (
          <Button size="compact-xs" variant="light" onClick={onFill}>
            {t("Repertoire.Gaps.Fill")}
          </Button>
        )}
      </Group>
      {filled && (
        <Text fz="xs" c="dimmed" mt={4}>
          {t("Repertoire.Gaps.Filled", { san: filled })}
        </Text>
      )}
      {open && !filled && (
        <Stack gap={4} mt={6}>
          <Text fz="xs" c="dimmed">
            {t("Repertoire.Gaps.TopReplies")}
          </Text>
          {!replies || replies.loading ? (
            <Group gap="xs">
              <Loader size={10} />
              <Text fz="xs" c="dimmed">
                {t("Repertoire.Gaps.LoadingReplies")}
              </Text>
            </Group>
          ) : replies.replies.length === 0 ? (
            <Text fz="xs" c="dimmed">
              {replies.offline
                ? t("Repertoire.Check.OfflineBadge")
                : t("Repertoire.Gaps.NoReplies")}
            </Text>
          ) : (
            replies.replies.map((reply) => (
              <Button
                key={reply.uci}
                size="compact-xs"
                variant="default"
                justify="space-between"
                rightSection={<IconArrowRight size={12} />}
                onClick={() => onChoose(reply)}
              >
                {moveLabel(gap.halfMoves + 2, reply.san)}
                {" · "}
                {t("Repertoire.Gaps.ReplyStats", {
                  score: percent(reply.userScore),
                  games: reply.games.toLocaleString(),
                })}
              </Button>
            ))
          )}
        </Stack>
      )}
    </Paper>
  );
}

function ConflictRow({
  conflict,
  onGoTo,
  onUnify,
}: {
  conflict: Conflict;
  onGoTo: (path: number[]) => void;
  onUnify: (san: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Paper withBorder p={6}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          {conflict.occurrences.map((occ) => (
            <UnstyledButton key={occ.nodeId} onClick={() => onGoTo(occ.path)}>
              <Text fz="xs" truncate title={occ.line}>
                {occ.line || "—"}
                {" → "}
                <Text span fw={600} fz="xs">
                  {moveLabel(conflict.halfMoves + 1, occ.san)}
                </Text>
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <Button size="compact-xs" variant="light">
              {t("Repertoire.Conflicts.UnifyAs")}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {conflict.moves.map((san) => (
              <Menu.Item key={san} onClick={() => onUnify(san)}>
                {moveLabel(conflict.halfMoves + 1, san)}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Paper>
  );
}

function ColdRow({ head, root, onGoTo }: { head: ColdNode; root: TreeNode; onGoTo: () => void }) {
  const line = formatLine(root, head.path);
  return (
    <UnstyledButton onClick={onGoTo}>
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Text fz="xs" truncate title={line}>
          {line}
        </Text>
        <Text fz="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {percent(head.reach, 2)}%
        </Text>
      </Group>
    </UnstyledButton>
  );
}
