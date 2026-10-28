import { createHash } from 'crypto'
import { existsSync, statSync, mkdirSync, rmSync } from 'fs'
import { basename, resolve, join } from 'path'
import { tmpdir } from 'os'
import {
  GameDatabase,
  SCHEMA_VERSION,
  type GameRow,
  type SearchParams,
  type SearchResult,
  type OpeningMove,
  type PositionStats,
  type BookExportOptions
} from './GameDatabase'
import { ChessBaseReader, type CbGame, type CbSkipReason } from '../../shared/chessbase/reader'
import { openChessBaseFiles } from './ChessBaseFiles'
import { extractCbv } from './CbvReader'

// Re-exported for IPC/consumers (keeps the old type names available).
export type DatabaseGame = GameRow
export type DatabaseSearchParams = SearchParams

export type SkipCounts = Partial<Record<CbSkipReason, number>>

export interface OpenResult {
  count: number
  name: string
  dbPath: string
  /** True when a PGN/ChessBase file had to be imported into a fresh index this time. */
  imported: boolean
  /** ChessBase records that were not imported as games, by reason. */
  skipped?: SkipCounts
}

type ProgressFn = (count: number) => void

const EMPTY_STATS: PositionStats = {
  total: 0,
  whiteWins: 0,
  draws: 0,
  blackWins: 0,
  moves: []
}

/** Decoded games of a ChessBase database, yielding to the event loop now and then. */
async function* chessBaseGames(
  reader: ChessBaseReader,
  onSkip: (reason: CbSkipReason) => void
): AsyncGenerator<CbGame> {
  let i = 0
  for (const entry of reader.entries()) {
    if (++i % 250 === 0) await new Promise((resolve) => setImmediate(resolve))
    if (entry.kind === 'game') yield entry.game
    else onSkip(entry.reason)
  }
}

/**
 * What the source files looked like when an index was built. Kept inside the
 * index rather than compared against its file time: closing a WAL database
 * rewrites it, which would make a stale index look newer than an edited source.
 */
function sourceSignature(paths: string[]): string {
  return JSON.stringify(
    paths
      .map((p) => {
        const s = statSync(p)
        return [basename(p), s.size, Math.floor(s.mtimeMs)] as const
      })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  )
}

function parseSkipped(json: string | undefined): SkipCounts | undefined {
  if (!json) return undefined
  try {
    return JSON.parse(json) as SkipCounts
  } catch {
    return undefined
  }
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

  /** Drop a half-built index so it is never mistaken for an up-to-date one. */
  private discard(dbPath: string): void {
    this.close()
    this.removeCacheFiles(dbPath)
  }

  /** The index at `cachePath` if it was built from exactly these sources, or null. */
  private reuse(cachePath: string, signature: string): GameDatabase | null {
    if (!existsSync(cachePath)) return null
    let db: GameDatabase | null = null
    try {
      db = new GameDatabase(cachePath)
      if (
        db.count() > 0 &&
        db.schemaVersion() >= SCHEMA_VERSION &&
        db.getMeta('source') === signature
      ) {
        return db
      }
    } catch {
      // unreadable — rebuilt below
    }
    db?.close() // stale, empty, older schema or damaged
    return null
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
    this.close()
    this.currentName = basename(filePath)

    const signature = sourceSignature([filePath])
    const cached = this.reuse(cachePath, signature)
    if (cached) {
      this.db = cached
      return { count: cached.count(), name: this.currentName, dbPath: cachePath, imported: false }
    }

    this.removeCacheFiles(cachePath)
    this.db = new GameDatabase(cachePath)
    try {
      await this.db.importPgnFile(filePath, { onProgress })
    } catch (err) {
      this.discard(cachePath)
      throw err
    }
    this.db.setMeta('source', signature)
    return { count: this.db.count(), name: this.currentName, dbPath: cachePath, imported: true }
  }

  /**
   * A ChessBase database: every game is decoded from .cbg (with variations and
   * annotations from .cba) and indexed like any other.
   */
  private async openCbh(
    cbhPath: string,
    onProgress?: ProgressFn,
    displayName = basename(cbhPath)
  ): Promise<OpenResult> {
    const cb = openChessBaseFiles(cbhPath)
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const cachePath = this.cachePathFor(cbhPath)
      this.close()
      this.currentName = displayName

      const signature = sourceSignature(cb.paths)
      const cached = this.reuse(cachePath, signature)
      if (cached) {
        this.db = cached
        return {
          count: cached.count(),
          name: displayName,
          dbPath: cachePath,
          imported: false,
          skipped: parseSkipped(cached.getMeta('skipped'))
        }
      }

      this.removeCacheFiles(cachePath)
      this.db = new GameDatabase(cachePath)
      const skipped: SkipCounts = {}
      try {
        const games = chessBaseGames(new ChessBaseReader(cb.files), (reason) => {
          skipped[reason] = (skipped[reason] ?? 0) + 1
        })
        await this.db.importGames(games, { onProgress })
      } catch (err) {
        this.discard(cachePath)
        throw err
      }
      this.db.setMeta('skipped', JSON.stringify(skipped))
      this.db.setMeta('source', signature)
      return { count: this.db.count(), name: displayName, dbPath: cachePath, imported: true, skipped }
    } finally {
      cb.close()
    }
  }

  private async openCbv(filePath: string, onProgress?: ProgressFn): Promise<OpenResult> {
    const tempDir = join(this.cacheDir, 'cbv-extract')
    mkdirSync(tempDir, { recursive: true })
    const cbhPath = await extractCbv(filePath, tempDir)
    return this.openCbh(cbhPath, onProgress, basename(filePath))
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

  exportPolyglotBook(opts?: BookExportOptions): Uint8Array | null {
    return this.db ? this.db.exportPolyglotBook(opts) : null
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
