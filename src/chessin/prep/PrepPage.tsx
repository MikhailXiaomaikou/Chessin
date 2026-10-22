import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronRight,
  IconLink,
  IconPin,
  IconPinned,
  IconSearch,
  IconSwords,
  IconTrash,
} from "@tabler/icons-react";
import { useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import MiniBoard from "@/chessin/board/MiniBoard";
import { addUserAlias, displayName, MATCH_EXACT } from "@/chessin/names/aliases";
import { openNotebook } from "@/chessin/notebook/commands";
import type { PlayerColor } from "@/chessin/repertoire/model";
import {
  type Briefing,
  buildBriefing,
  type Clash,
  defaultBriefingDeps,
  type OpeningNode,
  type StyleMetric,
  type TimeControlBucket,
} from "./briefing";
import {
  type AccountInspection,
  type Candidate,
  type CandidateSearch,
  canScoutOnline,
  confirmLink,
  findCandidates,
  inspectLichessAccount,
  lastGameDate,
  loadLinks,
  type OnlineLink,
  removeLink,
  totalGames,
} from "./candidates";
import { clearPrepNavigator, type PrepNavigator, setPrepNavigator } from "./commands";
import { formatSanLine } from "./movetext";
import { loadPack, newPack, pinLine, type PrepPack, setDeadline, unpinLine } from "./pack";
import { loadRepertoireIndex } from "./repertoireIndex";

/**
 * `/prep` (S4-2): 备战 — search an opponent, pick the candidate, choose my
 * side, read the briefing (overview, opening tree, leaving theory, style,
 * clash map), pin lines into the prep pack with a 比赛日, and see the
 * post-game self-assessments. No Maia distributions in v0 (licence-gated):
 * nothing is shown for them, not even a placeholder.
 */

type Preview = { fen: string; lastMove?: string; title: string };

const TIME_CONTROL_ORDER: TimeControlBucket[] = [
  "classical",
  "rapid",
  "blitz",
  "bullet",
  "unknown",
];

function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return `${(value * 100).toFixed(digits)}%`;
}

function colorLabel(color: PlayerColor, t: (key: string) => string): string {
  return color === "white" ? t("Common.WHITE") : t("Common.BLACK");
}

// t("Prep.TimeControl.classical") t("Prep.TimeControl.rapid") t("Prep.TimeControl.blitz")
// t("Prep.TimeControl.bullet") t("Prep.TimeControl.unknown") t("Notebook.Kind.prep")

