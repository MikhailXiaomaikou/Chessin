import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Chess } from 'chess.js'
import { GameDatabase } from './GameDatabase'
import { PolyglotBook } from '../../shared/chess/polyglotBook'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function fenAfter(moves: string[]): string {
  const c = new Chess()
  for (const m of moves) c.move(m)
  return c.fen()
}

const SAMPLE = `[Event "Open"]
[Site "CityA"]
[White "Carlsen, M"]
[Black "Caruana, F"]
[Result "1-0"]
[ECO "C42"]
[WhiteElo "2850"]
[BlackElo "2820"]
[Date "2021.01.05"]

1. e4 e5 2. Nf3 Nf6 1-0

[Event "Open"]
[White "Nakamura, H"]
[Black "Carlsen, M"]
[Result "1/2-1/2"]
[ECO "C42"]
[Date "2022.03.10"]

1. e4 e5 2. Nf3 Nf6 1/2-1/2

[Event "Sicilian Night"]
[White "Firouzja, A"]
[Black "So, W"]
[Result "0-1"]
[ECO "B20"]
[Date "2023.06.01"]

1. e4 c5 0-1

[Event "Queen's"]
[White "Ding, L"]
[Black "Nepomniachtchi, I"]
[Result "1/2-1/2"]
[ECO "D02"]
[Date "2020.11.20"]

1. d4 d5 1/2-1/2`

