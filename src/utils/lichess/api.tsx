import type { Color } from "@lichess-org/chessground/types";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { resolve } from "@tauri-apps/api/path";
import { fetch } from "@tauri-apps/plugin-http";
import { error } from "@tauri-apps/plugin-log";
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import i18n from "i18next";
import { getDefaultStore } from "jotai";
import { match, P } from "ts-pattern";
import {
  type BestMoves,
  commands,
  type EngineOptions,
  type GoMode,
  type NormalizedGame,
} from "@/bindings";
import { offlineModeAtom } from "@/chessin/shell/offlineAtom";
import {
  isOfflineError,
  isRateLimitError,
  isStaleRequestError,
  lichessQueue,
  OfflineError,
  RateLimitError,
  type RequestQueue,
  tablebaseQueue,
} from "@/chessin/sources/lichessQueue";
import { parsePGN, uciNormalize } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { apiHeaders } from "@/utils/http";
import {
  getLichessGamesQueryParams,
  getMasterGamesQueryParams,
  type LichessGamesOptions,
  type MasterGamesOptions,
} from "@/utils/lichess/explorer";
import { countMainPly } from "@/utils/treeReducer";
import { getDatabasesDir } from "../directories";

const baseURL = "https://lichess.org/api";
const explorerURL = "https://explorer.lichess.org";
const tablebaseURL = "https://tablebase.lichess.org";

export const MIN_DATE = new Date(1952, 0, 1);

/** Default queue lane for explorer requests when the caller has no tab id. */
export const EXPLORER_LANE = "explorer";
const CLOUD_EVAL_LANE = "cloud-eval";
const TABLEBASE_LANE = "tablebase";

/**
 * Chessin: outbound traffic is off while offline mode is on. The atom is
 * hydrated when the status bar mounts; before that read what it persisted.
 */
function isOffline(): boolean {
  try {
    if (getDefaultStore().get(offlineModeAtom)) return true;
    return localStorage.getItem("chessin.offline") === "true";
  } catch {
    return false;
  }
}

type QueuedFetchOptions = {
  /** Lane of the serial queue; a `supersede` request replaces older ones of its lane. */
  lane?: string | null;
  supersede?: boolean;
  queue?: RequestQueue;
  init?: RequestInit;
};

/**
 * Fetch through the serial Lichess queue (one request at a time, 429 → wait
 * 60 s and retry once). Returns null in offline mode without touching the
 * network; throws `RateLimitError` when the retry is throttled too and
 * `StaleRequestError` when a newer request of the same lane replaced this one.
 */
async function queuedFetch(
  url: string,
  { lane = null, supersede = false, queue = lichessQueue, init }: QueuedFetchOptions = {},
): Promise<Response | null> {
  if (isOffline()) return null;
  let res: Response;
  try {
    res = await queue.enqueue(
      lane,
      (signal) => {
        if (isOffline()) throw new OfflineError();
        return fetch(url, { ...init, signal });
      },
      { supersede },
    );
  } catch (e) {
    if (isOfflineError(e)) return null;
    throw e;
  }
  if (res.status === 429) throw new RateLimitError();
  return res;
}

function bearer(token?: string): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export type TablebaseCategory =
  | "win"
  | "unknown"
  | "maybe-win"
  | "cursed-win"
  | "draw"
  | "blessed-loss"
  | "maybe-loss"
  | "loss";

type TablebaseData = {
  checkmate: boolean;
  stalemate: boolean;
  variant_win: boolean;
  variant_loss: boolean;
  insufficient_material: boolean;
  dtz: number;
  precise_dtz: number;
  dtm: number;
  category: TablebaseCategory;
  moves: TablebaseMove[];
};

export type TablebaseMove = {
  uci: string;
  san: string;
  zeroing: boolean;
  checkmate: boolean;
  stalemate: boolean;
  variant_win: boolean;
  variant_loss: boolean;
  insufficient_material: boolean;
  dtz: number;
  precise_dtz: number;
  dtm: number;
  category: TablebaseCategory;
};

type LichessPerf = {
  games: number;
  rating: number;
  rd: number;
  prog: number;
  prov: boolean;
};

export type LichessAccount = {
  id: string;
  username: string;
  perfs?: {
    chess960?: LichessPerf;
    atomic?: LichessPerf;
    racingKings?: LichessPerf;
    ultraBullet?: LichessPerf;
    blitz?: LichessPerf;
    kingOfTheHill?: LichessPerf;
    bullet?: LichessPerf;
    correspondence?: LichessPerf;
    horde?: LichessPerf;
    puzzle?: LichessPerf;
    classical?: LichessPerf;
    rapid?: LichessPerf;
    storm?: {
      runs: number;
      score: number;
    };
  };
  createdAt: number;
  disabled: boolean;
  tosViolation: boolean;
  profile: {
    country: string;
    location: string;
    bio: string;
    firstName: string;
    lastName: string;
    fideRating: number;
    uscfRating: number;
    ecfRating: number;
    links: string;
  };
  seenAt: number;
  patron: boolean;
  verified: boolean;
  playTime: {
    total: number;
    tv: number;
  };
  title: string;
  url: string;
  playing: string;
  completionRate: number;
  count: {
    all: number;
    rated: number;
    ai: number;
    draw: number;
    drawH: number;
    loss: number;
    lossH: number;
    win: number;
    winH: number;
    bookmark: number;
    playing: number;
    import: number;
    me: number;
  };
  streaming: boolean;
  followable: boolean;
  following: boolean;
  blocking: boolean;
  followsYou: boolean;
};

