import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { MemorySource, cbSquareIndex, cbSquareName } from './bytes'
import { formatCbDate, formatCbEco, formatCbResult } from './records'
import { decodeMoves, parseStartPosition, shift } from './moves'
import { ChessBaseReader, type CbEntry, type CbGame } from './reader'
import { TRANSLATION_TABLES } from './tables'
import { encodeDatabase, compactCodeStream, type TestDatabase, type TestGame } from './testkit'

function readerFor(db: TestDatabase): ChessBaseReader {
  return new ChessBaseReader({
    cbh: new MemorySource(db.cbh),
    cbg: new MemorySource(db.cbg),
    cba: new MemorySource(db.cba),
    cbp: new MemorySource(db.cbp),
    cbt: new MemorySource(db.cbt),
    cbc: new MemorySource(db.cbc),
    cbs: new MemorySource(db.cbs)
  })
}

function entries(games: TestGame[]): CbEntry[] {
  return [...readerFor(encodeDatabase(games)).entries()]
}

function onlyGame(game: TestGame): CbGame {
  const [entry] = entries([game])
  if (entry.kind !== 'game') throw new Error(`skipped: ${entry.reason} ${entry.detail ?? ''}`)
  return entry.game
}

const OPERA_GAME =
  '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 ' +
  '8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 ' +
  '14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#'

function sanList(movetext: string, fen?: string): string[] {
  const c = new Chess(fen)
  for (const t of movetext.split(/\s+/)) if (t && !/^\d+\.+$/.test(t)) c.move(t)
  return c.history()
}

describe('ChessBase format — examples from the specification', () => {
  it('reads the start-position board bitstream (58 0e 93)', () => {
    const b = new Uint8Array(28)
    b[0] = 1
    b.set([0x58, 0x0e, 0x93], 4)
    // A white pawn on a2, a black rook on b1, a white knight on b4.
    expect(parseStartPosition(b)).toBe('8/8/8/8/1N6/8/P7/1r6 w - - 0 1')
  })

  it('numbers squares file by file and wraps vectors modulo 8', () => {
    expect(cbSquareIndex('a2')).toBe(1)
    expect(cbSquareIndex('b1')).toBe(8)
    expect(cbSquareName(63)).toBe('h8')
    // "A queen on c2 that moves by (+7, 0) reaches b2."
    expect(cbSquareName(shift(cbSquareIndex('c2'), 7, 0))).toBe('b2')
  })

  it('decodes dates, ECO codes and results', () => {
    expect(formatCbDate((2021 << 9) | (7 << 5) | 15)).toBe('2021.07.15')
    expect(formatCbDate(1999 << 9)).toBe('1999.??.??')
    expect(formatCbDate(0)).toBe('????.??.??')
    expect(formatCbEco(191 * 128)).toBe('B90')
    expect(formatCbEco(128 + 5)).toBe('A00') // sub-ECO ignored
    expect(formatCbEco(0)).toBeUndefined()
    expect(formatCbEco(64576 + 518)).toBeUndefined() // a Chess960 start position
    expect([0, 1, 2, 3, 6, 7].map(formatCbResult)).toEqual(['0-1', '1/2-1/2', '1-0', '*', '1-0', '*'])
  })

  it('has permutation tables for the published modes', () => {
    for (const mode of [0, 4, 5, 10]) expect(new Set(TRANSLATION_TABLES[mode]).size).toBe(256)
  })

  it('writes the variation example as the spec describes', () => {
    // e4 254 c5 Nf3 254 d6 d4 255 Nc6 Bb5 255 254 c6 d4 255 Nf6 e5 255,
    // with each move as its code worked out from the code table by hand.
    const stream = compactCodeStream(
      '1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4'
    )
    expect(stream).toEqual([128, 254, 120, 105, 254, 123, 124, 255, 101, 84, 255, 254, 119, 124, 255, 108, 127, 255])
  })

  it('reads the variation example back as PGN', () => {
    const game = onlyGame({
      movetext: '1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4'
    })
    expect(game.movetext).toBe(
      '1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4 *'
    )
    expect(game.moves).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4'])
  })

  it('numbers moves in stored order for annotations', () => {
    const db = encodeDatabase([{ movetext: '1. e4 c5 (1... c6 2. d4) 2. Nf3' }])
    const { roots } = decodeMoves(db.cbg.subarray(26))
    const [e4] = roots
    const [c5, c6] = e4.children
    // "the positions are e4 0, c5 1, Nf3 2, c6 3, d4 4"
    expect([e4.index, c5.index, c5.children[0].index, c6.index, c6.children[0].index]).toEqual([0, 1, 2, 3, 4])
  })
})