function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Card withBorder radius="md" p="md" data-chessin-prep-section={testId}>
      <Stack gap="xs">
        <Title order={5}>{title}</Title>
        {description && (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
        {children}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Candidates

function CandidateCard({
  candidate,
  query,
  selected,
  links,
  onSelect,
  onLink,
  onUnlink,
  onAlias,
}: {
  candidate: Candidate;
  query: string;
  selected: boolean;
  links: OnlineLink[];
  onSelect: () => void;
  onLink: () => void;
  onUnlink: (link: OnlineLink) => void;
  onAlias: () => void;
}) {
  const { t } = useTranslation();
  const games = totalGames(candidate);
  const last = lastGameDate(candidate);
  const fide = candidate.fide;
  return (
    <Card
      withBorder
      radius="md"
      p="sm"
      data-chessin-prep-candidate={candidate.key}
      style={{ borderColor: selected ? "var(--mantine-color-blue-filled)" : undefined }}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} truncate>
              {displayName(candidate.name)}
            </Text>
            <Group gap={6}>
              {fide && (
                <Badge size="xs" variant="light">
                  {t("Prep.Candidate.Fide", { id: fide.id })}
                  {fide.federation ? ` · ${fide.federation}` : ""}
                  {fide.title ? ` · ${fide.title}` : ""}
                </Badge>
              )}
              <Text size="xs" c="dimmed">
                {fide?.year
                  ? t("Prep.Candidate.Born", { year: fide.year })
                  : t("Prep.Candidate.BirthUnknown")}
              </Text>
            </Group>
          </Stack>
          <Button
            size="xs"
            variant={selected ? "filled" : "default"}
            onClick={onSelect}
            style={{ flex: "none" }}
          >
            {selected ? t("Prep.Candidate.Selected") : t("Prep.Candidate.Select")}
          </Button>
        </Group>
        {fide && (
          <Text size="xs" c="dimmed">
            {t("Prep.Candidate.Ratings", {
              standard: fide.standard ?? "–",
              rapid: fide.rapid ?? "–",
              blitz: fide.blitz ?? "–",
            })}
          </Text>
        )}
        {candidate.sources.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t("Prep.Candidate.NoLocalGames")}
          </Text>
        ) : (
          <Stack gap={2}>
            {candidate.sources.map((s) => (
              <Text key={`${s.database}#${s.playerId}`} size="xs">
                {t("Prep.Candidate.Source", { title: s.title, count: s.games })}
                {s.lastDate ? ` · ${t("Prep.Candidate.LastGame", { date: s.lastDate })}` : ""}
                {s.name !== candidate.name ? ` · ${s.name}` : ""}
              </Text>
            ))}
            {candidate.sources.length > 1 && (
              <Text size="xs" c="dimmed">
                {t("Prep.Candidate.Source", { title: "Σ", count: games })}
                {last ? ` · ${t("Prep.Candidate.LastGame", { date: last })}` : ""}
              </Text>
            )}
          </Stack>
        )}
        {candidate.minor ? (
          <Alert color="yellow" title={t("Prep.Minor.Title")} data-chessin-prep-minor>
            {t("Prep.Minor.Notice")}
          </Alert>
        ) : (
          <Group gap="xs">
            {links.map((link) => (
              <Badge
                key={`${link.site}:${link.username}`}
                variant="light"
                color="teal"
                rightSection={
                  <ActionIcon
                    size="xs"
                    variant="transparent"
                    color="teal"
                    aria-label={t("Prep.Link.Remove")}
                    onClick={() => onUnlink(link)}
                  >
                    <IconTrash size="0.8rem" />
                  </ActionIcon>
                }
              >
                {t("Prep.Link.Linked")} · {link.site}/{link.username}
              </Badge>
            ))}
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconLink size="0.9rem" />}
              onClick={onLink}
              data-chessin-prep-link
            >
              {t("Prep.Link.Button")}
            </Button>
            {candidate.score < MATCH_EXACT && query && (
              <Tooltip
                label={t("Names.AddAliasHint", { query, name: candidate.name })}
                multiline
                maw={300}
              >
                <Button size="compact-xs" variant="subtle" onClick={onAlias}>
                  {t("Names.AddAlias")}
                </Button>
              </Tooltip>
            )}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function LinkAccountModal({
  candidate,
  opened,
  onClose,
  onLinked,
}: {
  candidate: Candidate;
  opened: boolean;
  onClose: () => void;
  onLinked: (links: OnlineLink[]) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [inspection, setInspection] = useState<AccountInspection | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setUsername("");
    setInspection(null);
    setNotFound(false);
    onClose();
  };

  async function inspect() {
    setBusy(true);
    setNotFound(false);
    setInspection(null);
    try {
      const result = await inspectLichessAccount(candidate, username);
      if (result) setInspection(result);
      else setNotFound(true);
    } catch {
      setNotFound(true);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!inspection) return;
    const links = await confirmLink(candidate, {
      site: "lichess",
      username: inspection.username,
      evidence: inspection.evidence,
    });
    onLinked(links);
    close();
  }

  const ev = inspection?.evidence;
  return (
    <Modal opened={opened} onClose={close} title={t("Prep.Link.Title")}>
      <Stack>
        <Alert color="blue">{t("Prep.Link.NoSuggestion")}</Alert>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void inspect();
          }}
        >
          <Group align="flex-end" wrap="nowrap">
            <TextInput
              label={t("Prep.Link.Username")}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              style={{ flex: 1 }}
              data-autofocus
            />
            <Button type="submit" loading={busy} disabled={!username.trim()}>
              {t("Prep.Link.Inspect")}
            </Button>
          </Group>
        </form>
        {notFound && <Text c="red">{t("Prep.Link.NotFound")}</Text>}
        {inspection && ev && (
          <Table withTableBorder data-chessin-prep-evidence>
            <Table.Tbody>
              <Table.Tr>
                <Table.Th>{t("Prep.Link.Evidence")}</Table.Th>
                <Table.Td>lichess/{inspection.username}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>{t("Prep.Link.RealName")}</Table.Th>
                <Table.Td>{ev.realName ?? t("Prep.Link.NotStated")}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>{t("Prep.Link.FideRating")}</Table.Th>
                <Table.Td>{ev.fideRating ?? t("Prep.Link.NotStated")}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>{t("Prep.Link.FideId")}</Table.Th>
                <Table.Td>
                  {ev.fideId === null
                    ? t("Prep.Link.NotStated")
                    : `${ev.fideId} · ${
                        candidate.fide
                          ? ev.matchesFideId
                            ? t("Prep.Link.FideIdMatch")
                            : t("Prep.Link.FideIdMismatch")
                          : ""
                      }`}
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t("Common.Cancel")}
          </Button>
          <Button
            disabled={!inspection}
            onClick={() => void confirm()}
            data-chessin-prep-confirm-link
          >
            {t("Prep.Link.Confirm")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Briefing sections

function OverviewSection({ briefing }: { briefing: Briefing }) {
  const { t } = useTranslation();
  const o = briefing.overview;
  const tcs = TIME_CONTROL_ORDER.filter((k) => o.timeControls[k] > 0)
    .map((k) => `${t(`Prep.TimeControl.${k}`)} ${o.timeControls[k]}`)
    .join(" · ");
  return (
    <Section title={t("Prep.Overview.Title")} testId="overview">
      <Table>
        <Table.Tbody>
          <Table.Tr>
            <Table.Th w={120}>{t("Prep.Overview.Rating")}</Table.Th>
            <Table.Td>
              {o.ratings.games > 0
                ? t("Prep.Overview.RatingValue", {
                    latest: o.ratings.latest ?? "–",
                    max: o.ratings.max ?? "–",
                    avg: o.ratings.avg ?? "–",
                  })
                : "–"}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{t("Prep.Overview.Games")}</Table.Th>
            <Table.Td>
              {t("Prep.Overview.GamesValue", {
                white: o.gamesByColour.white,
                black: o.gamesByColour.black,
              })}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{t("Prep.Overview.TimeControls")}</Table.Th>
            <Table.Td>{tcs || "–"}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>{t("Prep.Overview.Years")}</Table.Th>
            <Table.Td>
              {o.years.from === null
                ? "–"
                : o.years.from === o.years.to
                  ? o.years.from
                  : `${o.years.from}–${o.years.to}`}
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Section>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onPreview,
}: {
  node: OpeningNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onPreview: (p: Preview) => void;
}) {
  const { t } = useTranslation();
  const key = `${node.ply}:${node.epd}`;
  const open = expanded.has(key);
  const label = formatSanLine([node.san], node.ply);
  return (
    <>
      <Group gap={4} wrap="nowrap" style={{ paddingLeft: depth * 14 }}>
        <ActionIcon
          size="xs"
          variant="subtle"
          aria-label={open ? t("Prep.Tree.Collapse") : t("Prep.Tree.Expand")}
          onClick={() => onToggle(key)}
          disabled={node.children.length === 0}
        >
          {open ? <IconChevronDown size="0.9rem" /> : <IconChevronRight size="0.9rem" />}
        </ActionIcon>
        <UnstyledButton
          onClick={() => onPreview({ fen: node.fen, lastMove: node.uci, title: label })}
          data-chessin-prep-node={key}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={node.byOpponent ? 600 : 400} ff="monospace">
              {label}
            </Text>
            <Text size="xs" c="dimmed">
              {t("Prep.Tree.Count", { count: node.count })}
            </Text>
            {node.byOpponent && node.score !== null && (
              <Text size="xs" c="dimmed">
                {t("Prep.Tree.Score", { score: percent(node.score) })}
              </Text>
            )}
            {node.lastDate && (
              <Text size="xs" c="dimmed">
                {t("Prep.Tree.Last", { date: node.lastDate })}
              </Text>
            )}
            {node.recentShift && (
              <Badge size="xs" color="orange" variant="light">
                {t("Prep.Tree.RecentShift")}
              </Badge>
            )}
          </Group>
        </UnstyledButton>
      </Group>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={`${child.ply}:${child.epd}:${child.san}`}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onPreview={onPreview}
          />
        ))}
    </>
  );
}

function OpeningTreeSection({
  briefing,
  onPreview,
}: {
  briefing: Briefing;
  onPreview: (p: Preview) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const tree = briefing.openingTree;
  return (
    <Section
      title={t("Prep.Tree.Title")}
      description={t("Prep.Tree.Desc", { color: colorLabel(tree.color, t) })}
      testId="tree"
    >
      {tree.root.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Prep.Tree.Empty")}
        </Text>
      ) : (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            {t("Prep.Tree.Count", { count: tree.games })}
          </Text>
          {tree.root.map((node) => (
            <TreeRow
              key={`${node.ply}:${node.epd}:${node.san}`}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              onPreview={onPreview}
            />
          ))}
        </Stack>
      )}
    </Section>
  );
}

function LeaveTheorySection({
  briefing,
  onPreview,
}: {
  briefing: Briefing;
  onPreview: (p: Preview) => void;
}) {
  const { t } = useTranslation();
  const lt = briefing.leaveTheory;
  return (
    <Section title={t("Prep.Theory.Title")} description={t("Prep.Theory.Desc")} testId="theory">
      {lt.items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Prep.Theory.Empty")}
        </Text>
      ) : (
        <Stack gap={4}>
          {lt.items.map((item) => (
            <UnstyledButton
              key={`${item.ply}:${item.epd}:${item.san}`}
              onClick={() => onPreview({ fen: item.fen, title: formatSanLine(item.line) })}
              data-chessin-prep-theory={item.ply}
            >
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }} truncate>
                  {formatSanLine(item.line)}
                </Text>
                <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                  {item.mastersGames === 0
                    ? t("Prep.Theory.Unseen")
                    : t("Prep.Theory.Freq", {
                        percent: percent(item.mastersFreq, 1),
                        games: item.mastersGames,
                      })}
                  {" · "}
                  {t("Prep.Tree.Count", { count: item.count })}
                </Text>
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
      )}
      {(lt.exhausted || lt.unknown > 0) && (
        <Text size="xs" c="dimmed">
          {lt.exhausted && t("Prep.Theory.Budget", { requests: lt.requests })}
          {lt.exhausted && lt.unknown > 0 && " · "}
          {lt.unknown > 0 && t("Prep.Theory.Unknown", { count: lt.unknown })}
        </Text>
      )}
    </Section>
  );
}

function StyleSection({ briefing }: { briefing: Briefing }) {
  const { t } = useTranslation();
  const s = briefing.style;
  const row = (label: string, metric: StyleMetric, format: (v: number) => string) => (
    <Table.Tr>
      <Table.Th w={140}>{label}</Table.Th>
      <Table.Td>
        {metric.value === null ? t("Prep.Style.NoData") : format(metric.value)}
        <Text span size="xs" c="dimmed">
          {" · "}
          {t("Prep.Style.Sample", { count: metric.sampleSize })}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
  return (
    <Section title={t("Prep.Style.Title")} testId="style">
      <Table>
        <Table.Tbody>
          {row(t("Prep.Style.AvgLength"), s.avgLength, (v) =>
            t("Prep.Style.AvgLengthValue", { moves: v.toFixed(0) }),
          )}
          {row(t("Prep.Style.DrawRate"), s.drawRate, (v) => percent(v))}
          {row(t("Prep.Style.DecisiveAsWhite"), s.decisiveAsWhite, (v) => percent(v))}
          {row(t("Prep.Style.DecisiveAsBlack"), s.decisiveAsBlack, (v) => percent(v))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

function ClashSection({
  briefing,
  pack,
  onPreview,
  onPin,
}: {
  briefing: Briefing;
  pack: PrepPack | null;
  onPreview: (p: Preview) => void;
  onPin: (row: Clash) => void;
}) {
  const { t } = useTranslation();
  const clash = briefing.clash;
  const pinned = useMemo(() => new Set(pack?.lines.map((l) => l.epd) ?? []), [pack]);
  return (
    <Section title={t("Prep.Clash.Title")} description={t("Prep.Clash.Desc")} testId="clash">
      {clash.noRepertoire ? (
        <Text size="sm" c="dimmed">
          {t("Prep.Clash.NoRepertoire", { color: colorLabel(briefing.mySide, t) })}
        </Text>
      ) : clash.rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Prep.Clash.Empty")}
        </Text>
      ) : (
        <Stack gap={4}>
          {clash.rows.map((row) => {
            const isPinned = pinned.has(row.epd);
            return (
              <Group key={row.epd} gap="xs" wrap="nowrap" data-chessin-prep-clash={row.epd}>
                <UnstyledButton
                  onClick={() =>
                    onPreview({ fen: row.fen, lastMove: row.uci, title: formatSanLine(row.line) })
                  }
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" ff="monospace" truncate style={{ minWidth: 0 }}>
                      {formatSanLine(row.line)}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                      {t("Prep.Clash.Freq", { percent: percent(row.opponentFreq) })}
                      {" · "}
                      {t("Prep.Tree.Count", { count: row.count })}
                    </Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={row.prepared ? "teal" : "red"}
                      style={{ flex: "none" }}
                    >
                      {row.prepared ? t("Prep.Clash.Prepared") : t("Prep.Clash.Unprepared")}
                    </Badge>
                    {row.replies.length > 0 && (
                      <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                        {t("Prep.Clash.Reply", { sans: row.replies.map((r) => r.san).join(" / ") })}
                      </Text>
                    )}
                  </Group>
                </UnstyledButton>
                <Button
                  size="compact-xs"
                  variant={isPinned ? "light" : "default"}
                  leftSection={isPinned ? <IconPinned size="0.8rem" /> : <IconPin size="0.8rem" />}
                  disabled={isPinned || !row.prepared || row.replies.length === 0}
                  onClick={() => onPin(row)}
                  style={{ flex: "none" }}
                >
                  {isPinned ? t("Prep.Clash.Pinned") : t("Prep.Clash.Pin")}
                </Button>
              </Group>
            );
          })}
        </Stack>
      )}
    </Section>
  );
}

function PackSection({
  pack,
  onDeadline,
  onUnpin,
  onPreview,
}: {
  pack: PrepPack;
  onDeadline: (deadline: number | null) => void;
  onUnpin: (epd: string) => void;
  onPreview: (p: Preview) => void;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t("Prep.Pack.Title")} description={t("Prep.Pack.Desc")} testId="pack">
      <Group align="flex-end" wrap="nowrap">
        <DateInput
          label={t("Prep.Pack.Deadline")}
          valueFormat="YYYY.MM.DD"
          value={pack.deadline === null ? null : new Date(pack.deadline)}
          clearable
          onChange={(value) => onDeadline(value ? dayjs(value).startOf("day").valueOf() : null)}
          data-chessin-prep-deadline
        />
        <Button
          variant="light"
          onClick={() => openNotebook({ review: true })}
          disabled={pack.lines.length === 0}
        >
          {t("Prep.Pack.Review")}
        </Button>
      </Group>
      {pack.lines.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("Prep.Pack.Empty")}
        </Text>
      ) : (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {t("Prep.Pack.Lines", { count: pack.lines.length })}
          </Text>
          {pack.lines.map((line) => (
            <Group key={line.epd} gap="xs" wrap="nowrap" data-chessin-prep-pinned={line.epd}>
              <UnstyledButton
                onClick={() => onPreview({ fen: line.fen, title: formatSanLine(line.line) })}
                style={{ flex: 1, minWidth: 0 }}
              >
                <Text size="sm" ff="monospace" truncate>
                  {formatSanLine(line.line)}
                  {line.answerSans.length > 0 && (
                    <Text span size="xs" c="dimmed">
                      {" → "}
                      {line.answerSans.join(" / ")}
                    </Text>
                  )}
                </Text>
              </UnstyledButton>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                aria-label={t("Prep.Pack.Unpin")}
                onClick={() => onUnpin(line.epd)}
              >
                <IconTrash size="0.9rem" />
              </ActionIcon>
            </Group>
          ))}
        </Stack>
      )}
      {pack.assessments.length > 0 && (
        <Stack gap={2}>
          <Text size="sm" fw={500}>
            {t("Prep.Pack.Assessments")}
          </Text>
          {pack.assessments.map((a) => (
            <Text key={a.gameKey} size="xs" data-chessin-prep-assessment={a.gameKey}>
              {a.followedPlies > 0
                ? t("Prep.Pack.Assessment", {
                    date: a.date ?? "?",
                    moves: a.followedMoves,
                    result: a.result,
                  })
                : t("Prep.Pack.AssessmentNone", { date: a.date ?? "?", result: a.result })}
            </Text>
          ))}
        </Stack>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page

export default function PrepPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { documentDir } = useLoaderData({ from: "/prep" });
  const search = useSearch({ strict: false }) as { q?: string };

  const [query, setQuery] = useState(search.q ?? "");
  const [result, setResult] = useState<CandidateSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [mySide, setMySide] = useState<PlayerColor>("white");
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pack, setPack] = useState<PrepPack | null>(null);
  const [links, setLinks] = useState<OnlineLink[]>([]);
  const [linkOpened, setLinkOpened] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const searchRun = useRef(0);
  const buildRun = useRef(0);
  const autoSearched = useRef<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const text = q.trim();
    const run = ++searchRun.current;
    setSelected(null);
    setBriefing(null);
    setPack(null);
    setPreview(null);
    if (!text) {
      setResult(null);
      return;
    }
    setSearching(true);
    try {
      const found = await findCandidates(text);
      if (run !== searchRun.current) return;
      setResult(found);
      if (found.candidates.length === 1) setSelected(found.candidates[0]);
    } finally {
      if (run === searchRun.current) setSearching(false);
    }
  }, []);

  // `prep.open` navigates through the router while mounted.
  useEffect(() => {
    const navigator: PrepNavigator = (target) => {
      void navigate({ to: "/prep", search: target.q ? { q: target.q } : {} });
      if (target.q) {
        setQuery(target.q);
        void runSearch(target.q);
      }
    };
    setPrepNavigator(navigator);
    return () => clearPrepNavigator(navigator);
  }, [navigate, runSearch]);

  // `/prep?q=` searches once.
  useEffect(() => {
    if (search.q && autoSearched.current !== search.q) {
      autoSearched.current = search.q;
      setQuery(search.q);
      void runSearch(search.q);
    }
  }, [search.q, runSearch]);

  // Briefing + pack + links for the selected candidate and side.
  useEffect(() => {
    if (!selected) return;
    const run = ++buildRun.current;
    const candidate = selected;
    // Deferred so the effect itself sets no state (react/set-state-in-effect).
    void Promise.resolve().then(async () => {
      if (run !== buildRun.current) return;
      setBuilding(true);
      setBuildError(null);
      setBriefing(null);
      try {
        const [loadedPack, loadedLinks, repertoire] = await Promise.all([
          loadPack(candidate.name),
          canScoutOnline(candidate) ? loadLinks(candidate) : Promise.resolve([]),
          loadRepertoireIndex(documentDir, mySide),
        ]);
        if (run !== buildRun.current) return;
        const existing = loadedPack && loadedPack.mySide === mySide ? loadedPack : null;
        setPack(
          existing ?? {
            ...newPack(candidate.name, mySide),
            ...(loadedPack
              ? { deadline: loadedPack.deadline, assessments: loadedPack.assessments }
              : {}),
          },
        );
        setLinks(loadedLinks);
        const built = await buildBriefing(
          candidate,
          { mySide },
          {
            ...defaultBriefingDeps(),
            userMoveIndex: repertoire.files.length > 0 ? repertoire.userMoveIndex : null,
            userReplies: repertoire.userReplies,
          },
        );
        if (run !== buildRun.current) return;
        setBriefing(built);
      } catch (e) {
        if (run === buildRun.current) setBuildError(e instanceof Error ? e.message : String(e));
      } finally {
        if (run === buildRun.current) setBuilding(false);
      }
    });
  }, [selected, mySide, documentDir]);

  const pin = useCallback(
    async (row: Clash) => {
      if (!pack) return;
      const next = await pinLine(pack, {
        epd: row.epd,
        fen: row.fen,
        ply: row.ply,
        line: row.line,
        answers: row.replies.map((r) => r.uci),
        answerSans: row.replies.map((r) => r.san),
      });
      setPack(next);
      notifications.show({ message: t("Prep.Pack.PinDone") });
    },
    [pack, t],
  );

  const unpin = useCallback(
    async (epd: string) => {
      if (!pack) return;
      setPack(await unpinLine(pack, epd));
    },
    [pack],
  );

  const changeDeadline = useCallback(
    async (deadline: number | null) => {
      if (!pack || pack.deadline === deadline) return;
      setPack(await setDeadline(pack, deadline));
      notifications.show({ message: t("Prep.Pack.DeadlineSaved") });
    },
    [pack, t],
  );

  const addAlias = useCallback(
    async (candidate: Candidate) => {
      await addUserAlias(query, candidate.name);
      notifications.show({ message: t("Names.AliasAdded") });
      void runSearch(query);
    },
    [query, runSearch, t],
  );

  const sideData = useMemo(
    () => [
      { label: t("Common.WHITE"), value: "white" },
      { label: t("Common.BLACK"), value: "black" },
    ],
    [t],
  );

  return (
    <Stack h="100%" p="md" gap="sm" style={{ overflow: "hidden" }} data-chessin-prep-page>
      <Group gap="xs" wrap="nowrap">
        <IconSwords size="1.6rem" stroke={1.5} aria-hidden="true" />
        <Title order={3}>{t("Prep.Title")}</Title>
      </Group>
      <Text size="sm" c="dimmed">
        {t("Prep.Desc")}
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
        }}
      >
        <Group wrap="nowrap" align="flex-end">
          <TextInput
            style={{ flex: 1 }}
            placeholder={t("Prep.Search.Placeholder")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            leftSection={<IconSearch size="1rem" />}
            data-chessin-prep-search
          />
          <Button type="submit" loading={searching} disabled={!query.trim()}>
            {t("Prep.Search.Button")}
          </Button>
          <SegmentedControl
            value={mySide}
            onChange={(v) => setMySide(v as PlayerColor)}
            data={sideData}
            aria-label={t("Prep.Side.Label")}
            data-chessin-prep-side
          />
        </Group>
      </form>

      <Group align="flex-start" wrap="nowrap" gap="md" style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea flex={1} h="100%" type="auto" offsetScrollbars>
          <Stack gap="sm" pb="md">
            {result && (
              <Stack gap="xs" data-chessin-prep-results>
                <Text size="xs" c="dimmed">
                  {t("Prep.Search.Databases", { count: result.databases })}
                  {result.offline && ` · ${t("Prep.Search.Offline")}`}
                  {result.fideError && ` · ${t("Prep.Search.FideError")}`}
                </Text>
                {result.candidates.length === 0 ? (
                  <Stack gap={2}>
                    <Text fw={500}>{t("Prep.Search.Empty")}</Text>
                    <Text size="sm" c="dimmed">
                      {t("Prep.Search.EmptyHint")}
                    </Text>
                  </Stack>
                ) : (
                  result.candidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.key}
                      candidate={candidate}
                      query={result.query}
                      selected={selected?.key === candidate.key}
                      links={selected?.key === candidate.key ? links : []}
                      onSelect={() => setSelected(candidate)}
                      onLink={() => {
                        setSelected(candidate);
                        setLinkOpened(true);
                      }}
                      onUnlink={(link) => {
                        void removeLink(candidate, link.site, link.username).then(setLinks);
                      }}
                      onAlias={() => void addAlias(candidate)}
                    />
                  ))
                )}
              </Stack>
            )}

            {selected && (
              <Text size="sm" c="dimmed">
                {t("Prep.Side.Label")} {colorLabel(mySide, t)} · {t("Prep.Side.Hint")}
              </Text>
            )}
            {building && (
              <Center p="md">
                <Group gap="xs">
                  <Loader size="sm" />
                  <Text size="sm">{t("Prep.Building")}</Text>
                </Group>
              </Center>
            )}
            {buildError && (
              <Alert color="red" title={t("Prep.BuildError")}>
                {buildError}
              </Alert>
            )}
            {briefing && (
              <>
                {briefing.games === 0 && <Alert color="gray">{t("Prep.NoGames")}</Alert>}
                <OverviewSection briefing={briefing} />
                <OpeningTreeSection briefing={briefing} onPreview={setPreview} />
                <LeaveTheorySection briefing={briefing} onPreview={setPreview} />
                <StyleSection briefing={briefing} />
                <ClashSection
                  briefing={briefing}
                  pack={pack}
                  onPreview={setPreview}
                  onPin={(row) => void pin(row)}
                />
              </>
            )}
            {pack && selected && (
              <PackSection
                pack={pack}
                onDeadline={(d) => void changeDeadline(d)}
                onUnpin={(epd) => void unpin(epd)}
                onPreview={setPreview}
              />
            )}
          </Stack>
        </ScrollArea>

        <Box w={280} style={{ flex: "none" }} data-chessin-prep-preview>
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              {preview?.title ?? t("Prep.Preview")}
            </Text>
            {preview ? (
              <MiniBoard
                fen={preview.fen}
                lastMove={preview.lastMove}
                orientation={mySide}
                size={280}
              />
            ) : (
              <Text size="xs" c="dimmed">
                {t("Prep.Preview.Hint")}
              </Text>
            )}
          </Stack>
        </Box>
      </Group>

      {selected && (
        <LinkAccountModal
          candidate={selected}
          opened={linkOpened && canScoutOnline(selected)}
          onClose={() => setLinkOpened(false)}
          onLinked={setLinks}
        />
      )}
    </Stack>
  );
}
