import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEye, IconEyeOff, IconPencil, IconX } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useContext, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ExplanationCard } from "@/chessin/explain";
import { typingGuardOptions } from "@/chessin/keymap/guard";
import ShortcutKbd from "@/chessin/keymap/ShortcutKbd";
import { applyLineAsVariation, goToMoment, locateMomentNode } from "@/chessin/review/applyLine";
import { lineToSan, moveLabel, percent } from "@/chessin/review/format";
import type { KeyMoment, Review } from "@/chessin/review/model";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { keyMapAtom } from "@/state/keybinds";
import { getNodeAtPath, type TreeNode, treeIteratorMainLine } from "@/utils/treeReducer";
import {
  type CommentSegment,
  getLayerText,
  LAYER_PREFIX,
  layerLabelKey,
  parseLayers,
  SEGMENT_LAYERS,
  type SegmentLayer,
  setLayerText,
} from "./layers";
import classes from "./layers.module.css";
import {
  annotateFirstFamily,
  hideAllMoments,
  isRevealed,
  layerVisibilityAtom,
  REVEAL_ALL,
  revealAllMoments,
  revealedFamily,
  revealMoment,
} from "./mode";

/**
 * 先自己注释 (annotate first, W3-4) inside the 讲解 dock tab. Mounted by
 * `ReviewPanel` while `annotateFirstFamily(tabId)` is on:
 *
 * - key moments of the review are listed in game order as "关键，在这里想一想"
 *   with no evaluation (kind, drop, best move all hidden);
 * - a 我的思考 box per moment (and one for the current position) saves into
 *   the node comment under the `【我的思考】` prefix (`setLayerText`);
 * - `R` (keymap `REVEAL`, typing-guarded) reveals the moment at the current
 *   position, else the first hidden one: evaluation + explanation next to
 *   the player's own text;
 * - the three comment layers 【我的思考】 / 【教练】 / 【引擎】 are listed with a
 *   legend and show / hide toggles that filter this panel's view only.
 */

const KIND_COLOR: Record<KeyMoment["kind"], string> = {
  blunder: "red",
  missed_win: "red",
  missed_draw: "orange",
  mistake: "orange",
  time_pressure: "yellow",
  only_move: "teal",
};

const LAYER_CLASS: Record<SegmentLayer, string> = {
  plain: classes.plain,
  mine: classes.mine,
  coach: classes.coach,
  engine: classes.engine,
};

const SWATCH_CLASS: Record<SegmentLayer, string> = {
  plain: classes.swatchPlain,
  mine: classes.swatchMine,
  coach: classes.swatchCoach,
  engine: classes.swatchEngine,
};

