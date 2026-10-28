import { createHash } from 'crypto'
import { existsSync, statSync, mkdirSync, rmSync } from 'fs'
import { basename, resolve, join } from 'path'
import { tmpdir } from 'os'
import {
  GameDatabase,
  type GameRow,
  type SearchParams,
  type SearchResult,
  type OpeningMove,
  type PositionStats
} from './GameDatabase'
import { readCbhIndex } from './CbhReader'
import { extractCbv } from './CbvReader'

// Re-exported for IPC/consumers (keeps the old type names available).
export type DatabaseGame = GameRow
export type DatabaseSearchParams = SearchParams

export interface OpenResult {
  count: number
  name: string
  dbPath: string
  /** True when a PGN/CBH had to be imported into a fresh index this time. */
  imported: boolean
}

type ProgressFn = (count: number) => void

const EMPTY_STATS: PositionStats = {
  total: 0,
  whiteWins: 0,
  draws: 0,
  blackWins: 0,
  moves: []
}

/**
 * Owns the currently open {@link GameDatabase} and decides how to get one from a
 * file path. PGN and ChessBase files are imported into a fast SQLite index kept
 * in a cache directory; opening the same file again reuses that index instead of
 * re-parsing (the way ChessBase converts foreign formats once).
 */
export class DatabaseManager {
  private db: GameDatabase | null = null
  private cacheDir = join(tmpdir(), 'chessin-db-cache')
  private currentName = ''
  private static instance: DatabaseManager | null = null

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) DatabaseManager.instance = new DatabaseManager()
    return DatabaseManager.instance
  }

  /** Where imported indexes are cached (set this to the app's userData dir). */
  setCacheDir(dir: string): void {
    this.cacheDir = dir
  }

  private cachePathFor(filePath: string): string {
    const hash = createHash('sha1').update(resolve(filePath)).digest('hex').slice(0, 16)
    return join(this.cacheDir, `${basename(filePath)}.${hash}.chessin.db`)
  }

  private removeCacheFiles(dbPath: string): void {
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  }

  async openDatabase(filePath: string, onProgress?: ProgressFn): Promise<OpenResult> {
    const ext = filePath.toLowerCase().split('.').pop()
    switch (ext) {
      case 'db':
      case 'sqlite':
      case 'chessin':
        return this.openNative(filePath)
      case 'pgn':
        return this.openPgn(filePath, onProgress)
      case 'cbh':
        return this.openCbh(filePath, onProgress)
      case 'cbv':
        return this.openCbv(filePath, onProgress)
      default:
        throw new Error(`Unsupported database format: .${ext}`)
    }
  }

  private openNative(filePath: string): OpenResult {
    this.close()
    this.db = new GameDatabase(filePath)
    this.currentName = basename(filePath)
    return { count: this.db.count(), name: this.currentName, dbPath: filePath, imported: false }
  }

  private async openPgn(filePath: string, onProgress?: ProgressFn): Promise<OpenResult> {
    mkdirSync(this.cacheDir, { recursive: true })
    const cachePath = this.cachePathFor(filePath)

    const fresh =
      existsSync(cachePath) && statSync(cachePath).mtimeMs >= statSync(filePath).mtimeMs

    this.close()

    let imported = false
    if (fresh) {
      this.db = new GameDatabase(cachePath)
      if (this.db.count() === 0) {
        // Stale/empty cache — rebuild it.
        this.db.close()
        this.removeCacheFiles(cachePath)
        this.db = new GameDatabase(cachePath)
        await this.db.importPgnFile(filePath, { onProgress })
        imported = true
      }
    } else {
      this.removeCacheFiles(cachePath)
      this.db = new GameDatabase(cachePath)
      await this.db.importPgnFile(filePath, { onProgress })
      imported = true
    }

    this.currentName = basename(filePath)
    return { count: this.db.count(), name: this.currentName, dbPath: cachePath, imported }
  }

  private async openCbh(filePath: string, onProgress?: ProgressFn): Promise<OpenResult> {
    const entries = await readCbhIndex(filePath)
    mkdirSync(this.cacheDir, { recursive: true })
    const cachePath = this.cachePathFor(filePath)

    this.close()
    this.removeCacheFiles(cachePath)
    this.db = new GameDatabase(cachePath)
    // ChessBase move data isn't decoded yet — import the header index so games
    // are searchable; movetext stays empty until .cbg decoding lands.
    this.db.importHeaderGames(entries.map((e) => e.headers))
    onProgress?.(entries.length)

    this.currentName = basename(filePath)
    return { count: this.db.count(), name: this.currentName, dbPath: cachePath, imported: true }
  }

  private async openCbv(filePath: string, onProgress?: ProgressFn): Promise<OpenResult> {
    const tempDir = join(this.cacheDir, 'cbv-extract')
    mkdirSync(tempDir, { recursive: true })
    const cbhPath = await extractCbv(filePath, tempDir)
    return this.openCbh(cbhPath, onProgress)
  }

  search(params: DatabaseSearchParams): SearchResult {
    return this.db ? this.db.search(params) : { games: [], total: 0 }
  }

  getGame(id: number): DatabaseGame | null {
    return this.db ? this.db.getGame(id) : null
  }

  getGamePgn(id: number): string | null {
    return this.db ? this.db.getGamePgn(id) : null
  }

  getOpeningStats(fen: string): OpeningMove[] {
    return this.db ? this.db.getOpeningStats(fen) : []
  }

  positionStats(fen: string): PositionStats {
    return this.db ? this.db.positionStats(fen) : EMPTY_STATS
  }

  gamesWithPosition(fen: string, limit?: number, offset?: number): SearchResult {
    return this.db ? this.db.gamesWithPosition(fen, limit, offset) : { games: [], total: 0 }
  }

  addGamePgn(pgn: string): number {
    return this.db ? this.db.addGamePgn(pgn) : -1
  }

  deleteGame(id: number): void {
    this.db?.deleteGame(id)
  }

  playerSuggestions(prefix: string): string[] {
    return this.db ? this.db.playerSuggestions(prefix) : []
  }

  getGameCount(): number {
    return this.db ? this.db.count() : 0
  }

  getName(): string {
    return this.currentName
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
