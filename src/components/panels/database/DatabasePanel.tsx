import { Alert, Anchor, Group, ScrollArea, Stack, Tabs, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import type { NormalizedGame } from "@/bindings";
import { explorerViaIndex } from "@/chessin/search/explorer";
import { IndexChip } from "@/chessin/search/IndexChip";
import { isIndexAvailable, useIndexState } from "@/chessin/search/index";
import { indexFallbackReason } from "@/chessin/search/mapping";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import {
  isOfflineError,
  isRateLimitError,
  isStaleRequestError,
  OfflineError,
} from "@/chessin/sources/lichessQueue";
import { SourceChip } from "@/chessin/sources/SourceChip";
import { useResolvedSource } from "@/chessin/sources/sources";
import { useRateLimitedUntil } from "@/chessin/sources/useLichessQueue";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  currentDbTabAtom,
  currentLocalOptionsAtom,
  currentTabAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  sessionsAtom,
} from "@/state/atoms";
import { getDatabases, type Opening, searchPosition } from "@/utils/db";
import { formatNumber } from "@/utils/format";
import { convertToNormalized, getLichessGames, getMasterGames } from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import DatabaseLoader from "./DatabaseLoader";
import GamesTable from "./GamesTable";
import OpeningsTable from "./OpeningsTable";
import LichessOptionsPanel from "./options/LichessOptionsPanel";
import LocalOptionsPanel from "./options/LocalOptionsPanel";
import MasterOptionsPanel from "./options/MastersOptionsPanel";

// Chessin (IA-3 v0): the source chip replaces En Croissant's segmented control
// plus hidden reference-database flag. The explorer always has a source
// (default: anonymous Lichess Masters), so nothing here blocks on configuration.

type ExplorerQuery =
  | {
      type: "local";
      tab: string;
      options: LocalOptions;
      /** S3-2: answer from the position index instead of `search_position`. */
      index: boolean;
    }
  | {
      type: "lichess";
      tab: string;
      options: LichessGamesOptions;
      fen: string;
      token: string;
    }
  | {
      type: "lichess-masters";
      tab: string;
      options: MasterGamesOptions;
      fen: string;
      token: string;
    };

type ExplorerData = {
  openings: Opening[];
  games: NormalizedGame[];
  /** S3-2: lookup time when the index answered (shown on the index chip). */
  indexMs?: number;
};

export type LocalOptions = {
  path: string | null;
  fen: string;
  type: "exact" | "partial";
  player: number | null;
  color: "white" | "black";
  start_date?: string;
  end_date?: string;
  result: "any" | "whitewon" | "draw" | "blackwon";
};

function sortOpenings(openings: Opening[]) {
  return openings.sort((a, b) => b.black + b.draw + b.white - (a.black + a.draw + a.white));
}

function toOpenings(data: {
  moves: { san: string; white: number; black: number; draws: number }[];
}) {
  return data.moves.map((move) => ({
    move: move.san,
    white: move.white,
    black: move.black,
    draw: move.draws,
  }));
}

async function fetchOpening(query: ExplorerQuery): Promise<ExplorerData> {
  return match(query)
    .with({ type: "lichess" }, async ({ fen, options, token, tab }) => {
      const data = await getLichessGames(fen, options, token, tab);
      if (!data) throw new OfflineError();
      return {
        openings: toOpenings(data),
        games: await convertToNormalized(data.topGames || data.recentGames || [], { lane: tab }),
      };
    })
    .with({ type: "lichess-masters" }, async ({ fen, options, token, tab }) => {
      const data = await getMasterGames(fen, options, token, tab);
      if (!data) throw new OfflineError();
      return {
        openings: toOpenings(data),
        games: await convertToNormalized(data.topGames || data.recentGames || [], {
          lane: tab,
          masters: true,
        }),
      };
    })
    .with({ type: "local" }, async ({ options, tab, index }) => {
      if (!options.path) return { openings: [], games: [] };
      if (index) {
        // S3-2: the position index serves exact queries within its depth.
        const data = await explorerViaIndex({ ...options, path: options.path });
        return { openings: data.openings, games: data.games, indexMs: data.indexMs };
      }
      const positionData = await searchPosition(options, tab);
      return {
        openings: sortOpenings(positionData[0]),
        games: positionData[1],
      };
    })
    .exhaustive();
}