function samePath(a: number[], b: number[] | null): boolean {
  return b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function AnnotateFirstPanel({
  tabId,
  review,
}: {
  tabId: string;
  review: Review | null;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const [, setMode] = useAtom(annotateFirstFamily(tabId));
  const revealed = useAtomValue(revealedFamily(tabId));
  const keyMap = useAtomValue(keyMapAtom);

  const moments = useMemo(
    () => (review?.moments ?? []).slice().sort((a, b) => a.ply - b.ply),
    [review],
  );
  const paths = useMemo(() => moments.map((m) => locateMomentNode(root, m)), [root, moments]);
  const currentIndex = paths.findIndex((p) => samePath(position, p));
  const currentNode = getNodeAtPath(root, position);
  const allRevealed = revealed[REVEAL_ALL] === true;

  const revealNext = () => {
    if (currentIndex >= 0 && !isRevealed(revealed, moments[currentIndex].id)) {
      revealMoment(tabId, moments[currentIndex].id);
      return;
    }
    const first = moments.find((m) => !isRevealed(revealed, m.id));
    if (first) {
      revealMoment(tabId, first.id);
      goToMoment(store, first);
    }
  };

  useHotkeys(
    keyMap.REVEAL.keys,
    (e) => {
      e.preventDefault();
      revealNext();
    },
    { ...typingGuardOptions },
    [tabId, moments, revealed, currentIndex, store],
  );

  const saveThought = (path: number[], comment: string, text: string) => {
    const state = store.getState();
    if (!samePath(state.position, path)) state.goToMove(path);
    state.setComment(setLayerText(comment, "mine", text));
    notifications.show({ id: "chessin-annotate-first-saved", message: t("AnnotateFirst.Saved") });
  };

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack p="sm" gap="sm">
        <Card withBorder>
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Text fw={600}>{t("AnnotateFirst.Title")}</Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconX size="0.8rem" />}
                onClick={() => setMode(false)}
              >
                {t("AnnotateFirst.Exit")}
              </Button>
            </Group>
            <Text size="sm" c="dimmed">
              {t("AnnotateFirst.Desc")}
            </Text>
            <Group gap="xs">
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconEye size="0.8rem" />}
                disabled={moments.length === 0 || moments.every((m) => isRevealed(revealed, m.id))}
                onClick={revealNext}
              >
                {t("AnnotateFirst.Reveal")}
              </Button>
              <ShortcutKbd keys={keyMap.REVEAL.keys} />
              {allRevealed ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconEyeOff size="0.8rem" />}
                  onClick={() => hideAllMoments(tabId)}
                >
                  {t("AnnotateFirst.Hide")}
                </Button>
              ) : (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={moments.length === 0}
                  onClick={() => revealAllMoments(tabId)}
                >
                  {t("AnnotateFirst.RevealAll")}
                </Button>
              )}
            </Group>
          </Stack>
        </Card>

        {currentIndex === -1 && (
          <Card withBorder padding="sm">
            <Stack gap="xs">
              <Text fw={600} size="sm">
                {t("AnnotateFirst.CurrentPosition")}
                {currentNode.san ? ` · ${moveLabel(position.length, currentNode.san)}` : ""}
              </Text>
              <ThoughtBox
                key={currentNode.id}
                initial={getLayerText(currentNode.comment, "mine")}
                onSave={(text) => saveThought(position, currentNode.comment, text)}
              />
            </Stack>
          </Card>
        )}

        <Text fw={600}>{t("Review.Moments")}</Text>
        {!review && (
          <Text size="sm" c="dimmed">
            {t("AnnotateFirst.NoReview")}
          </Text>
        )}
        {review && moments.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("Review.Moments.Empty")}
          </Text>
        )}
        {moments.map((moment, i) => {
          const path = paths[i];
          const node = path ? getNodeAtPath(root, path) : null;
          return (
            <MomentThinkCard
              key={moment.id}
              moment={moment}
              revealed={isRevealed(revealed, moment.id)}
              selected={i === currentIndex}
              comment={node?.comment ?? ""}
              onSelect={() => goToMoment(store, moment)}
              onReveal={() => revealMoment(tabId, moment.id)}
              onSave={(text) => {
                if (path) saveThought(path, node?.comment ?? "", text);
              }}
              onDemo={(fen, line) =>
                applyLineAsVariation(
                  store,
                  {
                    ply: moment.ply,
                    fenBefore: fen,
                    nodeId: fen === moment.fenBefore ? moment.nodeId : undefined,
                  },
                  line,
                )
              }
            />
          );
        })}

        <LayersSection root={root} />
      </Stack>
    </ScrollArea>
  );
}

function ThoughtBox({ initial, onSave }: { initial: string; onSave: (text: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  // Reset the draft when the saved text changes underneath (another node, or a save elsewhere).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setText(initial);
  }
  const dirty = text.trim() !== initial.trim();
  return (
    <Stack gap={4}>
      <Textarea
        label={t("AnnotateFirst.MyThoughts")}
        placeholder={t("AnnotateFirst.MyThoughts.Placeholder")}
        autosize
        minRows={2}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        data-layer="mine"
      />
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<IconPencil size="0.8rem" />}
          disabled={!dirty}
          onClick={() => onSave(text)}
        >
          {t("AnnotateFirst.Save")}
        </Button>
        <Text size="xs" c="dimmed">
          {LAYER_PREFIX.mine}
        </Text>
      </Group>
    </Stack>
  );
}

