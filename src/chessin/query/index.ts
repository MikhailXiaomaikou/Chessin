/**
 * S3-3: chip query bar + smart collections.
 *
 * - `parse`: free text → chips (English / Chinese keys, `> < ..`, quotes).
 * - `mapping`: chips → `GameQuery`; unsupported chips are returned, never sent.
 * - `describe`: natural-language preview and the zero-result removal hint.
 * - `smartCollections`: saved chip sets as library documents (`smart_collection`).
 * - `QueryBar` (games table) and `SmartCollectionCards` (databases page).
 */
export { getQueryChips, queryChipsAtomFamily, setQueryChips } from "./chipsState";
export { describeChip, describeChips, selectivity, suggestRemoval } from "./describe";
export {
    eloRange,
    isUnconstrained,
    type MappedQuery,
    NO_PLAYER_ID,
    type PlayerResolver,
    splitUnsupported,
    toGameQuery,
    type UnsupportedChip,
    yearBounds,
    yearToDates,
} from "./mapping";
export { findSmartCollectionDatabase, openSmartCollection } from "./openSmartCollection";
export {
    type Chip,
    type ChipKey,
    type ChipOp,
    CHIP_KEYS,
    formatChip,
    isChip,
    isSupportedKey,
    normalizeResult,
    type ParseError,
    type ParseResult,
    parseQuery,
    parseToken,
    sameChip,
    tokenize,
    UNSUPPORTED_KEYS,
} from "./parse";
export { QueryBar } from "./QueryBar";
export { createPlayerResolver, pickPlayer } from "./resolvePlayer";
export { SmartCollectionCards } from "./SmartCollectionCards";
export {
    deleteSmartCollection,
    listSmartCollections,
    loadSmartCollection,
    parseSmartCollectionData,
    saveSmartCollection,
    SMART_COLLECTION_KIND,
    type SmartCollection,
    type SmartCollectionData,
} from "./smartCollections";
