import type {
  BookExportOptions,
  GameRow,
  PositionStats,
  SearchParams,
  SearchResult
} from '../../shared/database/GameDatabase'
import type { WebOpenResult } from './host'

/** What the database worker can be asked, with what it answers. */
export interface DatabaseMethods {
  open(files: File[]): WebOpenResult
  search(params: SearchParams): SearchResult
  getGame(id: number): GameRow | null
  positionStats(fen: string): PositionStats
  positionGames(params: { fen: string; limit?: number; offset?: number }): SearchResult
  addGame(pgn: string): number
  deleteGame(id: number): void
  playerSuggest(prefix: string): string[]
  exportBook(opts?: BookExportOptions): Uint8Array | null
}

export type WorkerRequest = {
  [M in keyof DatabaseMethods]: { id: number; method: M; args: Parameters<DatabaseMethods[M]> }
}[keyof DatabaseMethods]

export type WorkerResponse =
  | { progress: number }
  | { id: number; result: unknown }
  | { id: number; error: string }
