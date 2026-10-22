import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Chip,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { useHotkeys } from "react-hotkeys-hook";
import useSWR from "swr";
import MiniBoard from "@/chessin/board/MiniBoard";
import { typingGuardOptions } from "@/chessin/keymap/guard";
import { getActiveTreeStore } from "@/chessin/keymap/treeStores";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import {
  isOfflineError,
  isRateLimitError,
  isStaleRequestError,
} from "@/chessin/sources/lichessQueue";
import { SourceChip } from "@/chessin/sources/SourceChip";
import { useResolvedSource } from "@/chessin/sources/sources";
import { useOpenInWorkspace } from "@/chessin/workspace/openInWorkspace";
import { lichessOptionsAtom, masterOptionsAtom, sessionsAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { mainLinePathToPly, reduceFen } from "./fen";
// Side effect: registers the index job handler with the drawer's bundle.
import "./index";
import {
  closeSimilarDrawer,
  openSimilarDrawer,
  similarDrawerAtom,
  similarFiltersAtom,
  similarModeAtom,
  toggleSimilarDrawer,
} from "./drawerAtom";
import { formatSummary, type SimilarFilters } from "./mapping";
import type { SimilarMode } from "./replay";
import {
  fetchSimilar,
  type SimilarQuery,
  type SimilarResult,
  type SimilarRow,
  similarUnavailableKey,
} from "./similar";

/** The Elo chip's threshold. */
export const MIN_ELO_CHIP = 2300;
const YEAR_CHOICES = [2020, 2015, 2010, 2000];
const DRAWER_WIDTH = 520;

/**
 * `mod+f` on a board tab toggles the drawer. It goes through the typing
 * guard, so inside inputs / the rich-text editor the webview's own find
 * keeps working, and it is a no-op (no preventDefault) when no board is
 * mounted.
 */
export function useFindSimilarHotkey(): void {
  const keyMap = useAtomValue(keyMapAtom);
  const keys = keyMap.FIND_SIMILAR?.keys?.trim() ?? "";
  useHotkeys(
    keys || "mod+f",
    (e) => {
      if (!getActiveTreeStore()) return;
      e.preventDefault();
      toggleSimilarDrawer();
    },
    { ...typingGuardOptions, enabled: keys !== "" },
    [keys],
  );
}

export default function SimilarDrawer() {
  const { t } = useTranslation();
  const [state] = useAtom(similarDrawerAtom);
  return (
    <Drawer
      opened={state.open}
      onClose={() => closeSimilarDrawer()}
      position="right"
      size={DRAWER_WIDTH}
      title={t("Search.Title")}
      padding="md"
      data-testid="similar-drawer"
    >
      {state.open && state.fen && <SimilarBody fen={state.fen} tabId={state.tabId ?? ""} />}
    </Drawer>
  );
}

function SimilarBody({ fen, tabId }: { fen: string; tabId: string }) {
  const { t } = useTranslation();
  const { source } = useResolvedSource(tabId);
  const [mode, setMode] = useAtom(similarModeAtom);
  const [filters, setFilters] = useAtom(similarFiltersAtom);
  const sessions = useAtomValue(sessionsAtom);
  const offline = useAtomValue(offlineModeAtom);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const token =
    sessions.find((session) => session.lichess?.accessToken)?.lichess?.accessToken ?? "";

  const isOnline = source.kind === "lichess" || source.kind === "lichess-masters";
  const unavailable = similarUnavailableKey(source, mode);
  const paused = isOnline && offline;

  const query: SimilarQuery | null =
    unavailable || paused
      ? null
      : {
          kind: "similar",
          mode,
          fen,
          source,
          filters,
          lane: `similar:${tabId}`,
          token,
          lichessOptions,
          masterOptions,
        };

  const { data, error, isLoading } = useSWR(query, fetchSimilar, {
    revalidateOnFocus: false,
    onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
      if (isStaleRequestError(err) || isOfflineError(err) || isRateLimitError(err)) return;
      if (retryCount >= 2) return;
      setTimeout(() => revalidate({ retryCount }), 4000 * 2 ** retryCount);
    },
  });

  const queryFen = mode === "position" ? fen : (reduceFen(fen, "pawns") ?? fen);

  let notice: React.ReactNode = null;
  if (paused || (error && isOfflineError(error))) {
    notice = (
      <Text c="dimmed" fz="sm">
        {t("Sources.Offline")}
      </Text>
    );
  } else if (unavailable) {
    notice = (
      <Text c="dimmed" fz="sm">
        {t(unavailable)}
      </Text>
    );
  } else if (error && isRateLimitError(error)) {
    notice = <Alert color="yellow">{t("Sources.RateLimitExceeded")}</Alert>;
  } else if (error && !isStaleRequestError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    notice = (
      <Alert color="red">
        {t("Search.Error", { error: t(message, { defaultValue: message }) })}
      </Alert>
    );
  }

  return (
    <Stack gap="sm" h="100%">
      <Group gap="xs" wrap="wrap">
        <SourceChip tabId={tabId} />
        <Tooltip label={t("Search.Current")} openDelay={400}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label={t("Search.Current")}
            onClick={() => openSimilarDrawer()}
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Tabs value={mode} onChange={(v) => setMode((v as SimilarMode | null) ?? "position")}>
        <Tabs.List>
          <Tabs.Tab value="position">{t("Search.Tab.SamePosition")}</Tabs.Tab>
          <Tabs.Tab value="pawns">{t("Search.Tab.SamePawns")}</Tabs.Tab>
          <Tabs.Tab value="pawnsMaterial">{t("Search.Tab.PawnsMaterial")}</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <Group align="flex-start" wrap="nowrap" gap="md">
        <MiniBoard fen={queryFen} size={140} coordinates={false} />
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <FilterChips filters={filters} onChange={setFilters} />
          {isOnline && (
            <Text fz="xs" c="dimmed">
              {t("Search.Filters.OnlineNote")}
            </Text>
          )}
          <Text fz="xs" c="dimmed">
            {t("Search.MaskEditorSoon")}
          </Text>
        </Stack>
      </Group>

      {notice ?? (
        <SummaryLine data={data} loading={isLoading || (query !== null && !data && !error)} />
      )}

      <ScrollArea style={{ flex: 1, minHeight: 0 }} offsetScrollbars>
        <Stack gap="xs">
          {!notice && data?.rows.map((row) => <GameRow key={row.key} row={row} />)}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function FilterChips({
  filters,
  onChange,
}: {
  filters: SimilarFilters;
  onChange: (next: SimilarFilters) => void;
}) {
  const { t } = useTranslation();
  const yearData = [
    { value: "", label: t("Search.Filter.YearAny") },
    ...YEAR_CHOICES.map((year) => ({
      value: String(year),
      label: t("Search.Filter.YearFrom", { year }),
    })),
  ];
  return (
    <Group gap="xs" wrap="wrap">
      <Chip
        size="xs"
        checked={filters.minElo !== null}
        onChange={(checked) => onChange({ ...filters, minElo: checked ? MIN_ELO_CHIP : null })}
      >
        {t("Search.Filter.MinElo", { elo: MIN_ELO_CHIP })}
      </Chip>
      <Chip
        size="xs"
        checked={filters.decisiveOnly}
        onChange={(checked) => onChange({ ...filters, decisiveOnly: checked })}
      >
        {t("Search.Filter.Decisive")}
      </Chip>
      <Select
        size="xs"
        w={130}
        aria-label={t("Search.Filter.Year")}
        data={yearData}
        value={filters.yearFrom === null ? "" : String(filters.yearFrom)}
        onChange={(value) =>
          onChange({ ...filters, yearFrom: value ? Number.parseInt(value, 10) : null })
        }
        allowDeselect={false}
      />
    </Group>
  );
}

function SummaryLine({ data, loading }: { data: SimilarResult | undefined; loading: boolean }) {
  const { t } = useTranslation();
  if (loading && !data) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text fz="sm" c="dimmed">
          {t("Search.Loading")}
        </Text>
      </Group>
    );
  }
  if (!data) return null;
  // t("Search.Via.Index") t("Search.Via.Scan") t("Search.Via.Lichess")
  const viaKey =
    data.via === "index"
      ? "Search.Via.Index"
      : data.via === "scan"
        ? "Search.Via.Scan"
        : "Search.Via.Lichess";
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        <Text fz="sm" fw={600} style={{ flex: 1, minWidth: 0 }} data-testid="similar-summary">
          {formatSummary(data.summary, t)}
        </Text>
        <Badge size="xs" variant="outline" color="gray" tt="none">
          {t(viaKey)}
        </Badge>
        {loading && <Loader size="xs" />}
      </Group>
      {data.sample && (
        <Text fz="xs" c="dimmed">
          {t("Search.Sample", data.sample)}
          {data.approximate ? ` · ${t("Search.Approximate")}` : ""}
        </Text>
      )}
    </Stack>
  );
}