describe('GameDatabase', () => {
  let db: GameDatabase

  beforeEach(() => {
    db = new GameDatabase(':memory:')
    db.importPgnString(SAMPLE)
  })

  it('imports and counts games', () => {
    expect(db.count()).toBe(4)
  })

  it('searches by player name with a total', () => {
    const r = db.search({ white: 'Carlsen' })
    expect(r.total).toBe(1)
    expect(r.games[0].white).toContain('Carlsen')
  })

  it('finds a player on either side with ignoreColors', () => {
    const r = db.search({ white: 'Carlsen', ignoreColors: true })
    expect(r.total).toBe(2) // white in G1, black in G2
  })

  it('matches a specific pairing regardless of colors', () => {
    const r = db.search({ white: 'Carlsen', black: 'Nakamura', ignoreColors: true })
    expect(r.total).toBe(1)
  })

  it('filters by ECO prefix', () => {
    expect(db.search({ eco: 'C42' }).total).toBe(2)
    expect(db.search({ eco: 'B' }).total).toBe(1)
  })

  it('filters by result', () => {
    expect(db.search({ result: '1/2-1/2' }).total).toBe(2)
    expect(db.search({ result: '1-0' }).total).toBe(1)
  })

  it('filters by date range', () => {
    expect(db.search({ dateFrom: '2022.01.01' }).total).toBe(2)
    expect(db.search({ dateFrom: '2021.01.01', dateTo: '2021.12.31' }).total).toBe(1)
  })

  it('filters by minimum Elo', () => {
    expect(db.search({ minElo: 2840 }).total).toBe(1)
    expect(db.search({ minElo: 3000 }).total).toBe(0)
  })

  it('paginates with a stable total', () => {
    const r = db.search({ limit: 2, offset: 0 })
    expect(r.total).toBe(4)
    expect(r.games).toHaveLength(2)
    const r2 = db.search({ limit: 2, offset: 2 })
    expect(r2.games).toHaveLength(2)
    expect(r2.games[0].id).not.toBe(r.games[0].id)
  })

  it('returns full, re-loadable PGN for a game', () => {
    const g = db.search({ white: 'Carlsen' }).games[0]
    const pgn = db.getGamePgn(g.id)
    expect(pgn).toBeTruthy()
    expect(pgn).toContain('Carlsen')
    expect(pgn).toContain('Nf6')
    const c = new Chess()
    expect(() => c.loadPgn(pgn as string)).not.toThrow()
  })

  it('builds an opening tree from the start position', () => {
    const stats = db.positionStats(START)
    expect(stats.total).toBe(4)
    const e4 = stats.moves.find((m) => m.move === 'e4')
    const d4 = stats.moves.find((m) => m.move === 'd4')
    expect(e4).toBeDefined()
    expect(e4?.count).toBe(3)
    expect(e4?.whiteWins).toBe(1)
    expect(e4?.draws).toBe(1)
    expect(e4?.blackWins).toBe(1)
    expect(d4?.count).toBe(1)
    expect(d4?.draws).toBe(1)
    // most popular move first
    expect(stats.moves[0].move).toBe('e4')
  })

  it('narrows the opening tree after a move', () => {
    const stats = db.positionStats(fenAfter(['e4']))
    expect(stats.total).toBe(3)
    expect(stats.moves.find((m) => m.move === 'e5')?.count).toBe(2)
    expect(stats.moves.find((m) => m.move === 'c5')?.count).toBe(1)
  })

  it('finds games by position including transpositions', () => {
    const db2 = new GameDatabase(':memory:')
    db2.importPgnString(`[White "A"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

[White "C"]
[Black "D"]
[Result "*"]

1. Nf3 Nc6 2. e4 e5 *`)
    const target = fenAfter(['e4', 'e5', 'Nf3', 'Nc6'])
    expect(db2.gamesWithPosition(target).total).toBe(2)
    db2.close()
  })

  it('adds and deletes a game, including its position index', () => {
    const id = db.addGamePgn(`[White "X"]
[Black "Y"]
[Result "1-0"]

1. f4 e5 1-0`)
    expect(id).toBeGreaterThan(0)
    expect(db.count()).toBe(5)
    expect(db.gamesWithPosition(fenAfter(['f4'])).total).toBe(1)

    db.deleteGame(id)
    expect(db.count()).toBe(4)
    expect(db.gamesWithPosition(fenAfter(['f4'])).total).toBe(0)
  })

  it('suggests player names by prefix', () => {
    expect(db.playerSuggestions('Car')).toEqual(
      expect.arrayContaining(['Carlsen, M', 'Caruana, F'])
    )
  })

  it('imports from a file via the streaming path and reports progress', async () => {
    const path = join(tmpdir(), `chessin-test-${process.pid}-${db.count()}.pgn`)
    writeFileSync(path, SAMPLE, 'utf-8')
    const fileDb = new GameDatabase(':memory:')
    let lastProgress = 0
    const added = await fileDb.importPgnFile(path, {
      onProgress: (n) => {
        lastProgress = n
      }
    })
    expect(added).toBe(4)
    expect(lastProgress).toBe(4)
    expect(fileDb.count()).toBe(4)
    expect(fileDb.positionStats(START).total).toBe(4)
    fileDb.close()
    rmSync(path, { force: true })
  })

  it('exports a Polyglot book that round-trips through the reader', () => {
    const book = new PolyglotBook(db.exportPolyglotBook())
    const start = book.lookup(START)
    expect(start.map((m) => m.san)).toEqual(['e4', 'd4'])
    expect(start[0].weight).toBe(3)
    expect(start[1].weight).toBe(1)
    const afterE4 = book.lookup(fenAfter(['e4']))
    expect(afterE4.find((m) => m.san === 'e5')?.weight).toBe(2)
    expect(afterE4.find((m) => m.san === 'c5')?.weight).toBe(1)
  })

  it('weights exported moves by score for the side to move', () => {
    const book = new PolyglotBook(db.exportPolyglotBook({ weighting: 'score' }))
    // After 1.e4, ...e5 scored a loss and a draw for Black (1 pt), ...c5 a win (2 pts).
    const afterE4 = book.lookup(fenAfter(['e4']))
    expect(afterE4[0].san).toBe('c5')
    expect(afterE4.find((m) => m.san === 'e5')?.weight).toBe(1)
  })

  it('exports castling in Polyglot king-takes-rook form', () => {
    const castled = new GameDatabase(':memory:')
    castled.importPgnString(`[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O Bc5 1-0`)
    const book = new PolyglotBook(castled.exportPolyglotBook())
    const moves = book.lookup(fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']))
    expect(moves[0]).toMatchObject({ san: 'O-O', uci: 'e1g1' })
    castled.close()
  })

  it('respects maxPly and minGames when exporting', () => {
    const shallow = new PolyglotBook(db.exportPolyglotBook({ maxPly: 1 }))
    expect(shallow.lookup(START)).toHaveLength(2)
    expect(shallow.lookup(fenAfter(['e4']))).toEqual([])
    const popular = new PolyglotBook(db.exportPolyglotBook({ minGames: 2 }))
    expect(popular.lookup(START).map((m) => m.san)).toEqual(['e4']) // d4 was played once
  })
})