type PositionGames = {
  uci: string;
  id: string;
  winner: string | null;
  speed: string;
  mode: string;
  black: {
    name: string;
    rating: number;
  };
  white: {
    name: string;
    rating: number;
  };
  year: number;
  month: string;
}[];

/**
 * Downloads the PGN of each explorer game and normalises it. Exports go
 * through the queue on `lane` (one at a time); if a newer request of that
 * lane supersedes them, or offline mode kicks in, the whole batch rejects so
 * callers never cache a partial result.
 */
export async function convertToNormalized(
  data: PositionGames,
  { lane, masters = false }: { lane?: string; masters?: boolean } = {},
): Promise<NormalizedGame[]> {
  const results = await Promise.allSettled(
    data.map(async (game, i) => {
      const pgn = await getLichessGame(game.id, { masters, lane });
      const { headers, root } = await parsePGN(pgn);
      const normalized: NormalizedGame = {
        ...headers,
        id: i,
        white_id: 0,
        black_id: 0,
        event_id: 0,
        site_id: 0,
        moves: pgn,
        ply_count: countMainPly(root),
      };
      return normalized;
    }),
  );
  for (const r of results) {
    if (r.status === "rejected" && (isStaleRequestError(r.reason) || isOfflineError(r.reason))) {
      throw r.reason;
    }
  }
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<NormalizedGame>).value);
}

type PositionData = {
  white: number;
  black: number;
  draws: number;
  moves: {
    uci: string;
    san: string;
    averageRating: number;
    white: number;
    black: number;
    draws: number;
  }[];
  recentGames?: PositionGames;
  topGames?: PositionGames;
};

export async function getLichessAccount({
  token,
  username,
}: {
  token?: string;
  username?: string;
}): Promise<LichessAccount | null> {
  if (isOffline()) {
    notifications.show({
      title: "Lichess",
      message: i18n.t("Sources.Offline"),
      color: "gray",
    });
    return null;
  }
  let response: Response;
  if (token) {
    response = await fetch(`${baseURL}/account`, {
      method: "GET",
      headers: apiHeaders({ Authorization: `Bearer ${token}` }),
    });
  } else {
    const url = `${baseURL}/user/${username}`;
    response = await fetch(url, { headers: apiHeaders() });
  }
  if (!response.ok) {
    error(`Failed to fetch Lichess account: ${response.status} ${response.url}`);
    notifications.show({
      title: "Failed to fetch Lichess account",
      message: `Could not find account "${username}" on lichess.org`,
      color: "red",
      icon: <IconX />,
    });
    return null;
  }
  return response.json();
}

export async function getBestMoves(
  _tab: string,
  _goMode: GoMode,
  options: EngineOptions,
): Promise<[number, BestMoves[]] | null> {
  const [pos] = positionFromFen(options.fen);
  if (!pos) {
    return null;
  }
  for (const uci of options.moves) {
    const m = parseUci(uci);
    if (!m) {
      return null;
    }
    pos.play(m);
  }
  let data: LichessCloudData | null;
  try {
    data = await getCloudEvaluation(
      makeFen(pos.toSetup()),
      Number.parseInt(options.extraOptions.find((o) => o.name === "MultiPV")?.value ?? "1"),
    );
  } catch (e) {
    // Superseded by a newer position, or throttled: nothing to show for this one.
    if (isStaleRequestError(e) || isRateLimitError(e)) return null;
    throw e;
  }
  if (!data) return null;
  return [
    100,
    data.pvs?.map((m, i) => {
      const uciMoves = m.moves.split(" ");
      const posCopy = pos.clone();
      const normalizedUciMoves: string[] = [];

      const sanMoves = uciMoves.map((m) => {
        const move = parseUci(m)!;
        const san = makeSan(posCopy, move);
        normalizedUciMoves.push(uciNormalize(posCopy, move));
        posCopy.play(move);
        return san;
      });

      return {
        score: {
          value: "cp" in m ? { type: "cp", value: m.cp } : { type: "mate", value: m.mate },
          wdl: null,
        },
        nodes: data.knodes * 1000,
        depth: data.depth,
        multipv: i + 1,
        nps: 0,
        sanMoves,
        uciMoves: normalizedUciMoves,
      };
    }) ?? [],
  ];
}

const cache = new Map<string, LichessCloudData>();

type LichessCloudData = {
  fen: string;
  knodes: number;
  depth: number;
  pvs: (LichessCp | LichessMate)[];
};

