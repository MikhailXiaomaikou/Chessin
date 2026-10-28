import Database from 'better-sqlite3'
import type { Database as Db, Statement } from 'better-sqlite3'
import { Chess } from 'chess.js'
import { iteratePgnFile, iteratePgnGames, type ParsedPgnGame, type PgnGameHeader } from './PgnParser'
import { positionId, toSignedKey, PolyglotHasher } from './polyglot'

/**
 * SQLite-backed chess game database.
 *
 * This is the engine that lets Chessin scale past in-memory toys: games, players,
 * events and sites are stored in indexed tables, and every position of every game
 * is indexed by its Polyglot hash. That position index is what powers the two
 * features a serious database lives or dies by — position search ("show me every
 * game that reached this position") and the opening tree with W/D/L statistics.
 */

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS events  (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sites   (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE IF NOT EXISTS games (
  id        INTEGER PRIMARY KEY,
  white_id  INTEGER,
  black_id  INTEGER,
  event_id  INTEGER,
  site_id   INTEGER,
  round     TEXT,
  result    INTEGER,   -- 0 unknown/*, 1 white win, 2 black win, 3 draw
  date_key  INTEGER,   -- year*10000 + month*100 + day (0 = unknown), for range queries
  year      INTEGER,
  month     INTEGER,
  day       INTEGER,
  white_elo INTEGER,
  black_elo INTEGER,
  eco       TEXT,
  ply       INTEGER,
  pgn       TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_white   ON games(white_id);
CREATE INDEX IF NOT EXISTS idx_games_black   ON games(black_id);
CREATE INDEX IF NOT EXISTS idx_games_event   ON games(event_id);
CREATE INDEX IF NOT EXISTS idx_games_eco     ON games(eco);
CREATE INDEX IF NOT EXISTS idx_games_datekey ON games(date_key);

-- One row per position visited by a game. 'move' is the move played FROM that
-- position (packed from|to<<6|promo<<12), or NULL for the final position.
CREATE TABLE IF NOT EXISTS positions (
  hash    INTEGER NOT NULL,
  game_id INTEGER NOT NULL,
  ply     INTEGER NOT NULL,
  move    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_positions_hash ON positions(hash);
CREATE INDEX IF NOT EXISTS idx_positions_game ON positions(game_id);
`

export interface ImportOptions {
  /** Index every position for search / opening tree. Default true. */
  indexPositions?: boolean
  /** Called periodically with the number of games imported so far. */
  onProgress?: (count: number) => void
}

export interface GameRow {
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
  games: GameRow[]
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

const PROMO = ['', 'n', 'b', 'r', 'q'] // 1..4

function sqToIndex(sq: string): number {
  return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97)
}
function indexToSq(idx: number): string {
  return String.fromCharCode(97 + (idx & 7)) + String.fromCharCode(49 + (idx >> 3))
}
function encodeMove(from: string, to: string, promotion?: string): number {
  const p = promotion ? PROMO.indexOf(promotion) : 0
  return sqToIndex(from) | (sqToIndex(to) << 6) | ((p < 0 ? 0 : p) << 12)
}
function decodeMove(code: number): { from: string; to: string; promotion?: string } {
  const p = (code >> 12) & 7
  return {
    from: indexToSq(code & 63),
    to: indexToSq((code >> 6) & 63),
    promotion: p ? PROMO[p] : undefined
  }
}

function parseResult(result: string | undefined): number {
  switch (result) {
    case '1-0':
      return 1
    case '0-1':
      return 2
    case '1/2-1/2':
      return 3
    default:
      return 0
  }
}
function resultToString(r: number): string {
  return r === 1 ? '1-0' : r === 2 ? '0-1' : r === 3 ? '1/2-1/2' : '*'
}

function parseDate(date: string | undefined): { key: number; y: number; m: number; d: number } {
  if (!date) return { key: 0, y: 0, m: 0, d: 0 }
  const m = date.match(/^(\d{1,4})\.(\d{1,2}|\?\?)\.(\d{1,2}|\?\?)/)
  if (!m) return { key: 0, y: 0, m: 0, d: 0 }
  const y = parseInt(m[1]) || 0
  const mo = m[2] === '??' ? 0 : parseInt(m[2]) || 0
  const d = m[3] === '??' ? 0 : parseInt(m[3]) || 0
  return { key: y * 10000 + mo * 100 + d, y, m: mo, d }
}
function formatDate(y: number, m: number, d: number): string {
  if (!y) return '????.??.??'
  const mm = m ? String(m).padStart(2, '0') : '??'
  const dd = d ? String(d).padStart(2, '0') : '??'
  return `${y}.${mm}.${dd}`
}
function dateStringToKey(date: string): number {
  const { key } = parseDate(date)
  return key
}
function parseElo(elo: string | undefined): number | null {
  if (!elo) return null
  const n = parseInt(elo)
  return Number.isFinite(n) && n > 0 ? n : null
}

interface GameQueryRow {
  id: number
  white: string | null
  black: string | null
  event: string | null
  result: number
  year: number
  month: number
  day: number
  white_elo: number | null
  black_elo: number | null
  eco: string | null
  ply: number | null
  pgn?: string | null
}

export class GameDatabase {
  private db: Db
  private insertPosition: Statement
  private selPlayer: Statement
  private insPlayer: Statement
  private selEvent: Statement
  private insEvent: Statement
  private selSite: Statement
  private insSite: Statement
  private insGame: Statement
  private updatePly: Statement

  private playerCache = new Map<string, number>()
  private eventCache = new Map<string, number>()
  private siteCache = new Map<string, number>()

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('temp_store = MEMORY')
    this.db.exec(SCHEMA)
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))

    this.insertPosition = this.db.prepare(
      'INSERT INTO positions (hash, game_id, ply, move) VALUES (?, ?, ?, ?)'
    )
    this.selPlayer = this.db.prepare('SELECT id FROM players WHERE name = ?')
    this.insPlayer = this.db.prepare('INSERT INTO players (name) VALUES (?)')
    this.selEvent = this.db.prepare('SELECT id FROM events WHERE name = ?')
    this.insEvent = this.db.prepare('INSERT INTO events (name) VALUES (?)')
    this.selSite = this.db.prepare('SELECT id FROM sites WHERE name = ?')
    this.insSite = this.db.prepare('INSERT INTO sites (name) VALUES (?)')
    this.insGame = this.db.prepare(`
      INSERT INTO games
        (white_id, black_id, event_id, site_id, round, result, date_key, year, month, day,
         white_elo, black_elo, eco, ply, pgn)
      VALUES
        (@white_id, @black_id, @event_id, @site_id, @round, @result, @date_key, @year, @month, @day,
         @white_elo, @black_elo, @eco, @ply, @pgn)
    `)
    this.updatePly = this.db.prepare('UPDATE games SET ply = ? WHERE id = ?')
  }

  private getId(
    cache: Map<string, number>,
    sel: Statement,
    ins: Statement,
    rawName: string | undefined
  ): number {
    const name = rawName && rawName.trim() ? rawName.trim() : '?'
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    const row = sel.get(name) as { id: number } | undefined
    const id = row ? row.id : Number(ins.run(name).lastInsertRowid)
    cache.set(name, id)
    return id
  }

  /** Insert one parsed game and (optionally) index its positions. Not transactional. */
  private addParsedGame(game: ParsedPgnGame, indexPositions: boolean): number {
    const h = game.headers
    const date = parseDate(h.Date)
    const info = this.insGame.run({
      white_id: this.getId(this.playerCache, this.selPlayer, this.insPlayer, h.White),
      black_id: this.getId(this.playerCache, this.selPlayer, this.insPlayer, h.Black),
      event_id: this.getId(this.eventCache, this.selEvent, this.insEvent, h.Event),
      site_id: this.getId(this.siteCache, this.selSite, this.insSite, h.Site),
      round: h.Round ?? null,
      result: parseResult(h.Result),
      date_key: date.key,
      year: date.y,
      month: date.m,
      day: date.d,
      white_elo: parseElo(h.WhiteElo),
      black_elo: parseElo(h.BlackElo),
      eco: h.ECO ?? null,
      ply: 0,
      pgn: game.pgn
    })
    const gameId = Number(info.lastInsertRowid)

    const ply =
      indexPositions && game.moves.length > 0
        ? this.indexGame(gameId, h, game.moves)
        : game.moves.length
    this.updatePly.run(ply, gameId)
    return gameId
  }

  /** Replay a game's mainline and record a position row per ply. Returns plies indexed. */
  private indexGame(gameId: number, headers: PgnGameHeader, moves: string[]): number {
    let chess: Chess
    let hasher: PolyglotHasher
    try {
      chess = headers.FEN ? new Chess(headers.FEN) : new Chess()
      hasher = new PolyglotHasher(chess.fen())
    } catch {
      return 0
    }
    let ply = 0
    for (const san of moves) {
      const hashBefore = toSignedKey(hasher.current())
      let mv
      try {
        mv = chess.move(san)
      } catch {
        break
      }
      if (!mv) break
      this.insertPosition.run(hashBefore, gameId, ply, encodeMove(mv.from, mv.to, mv.promotion))
      hasher.apply(mv)
      ply++
    }
    // Final position (no following move) — still searchable.
    this.insertPosition.run(toSignedKey(hasher.current()), gameId, ply, null)
    return ply
  }

  /** Import all games from a PGN string. Returns the number of games added. */
  importPgnString(content: string, opts: ImportOptions = {}): number {
    const indexPositions = opts.indexPositions !== false
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const game of iteratePgnGames(content)) {
        this.addParsedGame(game, indexPositions)
        n++
        if (n % 2000 === 0) {
          this.db.exec('COMMIT')
          opts.onProgress?.(n)
          this.db.exec('BEGIN')
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    opts.onProgress?.(n)
    return n
  }

  /** Import all games from a PGN file, streaming it line by line. */
  async importPgnFile(filePath: string, opts: ImportOptions = {}): Promise<number> {
    const indexPositions = opts.indexPositions !== false
    let n = 0
    this.db.exec('BEGIN')
    try {
      for await (const game of iteratePgnFile(filePath)) {
        this.addParsedGame(game, indexPositions)
        n++
        if (n % 2000 === 0) {
          this.db.exec('COMMIT')
          opts.onProgress?.(n)
          this.db.exec('BEGIN')
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    opts.onProgress?.(n)
    return n
  }

  /** Import header-only games (e.g. decoded from a ChessBase index with no movetext). */
  importHeaderGames(headerList: PgnGameHeader[]): number {
    let n = 0
    const tx = this.db.transaction((list: PgnGameHeader[]) => {
      for (const headers of list) {
        this.addParsedGame({ headers, moves: [], movetext: '', pgn: '' }, false)
        n++
      }
    })
    tx(headerList)
    return n
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM games').get() as { c: number }).c
  }

  private buildWhere(params: SearchParams): { sql: string; bind: Record<string, unknown> } {
    const conds: string[] = []
    const bind: Record<string, unknown> = {}

    if (params.ignoreColors && (params.white || params.black)) {
      if (params.white && params.black) {
        // Either color arrangement of the two named players.
        conds.push(
          '((white_id IN (SELECT id FROM players WHERE name LIKE @white) AND black_id IN (SELECT id FROM players WHERE name LIKE @black))' +
            ' OR (white_id IN (SELECT id FROM players WHERE name LIKE @black) AND black_id IN (SELECT id FROM players WHERE name LIKE @white)))'
        )
        bind.white = `%${params.white}%`
        bind.black = `%${params.black}%`
      } else {
        // A single player, on either side of the board.
        conds.push(
          '(white_id IN (SELECT id FROM players WHERE name LIKE @anyName)' +
            ' OR black_id IN (SELECT id FROM players WHERE name LIKE @anyName))'
        )
        bind.anyName = `%${params.white || params.black}%`
      }
    } else {
      if (params.white) {
        conds.push('white_id IN (SELECT id FROM players WHERE name LIKE @white)')
        bind.white = `%${params.white}%`
      }
      if (params.black) {
        conds.push('black_id IN (SELECT id FROM players WHERE name LIKE @black)')
        bind.black = `%${params.black}%`
      }
    }
    if (params.event) {
      conds.push('event_id IN (SELECT id FROM events WHERE name LIKE @event)')
      bind.event = `%${params.event}%`
    }
    if (params.result) {
      conds.push('result = @result')
      bind.result = parseResult(params.result)
    }
    if (params.eco) {
      conds.push('eco LIKE @eco')
      bind.eco = `${params.eco.toUpperCase()}%`
    }
    if (params.dateFrom) {
      conds.push('date_key >= @dateFrom')
      bind.dateFrom = dateStringToKey(params.dateFrom)
    }
    if (params.dateTo) {
      conds.push('date_key <= @dateTo')
      bind.dateTo = dateStringToKey(params.dateTo)
    }
    if (params.minElo) {
      conds.push('(white_elo >= @minElo OR black_elo >= @minElo)')
      bind.minElo = params.minElo
    }

    return { sql: conds.length ? 'WHERE ' + conds.join(' AND ') : '', bind }
  }

  search(params: SearchParams = {}): SearchResult {
    const { sql: where, bind } = this.buildWhere(params)
    const limit = params.limit ?? 100
    const offset = params.offset ?? 0

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM games ${where}`).get(bind) as { c: number }
    ).c

    const rows = this.db
      .prepare(
        `SELECT g.id, wp.name AS white, bp.name AS black, ev.name AS event, g.result,
                g.year, g.month, g.day, g.white_elo, g.black_elo, g.eco, g.ply
         FROM games g
         LEFT JOIN players wp ON wp.id = g.white_id
         LEFT JOIN players bp ON bp.id = g.black_id
         LEFT JOIN events  ev ON ev.id = g.event_id
         ${where}
         ORDER BY g.id
         LIMIT @_limit OFFSET @_offset`
      )
      .all({ ...bind, _limit: limit, _offset: offset }) as GameQueryRow[]

    return { games: rows.map((r) => this.rowToGame(r)), total }
  }

  private rowToGame(r: GameQueryRow): GameRow {
    return {
      id: r.id,
      white: r.white ?? '?',
      black: r.black ?? '?',
      result: resultToString(r.result),
      date: formatDate(r.year, r.month, r.day),
      event: r.event ?? undefined,
      eco: r.eco ?? undefined,
      whiteElo: r.white_elo != null ? String(r.white_elo) : undefined,
      blackElo: r.black_elo != null ? String(r.black_elo) : undefined,
      ply: r.ply ?? undefined,
      pgn: r.pgn ?? undefined
    }
  }

  getGame(id: number): GameRow | null {
    const r = this.db
      .prepare(
        `SELECT g.id, wp.name AS white, bp.name AS black, ev.name AS event, g.result,
                g.year, g.month, g.day, g.white_elo, g.black_elo, g.eco, g.ply, g.pgn
         FROM games g
         LEFT JOIN players wp ON wp.id = g.white_id
         LEFT JOIN players bp ON bp.id = g.black_id
         LEFT JOIN events  ev ON ev.id = g.event_id
         WHERE g.id = ?`
      )
      .get(id) as GameQueryRow | undefined
    return r ? this.rowToGame(r) : null
  }

  getGamePgn(id: number): string | null {
    const r = this.db.prepare('SELECT pgn FROM games WHERE id = ?').get(id) as
      | { pgn: string | null }
      | undefined
    return r?.pgn ?? null
  }

  /** Opening tree + aggregate result split for the given position. */
  positionStats(fen: string): PositionStats {
    const hash = positionId(fen)

    const overall = this.db
      .prepare(
        `SELECT g.result AS result, COUNT(*) AS c
         FROM positions p JOIN games g ON g.id = p.game_id
         WHERE p.hash = ?
         GROUP BY g.result`
      )
      .all(hash) as { result: number; c: number }[]

    let total = 0
    let whiteWins = 0
    let draws = 0
    let blackWins = 0
    for (const o of overall) {
      total += o.c
      if (o.result === 1) whiteWins += o.c
      else if (o.result === 2) blackWins += o.c
      else if (o.result === 3) draws += o.c
    }

    const moveRows = this.db
      .prepare(
        `SELECT p.move AS move, g.result AS result, COUNT(*) AS c
         FROM positions p JOIN games g ON g.id = p.game_id
         WHERE p.hash = ? AND p.move IS NOT NULL
         GROUP BY p.move, g.result`
      )
      .all(hash) as { move: number; result: number; c: number }[]

    // Map packed-move codes to SAN using the legal moves of this position.
    const sanByCode = new Map<number, string>()
    try {
      const chess = new Chess(fen)
      for (const m of chess.moves({ verbose: true })) {
        sanByCode.set(encodeMove(m.from, m.to, m.promotion), m.san)
      }
    } catch {
      // invalid FEN — leave the map empty, moves will fall back to coordinate form
    }

    const byMove = new Map<number, OpeningMove>()
    for (const row of moveRows) {
      let entry = byMove.get(row.move)
      if (!entry) {
        const san = sanByCode.get(row.move)
        const dec = decodeMove(row.move)
        entry = {
          move: san ?? `${dec.from}${dec.to}${dec.promotion ?? ''}`,
          count: 0,
          whiteWins: 0,
          draws: 0,
          blackWins: 0
        }
        byMove.set(row.move, entry)
      }
      entry.count += row.c
      if (row.result === 1) entry.whiteWins += row.c
      else if (row.result === 2) entry.blackWins += row.c
      else if (row.result === 3) entry.draws += row.c
    }

    const moves = [...byMove.values()].sort((a, b) => b.count - a.count)
    return { total, whiteWins, draws, blackWins, moves }
  }

  /** Backward-compatible: just the opening-tree moves. */
  getOpeningStats(fen: string): OpeningMove[] {
    return this.positionStats(fen).moves
  }

  /** Games that reached a given position, most recent first. */
  gamesWithPosition(fen: string, limit = 100, offset = 0): SearchResult {
    const hash = positionId(fen)
    const total = (
      this.db
        .prepare('SELECT COUNT(DISTINCT game_id) AS c FROM positions WHERE hash = ?')
        .get(hash) as { c: number }
    ).c
    const rows = this.db
      .prepare(
        `SELECT g.id, wp.name AS white, bp.name AS black, ev.name AS event, g.result,
                g.year, g.month, g.day, g.white_elo, g.black_elo, g.eco, g.ply
         FROM games g
         LEFT JOIN players wp ON wp.id = g.white_id
         LEFT JOIN players bp ON bp.id = g.black_id
         LEFT JOIN events  ev ON ev.id = g.event_id
         WHERE g.id IN (SELECT DISTINCT game_id FROM positions WHERE hash = ?)
         ORDER BY g.date_key DESC, g.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(hash, limit, offset) as GameQueryRow[]
    return { games: rows.map((r) => this.rowToGame(r)), total }
  }

  /** Add a single game from PGN text. Returns the new game id (or -1 if none parsed). */
  addGamePgn(pgn: string, indexPositions = true): number {
    const games = iteratePgnGames(pgn)
    const tx = this.db.transaction(() => {
      let id = -1
      for (const g of games) id = this.addParsedGame(g, indexPositions)
      return id
    })
    return tx()
  }

  deleteGame(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM positions WHERE game_id = ?').run(id)
      this.db.prepare('DELETE FROM games WHERE id = ?').run(id)
    })
    tx()
  }

  /** Distinct player names matching a prefix (for autocomplete). */
  playerSuggestions(prefix: string, limit = 20): string[] {
    return (
      this.db
        .prepare('SELECT name FROM players WHERE name LIKE ? ORDER BY name LIMIT ?')
        .all(`${prefix}%`, limit) as { name: string }[]
    ).map((r) => r.name)
  }

  vacuum(): void {
    this.db.exec('VACUUM')
  }

  close(): void {
    this.db.close()
  }
}