function DatabasePanel() {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.currentNode().fen);
  const tab = useAtomValue(currentTabAtom);
  const tabId = tab?.value ?? "";
  const { source } = useResolvedSource(tabId);
  const sessions = useAtomValue(sessionsAtom);
  const offline = useAtomValue(offlineModeAtom);
  const rateLimitedUntil = useRateLimitedUntil();
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const [localOptions, setLocalOptions] = useAtom(currentLocalOptionsAtom);
  const [tabType, setTabType] = useAtom(currentDbTabAtom);
  // Optional: a logged-in account only raises Lichess's rate limit.
  const explorerToken =
    sessions.find((session) => session.lichess?.accessToken)?.lichess?.accessToken ?? "";

  const isLocal = source.kind === "local";
  const isOnline = source.kind === "lichess" || source.kind === "lichess-masters";
  const localPath = source.kind === "local" ? source.path : null;

  const { data: databases } = useSWR(isLocal ? "databases" : null, () => getDatabases());
  const localMissing =
    isLocal && databases !== undefined && !databases.some((d) => d.file === localPath);
  // S3-2: the index answers exact queries within its depth; everything else
  // (partial match, player filter, dates that cut a year) stays on `search_position`.
  const { state: indexState } = useIndexState(localPath);
  const indexReason = indexFallbackReason(localOptions, indexState, isIndexAvailable());

  useEffect(() => {
    if (isLocal) {
      setLocalOptions((q) => ({ ...q, fen: debouncedFen }));
    }
  }, [debouncedFen, setLocalOptions, isLocal]);

  // Keep the per-tab local options (used by LocalOptionsPanel) on the chip's database.
  useEffect(() => {
    setLocalOptions((q) => (q.path === localPath ? q : { ...q, path: localPath }));
  }, [localPath, setLocalOptions]);

  let query: ExplorerQuery | null = null;
  if (source.kind === "local") {
    if (!localMissing) {
      query = {
        type: "local",
        tab: tabId,
        options: { ...localOptions, path: source.path },
        index: indexReason === null,
      };
    }
  } else if (source.kind === "lichess") {
    query = {
      type: "lichess",
      tab: tabId,
      fen: debouncedFen,
      token: explorerToken,
      options: {
        ...lichessOptions,
        ...(source.ratings ? { ratings: source.ratings as LichessGamesOptions["ratings"] } : {}),
        ...(source.speeds ? { speeds: source.speeds as LichessGamesOptions["speeds"] } : {}),
      },
    };
  } else if (source.kind === "lichess-masters") {
    query = {
      type: "lichess-masters",
      tab: tabId,
      fen: debouncedFen,
      token: explorerToken,
      options: masterOptions,
    };
  }

  const paused = isOnline && offline;
  const shouldFetch = query !== null && tabType !== "options" && !paused;

  const {
    data: openingData,
    isLoading,
    error,
  } = useSWR(shouldFetch ? query : null, fetchOpening, {
    onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
      // Superseded / offline / throttled requests are resolved by the next user action.
      if (isStaleRequestError(err) || isOfflineError(err) || isRateLimitError(err)) return;
      if (retryCount >= 3) return;
      setTimeout(() => revalidate({ retryCount }), 5000 * 2 ** retryCount);
    },
  });

  const grandTotal = openingData?.openings?.reduce(
    (acc, curr) => acc + curr.black + curr.white + curr.draw,
    0,
  );

  let notice: React.ReactNode = null;
  if (paused || (error && isOfflineError(error))) {
    notice = (
      <Text c="dimmed" fz="sm">
        {t("Sources.Offline")}
      </Text>
    );
  } else if (localMissing) {
    notice = (
      <Text c="dimmed" fz="sm">
        {t("Sources.LocalMissing")}{" "}
        <Anchor component={Link} to="/databases" fz="sm">
          {t("Sources.ManageCollections")}
        </Anchor>
      </Text>
    );
  } else if (source.kind === "chessdb") {
    notice = (
      <Text c="dimmed" fz="sm">
        {t("Sources.Unsupported")}
      </Text>
    );
  } else if (error && isRateLimitError(error)) {
    notice = <Alert color="yellow">{t("Sources.RateLimitExceeded")}</Alert>;
  } else if (error && !isLocal && !isStaleRequestError(error)) {
    // Local search errors are already reported through notifications.
    notice = <Alert color="red">{error.toString()}</Alert>;
  }

  const header = (
    <>
      <Group justify="space-between" w="100%" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <SourceChip tabId={tabId} />
          {isLocal && localPath && !localMissing && (
            <IndexChip
              dbPath={localPath}
              used={indexReason === null && openingData?.indexMs !== undefined}
              reason={indexReason}
              ms={openingData?.indexMs}
            />
          )}
        </Group>

        {tabType !== "options" && (
          <Text style={{ whiteSpace: "nowrap" }}>
            {t("Board.Database.Matches", {
              matches: formatNumber(Math.max(grandTotal || 0, openingData?.games.length || 0)),
            })}
          </Text>
        )}
      </Group>
      <DatabaseLoader isLoading={isLoading} tab={tabId || null} />
      {isOnline && rateLimitedUntil !== null && (
        <Text c="yellow" fz="xs" mt={4}>
          {t("Sources.RateLimited")}
        </Text>
      )}
    </>
  );

  return (
    <Stack h="100%" gap={0}>
      <Tabs
        defaultValue="stats"
        orientation="vertical"
        placement="right"
        value={tabType}
        onChange={(v) => setTabType(v!)}
        display="flex"
        flex={1}
        style={{ overflow: "hidden" }}
      >
        <Tabs.List>
          <Tabs.Tab value="stats" disabled={isLocal && localOptions.type === "partial"}>
            {t("Board.Database.Stats")}
          </Tabs.Tab>
          <Tabs.Tab value="games">{t("Board.Database.Games")}</Tabs.Tab>
          <Tabs.Tab value="options">{t("Board.Database.Options")}</Tabs.Tab>
        </Tabs.List>

        <Panel value="stats" header={header} notice={notice}>
          <OpeningsTable openings={openingData?.openings || []} loading={isLoading} />
        </Panel>
        <Panel value="games" header={header} notice={notice}>
          <GamesTable
            games={openingData?.games || []}
            loading={isLoading}
            databasePath={localPath}
          />
        </Panel>
        <Panel value="options" header={header} notice={null}>
          <ScrollArea flex={1} offsetScrollbars pt="sm">
            {match(source.kind)
              .with("local", () => <LocalOptionsPanel boardFen={debouncedFen} />)
              .with("lichess", () => <LichessOptionsPanel />)
              .with("lichess-masters", () => <MasterOptionsPanel />)
              .with("chessdb", () => null)
              .exhaustive()}
          </ScrollArea>
        </Panel>
      </Tabs>
    </Stack>
  );
}

function Panel(props: {
  value: string;
  header: React.ReactNode;
  /** Replaces the content when the source cannot deliver (offline, missing, throttled, error). */
  notice: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Panel
      py="xs"
      px="sm"
      value={props.value}
      flex={1}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {props.header}
      {props.notice ?? props.children}
    </Tabs.Panel>
  );
}

export default memo(DatabasePanel);
