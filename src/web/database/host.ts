import type { Database as SqlJsDb, SqlJsStatic } from 'sql.js'
import {
  GameDatabase,
  SCHEMA_VERSION,
  type BookExportOptions,
  type GameRow,
  type PositionStats,
  type SearchParams,
  type SearchResult
} from '../../shared/database/GameDatabase'
import { sqlJsDriver } from '../../shared/database/sqlJsDriver'
import { iteratePgnLines, type ParsedPgnGame } from '../../shared/database/PgnParser'
import { ChessBaseReader, type ChessBaseFiles, type CbSkipReason } from '../../shared/chessbase/reader'
import type { ByteSource } from '../../shared/chessbase/bytes'
import { blobLines } from './files'

export type SkipCounts = Partial<Record<CbSkipReason, number>>

export interface WebOpenResult {
  count: number
  name: string
  dbPath: string
  /** True when the file had to be imported (no cached index matched it). */
  imported: boolean
  /** ChessBase records that were not imported as games, by reason. */
  skipped?: SkipCounts
}

/** Where imported indexes are kept between visits. */
export interface IndexCache {
  load(key: string): Promise<Uint8Array | null>
  save(key: string, name: string, bytes: Uint8Array): Promise<void>
}

const EMPTY_STATS: PositionStats = { total: 0, whiteWins: 0, draws: 0, blackWins: 0, moves: [] }
const CHESSBASE_EXTENSIONS = ['cbh', 'cbg', 'cba', 'cbp', 'cbt', 'cbc', 'cbs'] as const

type Source =
  | { kind: 'pgn'; name: string; files: File[] }
  | { kind: 'chessbase'; name: string; files: File[]; byExt: Map<string, File> }

const extension = (file: File): string => file.name.toLowerCase().split('.').pop() ?? ''

/** What a set of picked files is; throws a readable error when it is not a database. */
function classify(files: File[]): Source {
  const byExt = new Map<string, File>()
  for (const f of files) if (!byExt.has(extension(f))) byExt.set(extension(f), f)

  const pgn = byExt.get('pgn')
  if (pgn) return { kind: 'pgn', name: pgn.name, files: [pgn] }
  const cbh = byExt.get('cbh')
  if (cbh) {
    if (!byExt.has('cbg')) {
      const stem = cbh.name.replace(/\.[^.]+$/, '')
      throw new Error(`The moves file ${stem}.cbg is missing — select it together with ${cbh.name}`)
    }
    const used = CHESSBASE_EXTENSIONS.flatMap((ext) => byExt.get(ext) ?? [])
    return { kind: 'chessbase', name: cbh.name, files: used, byExt }
  }
  if (byExt.has('cbv')) {
    throw new Error(
      'CBV archives open in the desktop app. In the browser, unpack it and choose its .cbh, .cbg and .cba files together.'
    )
  }
  throw new Error('Unsupported database format: choose a .pgn file, or a ChessBase .cbh with its .cbg')
}

