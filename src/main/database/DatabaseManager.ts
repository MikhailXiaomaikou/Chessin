import { parsePgnFile, type PgnGame } from './PgnParser'
import { readCbhIndex, type CbhGameEntry } from './CbhReader'
import { extractCbv } from './CbvReader'
import { tmpdir } from 'os'
import { join } from 'path'

export interface DatabaseGame {
  index: number
  white: string
  black: string
  result: string
  date: string
  event?: string
  eco?: string
  whiteElo?: string
  blackElo?: string
  pgn?: string
}

export interface DatabaseSearchParams {
  white?: string
  black?: string
  result?: string
  eco?: string
  dateFrom?: string
  dateTo?: string
  minElo?: number
  limit?: number
  offset?: number
}

export class DatabaseManager {
  private games: DatabaseGame[] = []
  private pgnGames: PgnGame[] = []
  private sourceType: 'pgn' | 'cbh' | 'none' = 'none'
  private static instance: DatabaseManager | null = null

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager()
    }
    return DatabaseManager.instance
  }

  async openPgnFile(filePath: string): Promise<number> {
    this.pgnGames = await parsePgnFile(filePath)
    this.games = this.pgnGames.map((game, i) => ({
      index: i,
      white: game.headers.White || '?',
      black: game.headers.Black || '?',
      result: game.headers.Result || '*',
      date: game.headers.Date || '????.??.??',
      event: game.headers.Event,
      eco: game.headers.ECO,
      whiteElo: game.headers.WhiteElo,
      blackElo: game.headers.BlackElo,
      pgn: game.raw
    }))
    this.sourceType = 'pgn'
    return this.games.length
  }

  async openCbhFile(filePath: string): Promise<number> {
    const entries = await readCbhIndex(filePath)
    this.games = entries.map((entry) => ({
      index: entry.index,
      white: entry.headers.White || '?',
      black: entry.headers.Black || '?',
      result: entry.headers.Result || '*',
      date: entry.headers.Date || '????.??.??',
      event: entry.headers.Event,
      eco: entry.headers.ECO,
      whiteElo: entry.headers.WhiteElo,
      blackElo: entry.headers.BlackElo
    }))
    this.sourceType = 'cbh'
    return this.games.length
  }

  async openCbvFile(filePath: string): Promise<number> {
    const tempDir = join(tmpdir(), 'chess-gui-cbv-' + Date.now())
    const cbhPath = await extractCbv(filePath, tempDir)
    return this.openCbhFile(cbhPath)
  }

  async openDatabase(filePath: string): Promise<number> {
    const ext = filePath.toLowerCase().split('.').pop()
    switch (ext) {
      case 'pgn':
        return this.openPgnFile(filePath)
      case 'cbh':
        return this.openCbhFile(filePath)
      case 'cbv':
        return this.openCbvFile(filePath)
      default:
        throw new Error(`Unsupported database format: .${ext}`)
    }
  }

  search(params: DatabaseSearchParams): DatabaseGame[] {
    let results = [...this.games]

    if (params.white) {
      const term = params.white.toLowerCase()
      results = results.filter((g) => g.white.toLowerCase().includes(term))
    }

    if (params.black) {
      const term = params.black.toLowerCase()
      results = results.filter((g) => g.black.toLowerCase().includes(term))
    }

    if (params.result) {
      results = results.filter((g) => g.result === params.result)
    }

    if (params.eco) {
      const term = params.eco.toUpperCase()
      results = results.filter((g) => g.eco?.startsWith(term))
    }

    if (params.dateFrom) {
      results = results.filter((g) => g.date >= params.dateFrom!)
    }

    if (params.dateTo) {
      results = results.filter((g) => g.date <= params.dateTo!)
    }

    if (params.minElo) {
      const min = params.minElo
      results = results.filter((g) => {
        const wElo = parseInt(g.whiteElo || '0')
        const bElo = parseInt(g.blackElo || '0')
        return wElo >= min || bElo >= min
      })
    }

    const offset = params.offset || 0
    const limit = params.limit || 100

    return results.slice(offset, offset + limit)
  }

  getGame(index: number): DatabaseGame | null {
    return this.games[index] || null
  }

  getGamePgn(index: number): string | null {
    if (this.sourceType === 'pgn' && this.pgnGames[index]) {
      return this.pgnGames[index].raw
    }
    return this.games[index]?.pgn || null
  }

  getGameCount(): number {
    return this.games.length
  }

  getOpeningStats(
    fen: string
  ): { move: string; count: number; whiteWins: number; draws: number; blackWins: number }[] {
    // This would require indexing positions - simplified stub
    return []
  }
}
