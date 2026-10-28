import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import {
  parsePgnGames,
  iteratePgnGames,
  extractMainline,
  cleanSan
} from './PgnParser'

describe('cleanSan', () => {
  it('strips move numbers, glyphs and check marks', () => {
    expect(cleanSan('1.e4')).toBe('e4')
    expect(cleanSan('1...Nf6')).toBe('Nf6')
    expect(cleanSan('12.')).toBeNull()
    expect(cleanSan('Qxe7+')).toBe('Qxe7')
    expect(cleanSan('Nf3!?')).toBe('Nf3')
    expect(cleanSan('exd8=Q#')).toBe('exd8=Q')
  })

  it('normalizes castling written with zeros', () => {
    expect(cleanSan('0-0')).toBe('O-O')
    expect(cleanSan('0-0-0')).toBe('O-O-O')
    expect(cleanSan('0-0+')).toBe('O-O')
  })

  it('rejects results and null moves', () => {
    expect(cleanSan('1-0')).toBeNull()
    expect(cleanSan('1/2-1/2')).toBeNull()
    expect(cleanSan('*')).toBeNull()
    expect(cleanSan('--')).toBeNull()
  })
})

describe('extractMainline', () => {
  it('skips variations, comments and NAGs', () => {
    const movetext =
      '1. e4 e5 2. Nf3 (2. f4 exf4) 2... Nc6 $1 {a good move} 3. Bb5 a6 1-0'
    expect(extractMainline(movetext)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])
  })

  it('handles nested variations', () => {
    const movetext = '1. d4 d5 2. c4 (2. Nf3 Nf6 (2... e6 3. g3)) 2... e6'
    expect(extractMainline(movetext)).toEqual(['d4', 'd5', 'c4', 'e6'])
  })

  it('produces a legal mainline that chess.js can replay', () => {
    const movetext = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6'
    const chess = new Chess()
    for (const san of extractMainline(movetext)) {
      expect(() => chess.move(san)).not.toThrow()
    }
    expect(chess.history().length).toBe(10)
  })
})

describe('parsePgnGames', () => {
  it('parses headers and mainline for a single game', () => {
    const pgn = `[Event "Test"]
[White "Carlsen, Magnus"]
[Black "Nakamura, Hikaru"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0`
    const games = parsePgnGames(pgn)
    expect(games).toHaveLength(1)
    expect(games[0].headers.White).toBe('Carlsen, Magnus')
    expect(games[0].headers.Result).toBe('1-0')
    expect(games[0].moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])
  })

  it('splits multiple games', () => {
    const pgn = `[Event "G1"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0

[Event "G2"]
[White "C"]
[Black "D"]
[Result "0-1"]

1. d4 d5 0-1`
    const games = parsePgnGames(pgn)
    expect(games).toHaveLength(2)
    expect(games[0].headers.Event).toBe('G1')
    expect(games[1].headers.Event).toBe('G2')
    expect(games[1].moves).toEqual(['d4', 'd5'])
  })

  it('does not treat brackets inside comments as headers', () => {
    const pgn = `[Event "Clk"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 {[%clk 0:03:00]
still my comment} e5 *`
    const games = parsePgnGames(pgn)
    expect(games).toHaveLength(1)
    expect(games[0].moves).toEqual(['e4', 'e5'])
  })

  it('unescapes quotes in header values', () => {
    const pgn = `[Event "The \\"Big\\" Open"]
[White "A"]

1. e4 *`
    const games = parsePgnGames(pgn)
    expect(games[0].headers.Event).toBe('The "Big" Open')
  })

  it('iterates lazily yielding the same games', () => {
    const pgn = `[Event "G1"]

1. e4 *

[Event "G2"]

1. d4 *`
    const fromIterator = [...iteratePgnGames(pgn)].map((g) => g.headers.Event)
    expect(fromIterator).toEqual(['G1', 'G2'])
  })
})
