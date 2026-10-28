import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { polyglotKey } from './polyglot'
import {
  PolyglotBook,
  writePolyglotBook,
  encodePolyglotMove,
  polyglotMoveToUci,
  BOOK_ENTRY_SIZE
} from './polyglotBook'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function chessAfter(moves: string[]): Chess {
  const c = new Chess()
  for (const m of moves) c.move(m)
  return c
}

/** A book entry for playing `san` in the position reached by `moves`. */
function entry(moves: string[], san: string, weight: number) {
  const chess = chessAfter(moves)
  const key = polyglotKey(chess.fen())
  const mv = chess.move(san)
  return { key, move: encodePolyglotMove(mv), weight }
}

describe('Polyglot move encoding', () => {
  it('encodes to/from squares in the low 12 bits', () => {
    // e2e4: to = e4 (28), from = e2 (12) -> 28 | 12 << 6
    expect(encodePolyglotMove({ from: 'e2', to: 'e4' })).toBe(28 | (12 << 6))
  })

  it('writes castling as king-takes-rook and reads it back', () => {
    const raw = encodePolyglotMove({ from: 'e1', to: 'g1', flags: 'k' })
    expect(raw & 0x3f).toBe(7) // h1
    const board = Array<string | null>(64).fill(null)
    board[4] = 'K'
    expect(polyglotMoveToUci(raw, board)).toBe('e1g1')
  })

  it('does not treat a rook move e1-h1 as castling', () => {
    const board = Array<string | null>(64).fill(null)
    board[4] = 'R'
    const raw = encodePolyglotMove({ from: 'e1', to: 'h1' })
    expect(polyglotMoveToUci(raw, board)).toBe('e1h1')
  })

  it('round-trips promotions', () => {
    const raw = encodePolyglotMove({ from: 'b7', to: 'a8', promotion: 'n' })
    expect((raw >> 12) & 7).toBe(1)
    expect(polyglotMoveToUci(raw, Array(64).fill(null))).toBe('b7a8n')
  })
})

describe('PolyglotBook', () => {
  const book = new PolyglotBook(
    writePolyglotBook([
      entry([], 'e4', 3),
      entry([], 'd4', 1),
      entry(['e4'], 'e5', 2),
      entry(['e4'], 'c5', 2)
    ])
  )

  it('reports the entry count', () => {
    expect(book.entryCount).toBe(4)
  })

  it('looks up weighted book moves', () => {
    const moves = book.lookup(START)
    expect(moves.map((m) => m.san)).toEqual(['e4', 'd4'])
    expect(moves[0].uci).toBe('e2e4')
    expect(moves[0].probability).toBeCloseTo(0.75)
    expect(moves[1].probability).toBeCloseTo(0.25)
  })

  it('returns moves for the reply position', () => {
    const moves = book.lookup(chessAfter(['e4']).fen())
    expect(moves.map((m) => m.san).sort()).toEqual(['c5', 'e5'])
    expect(moves.every((m) => m.probability === 0.5)).toBe(true)
  })

  it('returns nothing for positions out of book', () => {
    expect(book.lookup(chessAfter(['a3']).fen())).toEqual([])
  })

  it('handles castling for both colours', () => {
    const whiteLine = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']
    const blackLine = ['d4', 'd5', 'Nc3', 'Nc6', 'Bf4', 'Bf5', 'Qd2', 'Qd7', 'O-O-O']
    const castleBook = new PolyglotBook(
      writePolyglotBook([entry(whiteLine, 'O-O', 5), entry(blackLine, 'O-O-O', 5)])
    )
    const w = castleBook.lookup(chessAfter(whiteLine).fen())
    expect(w[0]).toMatchObject({ san: 'O-O', uci: 'e1g1' })
    const b = castleBook.lookup(chessAfter(blackLine).fen())
    expect(b[0]).toMatchObject({ san: 'O-O-O', uci: 'e8c8' })
  })

  it('skips entries whose move is illegal in the position', () => {
    const bad = new PolyglotBook(
      writePolyglotBook([
        { key: polyglotKey(START), move: encodePolyglotMove({ from: 'e2', to: 'e5' }), weight: 9 },
        entry([], 'Nf3', 1)
      ])
    )
    const moves = bad.lookup(START)
    expect(moves.map((m) => m.san)).toEqual(['Nf3'])
    expect(moves[0].probability).toBe(1)
  })

  it('finds entries by binary search among many keys', () => {
    // Deterministic 64-bit noise keys around a few real positions.
    let s = 0x9e3779b97f4a7c15n
    const next = () => {
      s ^= (s << 13n) & 0xffffffffffffffffn
      s ^= s >> 7n
      s ^= (s << 17n) & 0xffffffffffffffffn
      return s & 0xffffffffffffffffn
    }
    const noise = Array.from({ length: 500 }, () => ({ key: next(), move: 28 | (12 << 6), weight: 1 }))
    const lines = [[], ['e4'], ['d4', 'd5'], ['c4', 'e5', 'Nc3']]
    const big = new PolyglotBook(
      writePolyglotBook([...noise, ...lines.map((l) => entry(l, l.length % 2 ? 'Nf6' : 'Nf3', 7))])
    )
    expect(big.entryCount * BOOK_ENTRY_SIZE).toBe((500 + lines.length) * BOOK_ENTRY_SIZE)
    for (const l of lines) {
      const moves = big.lookup(chessAfter(l).fen())
      expect(moves).toHaveLength(1)
      expect(moves[0].weight).toBe(7)
    }
  })
})
