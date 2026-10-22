/**
 * Repertoire workbench v0 (S3-5): coverage, gaps, conflicts, cold shelf.
 *
 * Pure pieces (`model`, `coverage`, `gaps`, `conflicts`, `cold`, `lines`) have
 * no UI or Tauri dependency; `explorerCache` and `check` talk to the library
 * store and the Lichess queue; `RepertoireCheck` is the panel mounted in
 * `RepertoireInfo`, and `commands` registers the palette commands.
 */

export {
    cancelRepertoireCheck,
    type CheckState,
    type CheckStatus,
    type CheckSummary,
    checkStateFamily,
    isCheckRunning,
    loadLastCheck,
    restoreLastCheck,
    runRepertoireCheck,
} from "./check";
export {
    type ColdNode,
    type ColdShelf,
    type ColdShelfState,
    coldNodesAtom,
    findColdNodes,
    isColdNode,
} from "./cold";
export { type Conflict, type ConflictOccurrence, findConflicts, unifyConflict } from "./conflicts";
export {
    buildUserMoveIndex,
    computeCoverage,
    countOpponentNodes,
    type CoverageOptions,
    type CoverageResult,
    fenAfterUci,
    type GapCandidate,
    type StatsProvider,
} from "./coverage";
export {
    createExplorerCache,
    EXPLORER_CACHE_TTL_MS,
    type ExplorerCache,
    explorerCacheKey,
    explorerQueryFor,
    type ExplorerStats,
    getExplorerCache,
    normalizeExplorerStats,
} from "./explorerCache";
export { fillGap } from "./fill";
export {
    type Gap,
    gapThreshold,
    opponentExpectedScore,
    rankGaps,
    type Reply,
    topReplies,
} from "./gaps";
export { formatLine, formatLineWithMove, moveLabel } from "./lines";
export {
    defaultMeta,
    eloRangeAround,
    formatEloRange,
    inferDefaults,
    isUserTurn,
    lichessRatingsFor,
    lichessSpeedsFor,
    loadRepertoireMeta,
    parseMeta,
    REPERTOIRE_META_KIND,
    type RepertoireMeta,
    repertoireMetaId,
    saveRepertoireMeta,
    type TimeControl,
    toEpd,
    withDefaults,
} from "./model";