function elo(value: number | null | undefined, t: (key: string) => string): string {
  return value && value > 0 ? String(value) : t("Search.Unrated");
}

function GameRow({ row }: { row: SimilarRow }) {
  const { t } = useTranslation();
  const openInWorkspace = useOpenInWorkspace();
  const { game } = row;
  const open = () =>
    openInWorkspace({
      tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
      pgn: game.moves,
      headers: game,
      position: mainLinePathToPly(row.ply),
      gameOrigin: row.database
        ? { kind: "database", database: row.database, gameId: game.id }
        : undefined,
    });
  const meta = [game.result, game.date, game.event].filter((s) => s && s !== "" && s !== "?");
  return (
    <Card withBorder padding="xs" data-testid="similar-row">
      <Group wrap="nowrap" align="flex-start" gap="sm">
        <MiniBoard fen={row.fen} size={112} coordinates={false} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text fz="sm" fw={600} truncate>
            {game.white} ({elo(game.white_elo, t)}) – {game.black} ({elo(game.black_elo, t)})
          </Text>
          <Text fz="xs" c="dimmed" truncate>
            {meta.join(" · ")}
          </Text>
          <Text fz="xs" c="dimmed">
            {t("Search.MatchedAt", { ply: row.ply })}
          </Text>
          <Group gap="xs" mt={4}>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconExternalLink size={12} />}
              onClick={() => void open()}
            >
              {t("Search.Open")}
            </Button>
          </Group>
        </Stack>
      </Group>
    </Card>
  );
}