/** What the source files looked like when an index was built from them. */
function signature(files: File[]): string {
  const parts = files
    .map((f) => [f.name, f.size, f.lastModified] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return JSON.stringify(parts)
}

function parseSkipped(json: string | undefined): SkipCounts | undefined {
  try {
    return json ? (JSON.parse(json) as SkipCounts) : undefined
  } catch {
    return undefined
  }
}

/**
 * The browser's game database: the same engine as the desktop app, on SQLite
 * compiled to WebAssembly. It runs in a worker; this class is the part that
 * does not care how messages arrive.
 */
export class WebDatabaseHost {
  private raw: SqlJsDb | null = null
  private db: GameDatabase | null = null
  private name = ''
  private key = ''
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly SQL: SqlJsStatic,
    private readonly cache: IndexCache,
    /** Random access to a picked file, for ChessBase databases. */
    private readonly openSource: (file: Blob) => ByteSource
  ) {}

  async open(files: File[], onProgress?: (count: number) => void): Promise<WebOpenResult> {
    const source = classify(files)
    const key = signature(source.files)
    this.close()
    this.name = source.name
    this.key = key

    const cached = await this.cache.load(key)
    if (cached) {
      try {
        const db = this.attach(new this.SQL.Database(cached))
        if (
          db.count() > 0 &&
          db.schemaVersion() >= SCHEMA_VERSION &&
          db.getMeta('source') === key
        ) {
          return this.result(false, parseSkipped(db.getMeta('skipped')))
        }
      } catch {
        // damaged — imported again below
      }
      this.detach()
    }

    const db = this.attach(new this.SQL.Database())
    let skipped: SkipCounts | undefined
    try {
      if (source.kind === 'pgn') {
        await db.importGames(iteratePgnLines(blobLines(source.files[0])), { onProgress })
      } else {
        skipped = {}
        await db.importGames(this.chessBaseGames(source.byExt, skipped), { onProgress })
        db.setMeta('skipped', JSON.stringify(skipped))
      }
    } catch (err) {
      this.close()
      throw err
    }
    db.setMeta('source', key)
    this.persist()
    return this.result(true, skipped)
  }

  private *chessBaseGames(byExt: Map<string, File>, skipped: SkipCounts): Generator<ParsedPgnGame> {
    const source = (ext: string) => {
      const file = byExt.get(ext)
      return file ? this.openSource(file) : undefined
    }
    const files: ChessBaseFiles = {
      cbh: this.openSource(byExt.get('cbh') as File),
      cbg: this.openSource(byExt.get('cbg') as File),
      cba: source('cba'),
      cbp: source('cbp'),
      cbt: source('cbt'),
      cbc: source('cbc'),
      cbs: source('cbs')
    }
    for (const entry of new ChessBaseReader(files).entries()) {
      if (entry.kind === 'game') yield entry.game
      else skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1
    }
  }

  private result(imported: boolean, skipped?: SkipCounts): WebOpenResult {
    return {
      count: this.db?.count() ?? 0,
      name: this.name,
      dbPath: this.name,
      imported,
      ...(skipped ? { skipped } : {})
    }
  }

  private attach(raw: SqlJsDb): GameDatabase {
    this.raw = raw
    this.db = new GameDatabase(sqlJsDriver(raw))
    return this.db
  }

  private detach(): void {
    this.db?.close() // closes `raw` too
    this.db = null
    this.raw = null
  }

  /**
   * Keeps the index for the next visit. sql.js's export closes every prepared
   * statement, so the engine is rebuilt on the same database right after.
   */
  private persist(): void {
    if (!this.raw) return
    const bytes = this.raw.export()
    this.db = new GameDatabase(sqlJsDriver(this.raw))
    const { key, name } = this
    this.saving = this.saving.then(() => this.cache.save(key, name, bytes))
  }

  /** Resolves once queued saves are written (for tests and orderly shutdown). */
  flush(): Promise<void> {
    return this.saving
  }

  get currentName(): string {
    return this.db ? this.name : ''
  }

  search(params: SearchParams): SearchResult {
    return this.db ? this.db.search(params) : { games: [], total: 0 }
  }

  getGame(id: number): GameRow | null {
    return this.db?.getGame(id) ?? null
  }

  positionStats(fen: string): PositionStats {
    return this.db ? this.db.positionStats(fen) : EMPTY_STATS
  }

  positionGames(params: { fen: string; limit?: number; offset?: number }): SearchResult {
    return this.db
      ? this.db.gamesWithPosition(params.fen, params.limit, params.offset)
      : { games: [], total: 0 }
  }

  addGame(pgn: string): number {
    if (!this.db) return -1
    const id = this.db.addGamePgn(pgn)
    if (id >= 0) this.persist()
    return id
  }

  deleteGame(id: number): void {
    if (!this.db) return
    this.db.deleteGame(id)
    this.persist()
  }

  playerSuggest(prefix: string): string[] {
    return this.db ? this.db.playerSuggestions(prefix) : []
  }

  exportBook(opts?: BookExportOptions): Uint8Array | null {
    return this.db ? this.db.exportPolyglotBook(opts) : null
  }

  close(): void {
    this.detach()
    this.name = ''
    this.key = ''
  }
}