type LichessCp = {
  cp: number;
  moves: string;
};

type LichessMate = {
  mate: number;
  moves: string;
};

async function getCloudEvaluation(fen: string, multipv: number): Promise<LichessCloudData | null> {
  const cacheKey = `${fen}-${multipv}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  const url = new URL(`${baseURL}/cloud-eval`);
  url.searchParams.append("fen", fen);
  url.searchParams.append("multiPv", multipv.toString());

  const response = await queuedFetch(url.toString(), {
    lane: CLOUD_EVAL_LANE,
    supersede: true,
    init: { headers: apiHeaders() },
  });
  if (!response) return null;
  const data = (await response.json()) as LichessCloudData;
  cache.set(cacheKey, data);
  return data;
}

/**
 * Lichess games explorer. No login needed; a token only raises the rate
 * limit. Returns null in offline mode. `lane` (usually the tab id) lets a
 * newer request for the same tab replace this one.
 */
export async function getLichessGames(
  fen: string,
  options: LichessGamesOptions,
  token?: string,
  lane: string = EXPLORER_LANE,
): Promise<PositionData | null> {
  const url = match(options.player)
    .with(
      P.union(undefined, ""),
      () => `${explorerURL}/lichess?${getLichessGamesQueryParams(fen, options)}`,
    )
    .otherwise(() => `${explorerURL}/player?${getLichessGamesQueryParams(fen, options)}`);
  const res = await queuedFetch(url, {
    lane,
    supersede: true,
    init: { headers: apiHeaders(bearer(token)) },
  });
  if (!res) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch Lichess games: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

/** Lichess Masters explorer; anonymous. See `getLichessGames`. */
export async function getMasterGames(
  fen: string,
  options: MasterGamesOptions,
  token?: string,
  lane: string = EXPLORER_LANE,
): Promise<PositionData | null> {
  const url = `${explorerURL}/masters?${getMasterGamesQueryParams(fen, options)}`;
  const res = await queuedFetch(url, {
    lane,
    supersede: true,
    init: { headers: apiHeaders(bearer(token)) },
  });
  if (!res) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch master games: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function getPlayerGames(
  fen: string,
  player: string,
  color: Color,
  token?: string,
  lane: string = EXPLORER_LANE,
) {
  const res = await queuedFetch(
    `${explorerURL}/player?fen=${fen}&player=${player}&color=${color}`,
    {
      lane,
      supersede: true,
      init: { headers: apiHeaders(bearer(token)) },
    },
  );
  if (!res) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch player games: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function downloadLichess(
  player: string,
  timestamp: number | null,
  games: number,
  setProgress: (progress: number) => void,
  token?: string,
) {
  let url = `${baseURL}/games/user/${player}?perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence&rated=true&sort=dateAsc`;
  if (timestamp) {
    url += `&since=${timestamp}`;
  }
  const path = await resolve(await getDatabasesDir(), `${player}_lichess.pgn`);

  await commands.downloadFile(
    `lichess_${player}`,
    url,
    path,
    token ?? null,
    null,
    games > 0 ? games * 900 : null, // approx. size of a game
    null,
  );
}

/**
 * PGN of one game. Masters explorer ids are served by the explorer
 * (`/masters/pgn/{id}`), not by lichess.org's game export.
 */
export async function getLichessGame(
  gameId: string,
  { masters = false, lane = null }: { masters?: boolean; lane?: string | null } = {},
): Promise<string> {
  const url = masters
    ? `${explorerURL}/masters/pgn/${gameId}`
    : `https://lichess.org/game/export/${gameId.slice(0, 8)}`;
  const response = await queuedFetch(url, { lane, init: { headers: apiHeaders() } });
  if (!response) {
    throw new OfflineError();
  }
  if (!response.ok) {
    throw new Error(`Failed to load lichess game ${gameId} - ${response.statusText}`);
  }
  return await response.text();
}

/** Returns null in offline mode. */
export async function getTablebaseInfo(fen: string): Promise<TablebaseData | null> {
  const res = await queuedFetch(`${tablebaseURL}/standard?fen=${fen}`, {
    lane: TABLEBASE_LANE,
    queue: tablebaseQueue,
    init: { headers: apiHeaders() },
  });
  if (!res) return null;
  if (!res.ok) {
    throw new Error(`Failed to load tablebase info for ${fen}.`);
  }
  return res.json();
}

export async function getFidePlayer(query: string) {
  if (isOffline()) {
    throw new Error(i18n.t("Sources.Offline"));
  }
  if (!Number.isNaN(Number(query))) {
    const res = await fetch(`${baseURL}/fide/player/${query}`, {
      headers: apiHeaders({
        Accept: "application/json",
      }),
    });
    if (res.ok) {
      return await res.json();
    }
  } else {
    const res = await fetch(`${baseURL}/fide/player?q=${query}`, {
      headers: apiHeaders({
        Accept: "application/json",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data[0];
    }
  }
  throw new Error("Player not found");
}