function MomentThinkCard({
  moment,
  revealed,
  selected,
  comment,
  onSelect,
  onReveal,
  onSave,
  onDemo,
}: {
  moment: KeyMoment;
  revealed: boolean;
  selected: boolean;
  comment: string;
  onSelect: () => void;
  onReveal: () => void;
  onSave: (text: string) => void;
  onDemo: (fen: string, line: string[]) => void;
}) {
  const { t } = useTranslation();
  const bestLine = useMemo(
    () => lineToSan(moment.fenBefore, moment.bestPv.length > 0 ? moment.bestPv : [moment.bestUci]),
    [moment],
  );
  const thoughts = <ThoughtBox initial={getLayerText(comment, "mine")} onSave={onSave} />;

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
      data-revealed={revealed}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={600}>{moveLabel(moment.ply, moment.playedSan)}</Text>
            {revealed ? (
              <Badge size="sm" color={KIND_COLOR[moment.kind]} variant="light">
                {t(`Review.Kind.${moment.kind}`)}
              </Badge>
            ) : (
              <Badge size="sm" color="grape" variant="light">
                {t("AnnotateFirst.KeyMoment")}
              </Badge>
            )}
          </Group>
          {!revealed && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconEye size="0.8rem" />}
              onClick={(e) => {
                e.stopPropagation();
                onReveal();
              }}
            >
              {t("AnnotateFirst.Reveal")}
            </Button>
          )}
        </Group>
        {!revealed ? (
          thoughts
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
            {thoughts}
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {t("AnnotateFirst.Evaluation")}
              </Text>
              {moment.kind !== "only_move" && (
                <Text size="xs" c="red">
                  {t("Review.Drop", { percent: percent(moment.drop) })}
                </Text>
              )}
              <Text size="sm">
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
              {moment.explanations && moment.explanations.length > 0 ? (
                moment.explanations.map((e, i) => (
                  <ExplanationCard
                    key={`${e.id}-${i}`}
                    explanation={e}
                    compact
                    onDemo={(d) => onDemo(d.fen, d.line)}
                  />
                ))
              ) : (
                <Text size="sm" c="dimmed">
                  {t("Review.Explanations.Empty")}
                </Text>
              )}
            </Stack>
          </SimpleGrid>
        )}
      </Stack>
    </Card>
  );
}

type CommentRow = { ply: number; san: string; segments: CommentSegment[] };

function LayersSection({ root }: { root: TreeNode }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useAtom(layerVisibilityAtom);

  const rows = useMemo<CommentRow[]>(() => {
    const out: CommentRow[] = [];
    let ply = 0;
    for (const { node } of treeIteratorMainLine(root)) {
      if (!node.move) continue;
      ply += 1;
      if (!node.comment.trim()) continue;
      out.push({ ply, san: node.san ?? "", segments: parseLayers(node.comment) });
    }
    return out;
  }, [root]);

  const shown = rows
    .map((r) => ({ ...r, segments: r.segments.filter((s) => visible[s.layer] !== false) }))
    .filter((r) => r.segments.length > 0);

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t("AnnotateFirst.Layers")}
        </Text>
        <Group gap="sm">
          {SEGMENT_LAYERS.map((layer) => (
            <Checkbox
              key={layer}
              size="xs"
              checked={visible[layer] !== false}
              onChange={(e) => setVisible({ ...visible, [layer]: e.currentTarget.checked })}
              label={
                <span>
                  <span className={`${classes.swatch} ${SWATCH_CLASS[layer]}`} />
                  {t(layerLabelKey(layer))}
                  {layer !== "plain" && (
                    <Text span size="xs" c="dimmed">
                      {" "}
                      {LAYER_PREFIX[layer]}
                    </Text>
                  )}
                </span>
              }
              data-layer={layer}
            />
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          {t("AnnotateFirst.Layers.Hint")}
        </Text>
        {shown.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("AnnotateFirst.Layers.Empty")}
          </Text>
        )}
        {shown.map((row) => (
          <Stack key={row.ply} gap={0}>
            <Text size="sm" fw={600}>
              {moveLabel(row.ply, row.san)}
            </Text>
            {row.segments.map((s, i) => (
              <Text
                key={`${row.ply}-${i}`}
                size="sm"
                className={`${classes.segment} ${LAYER_CLASS[s.layer]}`}
              >
                {s.layer !== "plain" && (
                  <span className={classes.prefix}>{LAYER_PREFIX[s.layer]}</span>
                )}
                {s.text}
              </Text>
            ))}
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}
