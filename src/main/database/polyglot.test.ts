import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { polyglotKey, toSignedKey, parseFen, PolyglotHasher } from './polyglot'

/** Play SAN moves from the start position and return the resulting FEN. */
function fenAfter(moves: string[]): string {
  const chess = new Chess()
  for (const m of moves) chess.move(m)
  return chess.fen()
}

describe('polyglotKey', () => {
  // Canonical PolyGlot test vectors. FENs are produced by chess.js so only the
  // published keys are hard-coded — this also exercises the conditional
  // en-passant rule (1.e4 has an ep target but no legal capturer, while
  // 1.e4 d5 2.e5 f5 has one).
  const cases: [string, string[], bigint][] = [
    ['starting position', [], 0x463b96181691fc9cn],
    ['after 1.e4', ['e4'], 0x823c9b50fd114196n],
    ['after 1.e4 d5', ['e4', 'd5'], 0x0756b94461c50fb0n],
    ['after 1.e4 d5 2.e5', ['e4', 'd5', 'e5'], 0x662fafb965db29d4n],
    ['after 1.e4 d5 2.e5 f5', ['e4', 'd5', 'e5', 'f5'], 0x22a48b5a8e47ff78n],
    ['after 1.e4 d5 2.e5 f5 3.Ke2', ['e4', 'd5', 'e5', 'f5', 'Ke2'], 0x652a607ca3f242c1n],
    [
      'after 1.e4 d5 2.e5 f5 3.Ke2 Kf7',
      ['e4', 'd5', 'e5', 'f5', 'Ke2', 'Kf7'],
      0x00fdd303c946bdd9n
    ]
  ]

  for (const [name, moves, expected] of cases) {
    it(name, () => {
      expect(polyglotKey(fenAfter(moves))).toBe(expected)
    })
  }

  it('is stable across equal positions reached by different move orders', () => {
    const a = polyglotKey(fenAfter(['e4', 'e5', 'Nf3']))
    const b = polyglotKey(fenAfter(['Nf3', 'e5', 'e4']))
    expect(a).toBe(b)
  })

  it('distinguishes side to move', () => {
    const white = polyglotKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    const black = polyglotKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1')
    expect(white).not.toBe(black)
  })
})

describe('PolyglotHasher (incremental)', () => {
  // The incremental key must equal the full FEN-based key after every move.
  function checkGame(name: string, moves: string[]) {
    it(name, () => {
      const chess = new Chess()
      const hasher = new PolyglotHasher(chess.fen())
      expect(hasher.current()).toBe(polyglotKey(chess.fen()))
      for (const san of moves) {
        const mv = chess.move(san)
        hasher.apply(mv)
        expect(hasher.current()).toBe(polyglotKey(chess.fen()))
      }
    })
  }

  checkGame('castling on both wings', [
    'd4', 'd5', 'Nc3', 'Nc6', 'Bf4', 'Bf5', 'Qd2', 'Qd7', 'O-O-O', 'O-O-O'
  ])
  checkGame('kingside castling', [
    'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O', 'Bc5', 'Re1', 'O-O'
  ])
  checkGame('en passant capture', ['e4', 'a6', 'e5', 'd5', 'exd6'])
  checkGame('capture-promotions for both sides', [
    'a4', 'h5', 'a5', 'h4', 'a6', 'h3', 'axb7', 'hxg2', 'bxa8=Q', 'gxh1=Q'
  ])
  checkGame('a longer tactical game', [
    'e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6',
    'Be2', 'e5', 'Nb3', 'Be7', 'O-O', 'O-O', 'Be3', 'Be6', 'Qd2', 'Nbd7'
  ])
})

describe('toSignedKey', () => {
  it('round-trips through the signed/unsigned boundary', () => {
    const big = 0xffffffffffffffffn
    expect(toSignedKey(big)).toBe(-1n)
    expect(toSignedKey(0n)).toBe(0n)
    expect(toSignedKey(0x463b96181691fc9cn)).toBe(0x463b96181691fc9cn)
  })
})

describe('parseFen', () => {
  it('places a1 at index 0 and h8 at index 63', () => {
    const { board } = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    expect(board[0]).toBe('R') // a1
    expect(board[4]).toBe('K') // e1
    expect(board[63]).toBe('r') // h8
    expect(board[60]).toBe('k') // e8
    expect(board[32]).toBeNull() // a5
  })
})