describe('ChessBase reader — round trips', () => {
  it('follows the renumbering of captured pieces (the Opera Game)', () => {
    const game = onlyGame({ movetext: OPERA_GAME, result: '1-0' })
    expect(game.moves).toEqual(sanList(OPERA_GAME))
    expect(game.movetext.endsWith('17. Rd8# 1-0')).toBe(true)
  })

  it('decodes the same game identically in modes 0, 4 and 5 and with two-byte moves', () => {
    const expected = sanList(OPERA_GAME)
    for (const game of [
      { mode: 0 },
      { mode: 4 },
      { mode: 5 },
      { mode: 0, twoByte: [0, 3, 7, 12, 20, 25, 32] },
      { mode: 4, twoByte: [1, 2, 30] }
    ] as TestGame[]) {
      expect(onlyGame({ ...game, movetext: OPERA_GAME }).moves).toEqual(expected)
    }
  })

  it('handles castling, en passant, a null move and variations', () => {
    const game = onlyGame({
      movetext:
        '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O Bc5 5. d4 exd4 6. e5 d5 7. exd6 (7. Bb5 --) 7... O-O 8. dxc7 Qxc7'
    })
    expect(game.movetext).toBe(
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O Bc5 5. d4 exd4 6. e5 d5 7. exd6 (7. Bb5 --) 7... O-O 8. dxc7 Qxc7 *'
    )
    for (const mode of [4, 5]) {
      const again = onlyGame({ mode, movetext: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O Bc5 5. d4 exd4 6. e5 d5 7. exd6 (7. Bb5 --) 7... O-O 8. dxc7 Qxc7' })
      expect(again.movetext).toBe(game.movetext)
    }
  })

  it('stops the indexed main line at a null move', () => {
    const game = onlyGame({ movetext: '1. e4 -- 2. d4 d5' })
    expect(game.moves).toEqual(['e4'])
    expect(game.movetext).toBe('1. e4 -- 2. d4 d5 *')
  })

  it('handles promotions, under-promotions and a fourth queen', () => {
    const fen = '4k3/P7/8/8/8/8/8/QQQ1K3 w - - 0 1'
    const c = new Chess(fen)
    const sans = ['a7a8q', 'e8d7', 'a8a4'].map(
      (u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san
    )
    // The new queen is White's fourth, so its moves need two bytes.
    const game = onlyGame({ startFen: fen, movetext: sans.join(' ') })
    expect(game.moves).toEqual(sans)
    expect(game.headers.FEN).toBe(fen)
    expect(game.headers.SetUp).toBe('1')

    const under = onlyGame({ startFen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', movetext: 'e8=N+ Kf7' })
    expect(under.moves).toEqual(['e8=N+', 'Kf7'])
  })

  it('reads a set-up start position with black to move and en passant', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3'
    const game = onlyGame({ startFen: fen, movetext: '3... dxe3 4. fxe3 Nf6' })
    expect(game.headers.FEN).toBe(fen)
    expect(game.moves).toEqual(['dxe3', 'fxe3', 'Nf6'])
    expect(game.movetext).toBe('3... dxe3 4. fxe3 Nf6 *')
  })

  it('carries comments, symbols, coloured squares and arrows into PGN', () => {
    const text = (s: string | number[]) => [0, 0, ...(typeof s === 'string' ? new TextEncoder().encode(s) : s)]
    const e4 = cbSquareIndex('e4') + 1
    const e2 = cbSquareIndex('e2') + 1
    const game = onlyGame({
      movetext: '1. e4 e5 2. Nf3 Nc6',
      annotations: [
        { pos: -1, type: 0x02, data: text('Game intro') },
        { pos: 0, type: 0x03, data: [1] },
        { pos: 0, type: 0x02, data: text('Best by test') },
        { pos: 0, type: 0x04, data: [2, e4] },
        { pos: 0, type: 0x05, data: [4, e2, e4] },
        { pos: 1, type: 0x82, data: text('Symmetry:') },
        // Windows-1252 "Häh", a diagram marker, then "!"
        { pos: 2, type: 0x02, data: text([0x48, 0xe4, 0x68, 0x9e, 0x21]) },
        { pos: 3, type: 0x02, data: text('丁立人 {braces}') }
      ]
    })
    // The comment before 1...e5 merges with the one after 1.e4.
    expect(game.movetext).toBe(
      '{Game intro} 1. e4 $1 {Best by test [%csl Ge4] [%cal Re2e4] Symmetry:} 1... e5 ' +
        '2. Nf3 {Häh#!} 2... Nc6 {丁立人 (braces)} *'
    )
    // chess.js can load what we produce.
    expect(() => new Chess().loadPgn(game.pgn)).not.toThrow()
  })

  it('fills the PGN headers from the entity files', () => {
    const game = onlyGame({
      white: 'Carlsen, Magnus',
      black: 'Müller, Hans',
      event: 'World Cup',
      site: 'Baku',
      year: 2021,
      month: 7,
      round: 3,
      subround: 2,
      whiteElo: 2847,
      blackElo: 2505,
      eco: 'C65',
      annotator: 'Kasparov',
      source: 'Mega 2024',
      result: '1/2-1/2',
      movetext: '1. e4 e5'
    })
    expect(game.headers).toEqual({
      Event: 'World Cup',
      Site: 'Baku',
      Date: '2021.07.??',
      Round: '3.2',
      White: 'Carlsen, Magnus',
      Black: 'Müller, Hans',
      Result: '1/2-1/2',
      WhiteElo: '2847',
      BlackElo: '2505',
      ECO: 'C65',
      Annotator: 'Kasparov',
      Source: 'Mega 2024'
    })
    expect(game.pgn).toContain('[Black "Müller, Hans"]')
  })

  it('uses placeholders for blank entities', () => {
    const game = onlyGame({ movetext: '1. d4' })
    expect(game.headers).toMatchObject({ White: '?', Black: '?', Event: '?', Site: '?', Round: '?' })
    expect(game.headers.Annotator).toBeUndefined()
  })

  it('skips deleted games, guiding texts, unknown encodings and corrupt records', () => {
    const missingRook = TRANSLATION_TABLES[0].indexOf(199) // "3rd rook" — there is none
    const result = entries([
      { movetext: '1. e4', white: 'A' },
      { movetext: '1. d4', deleted: true },
      { guidingText: true, rawMoves: [0x80, 0, 0, 4] },
      { rawMoves: [1, 0, 0, 6, 0, 0] }, // mode 1: no public table
      { rawMoves: [0, 0, 0, 5, missingRook] },
      { movetext: '1. c4', white: 'B' }
    ])
    expect(result.map((e) => (e.kind === 'game' ? e.game.headers.White : e.reason))).toEqual([
      'A',
      'deleted',
      'guiding-text',
      'unsupported-encoding',
      'corrupt',
      'B'
    ])
  })

  it('handles an empty game', () => {
    for (const mode of [0, 5]) {
      const game = onlyGame({ mode, movetext: '', result: '*' })
      expect(game.moves).toEqual([])
      expect(game.movetext).toBe('*')
    }
  })
})
