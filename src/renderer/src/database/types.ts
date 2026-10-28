// Shared types for the database UI, mirroring the main-process GameDatabase API.

export type { BookMove } from '@shared/chess/polyglotBook'

export interface BookLoadResult {
  success: boolean
  name?: string
  entries?: number
  error?: string
}

export interface BookExportResult {
  success: boolean
  path?: string
  entries?: number
  canceled?: boolean
  error?: string
}

export interface DbGame {
  id: number
  white: string
  black: string
  result: string
  date: string
  event?: string
  eco?: string
  whiteElo?: string
  blackElo?: string
  ply?: number
  pgn?: string
}

export interface SearchParams {
  white?: string
  black?: string
  ignoreColors?: boolean
  result?: string
  eco?: string
  event?: string
  dateFrom?: string
  dateTo?: string
  minElo?: number
  limit?: number
  offset?: number
}

export interface SearchResult {
  games: DbGame[]
  total: number
}

export interface OpeningMove {
  move: string
  count: number
  whiteWins: number
  draws: number
  blackWins: number
}

export interface PositionStats {
  total: number
  whiteWins: number
  draws: number
  blackWins: number
  moves: OpeningMove[]
}

export interface OpenResult {
  success: boolean
  count?: number
  name?: string
  dbPath?: string
  imported?: boolean
  error?: string
}
