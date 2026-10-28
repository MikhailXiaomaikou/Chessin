import { Chess, type Move, type Square } from 'chess.js'
import { TRANSLATION_TABLES } from './tables'
import { u24be, cbSquareName, cbSquareIndex } from './bytes'

/**
 * Decoder for the moves of one game in a .cbg file (Morphy specification,
 * format/v1/2-moves.md).
 *
 * Every byte is first translated through a per-mode permutation together with
 * a counter of the moves decoded so far. In the compact encoding a byte then
 * names *which* piece moves — the first rook, the second knight, the c-pawn —
 * and a vector taken modulo 8, so the decoder keeps ChessBase's numbering of
 * the pieces alongside the board. 254 and 255 open and close variations.
 */

export interface CbMoveNode {
  san: string
  /** Order in which the move was decoded — what annotations refer to. */
  index: number
  color: 'w' | 'b'
  moveNumber: number
  /** Continuations; the first is the main line. */
  children: CbMoveNode[]
}

export interface DecodedMoves {
  /** FEN of a set-up start position; undefined for the usual one. */
  startFen?: string
  /** Moves from the start position; the first is the main line. */
  roots: CbMoveNode[]
}

export class CbgFormatError extends Error {}

export class UnsupportedEncodingError extends Error {
  constructor(readonly mode: number) {
    super(`encoding mode ${mode} is not supported`)
  }
}

// Modes whose translation table is public and whose game is ordinary chess.
// Mode 10 (Chess960) is published too, but chess.js cannot play Chess960.
const ENCODINGS: Record<number, { compact: boolean; pre: boolean }> = {
  0: { compact: true, pre: true },
  4: { compact: true, pre: false },
  5: { compact: false, pre: false }
}

export type Translate = (byte: number, n: number) => number

export function translator(mode: number): Translate {
  const enc = ENCODINGS[mode]
  const table = TRANSLATION_TABLES[mode]
  if (!enc || !table) throw new UnsupportedEncodingError(mode)
  return enc.pre ? (b, n) => table[(b - n) & 0xff] : (b, n) => (table[b] - n) & 0xff
}

export function isCompact(mode: number): boolean {
  return ENCODINGS[mode]?.compact ?? false
}

type PieceType = 'k' | 'q' | 'r' | 'b' | 'n'

/** Squares of one side's pieces in ChessBase's order; pawns keep a fixed slot. */
export interface SidePieces {
  k: number[]
  q: number[]
  r: number[]
  b: number[]
  n: number[]
  /** Square of each numbered pawn, −1 once it is gone. */
  pawns: number[]
}

export interface PieceLists {
  w: SidePieces
  b: SidePieces
}

function emptySide(): SidePieces {
  return { k: [], q: [], r: [], b: [], n: [], pawns: [] }
}

function cloneLists(l: PieceLists): PieceLists {
  const side = (s: SidePieces): SidePieces => ({
    k: [...s.k],
    q: [...s.q],
    r: [...s.r],
    b: [...s.b],
    n: [...s.n],
    pawns: [...s.pawns]
  })
  return { w: side(l.w), b: side(l.b) }
}

/** Number the pieces by scanning the squares a1, a2, … a8, b1, … h8. */
export function pieceListsFor(chess: Chess): PieceLists {
  const lists: PieceLists = { w: emptySide(), b: emptySide() }
  for (let sq = 0; sq < 64; sq++) {
    const p = chess.get(cbSquareName(sq) as Square)
    if (!p) continue
    if (p.type === 'p') lists[p.color].pawns.push(sq)
    else lists[p.color][p.type as PieceType].push(sq)
  }
  return lists
}

/** Square reached from `sq` by (dx, dy), each coordinate modulo 8. */
export function shift(sq: number, dx: number, dy: number): number {
  return (((sq >> 3) + dx) & 7) * 8 + (((sq & 7) + dy) & 7)
}

export const KING_STEPS: readonly [number, number][] = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]
]
export const KNIGHT_STEPS: readonly [number, number][] = [
  [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]
]
export const QUEEN_RAYS: readonly [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]]
export const ROOK_RAYS: readonly [number, number][] = [[0, 1], [1, 0]]
export const BISHOP_RAYS: readonly [number, number][] = [[1, 1], [1, -1]]

/** First code of each numbered piece in the compact encoding. */
export const CODE_BASE = {
  q: [11, 143, 171],
  r: [39, 53, 199],
  b: [67, 81, 213],
  n: [95, 103, 227]
} as const
export const PAWN_BASE = 111

export const PROMOTIONS = ['q', 'r', 'b', 'n'] as const

function slide(from: number, rays: readonly [number, number][], k: number): number {
  const [dx, dy] = rays[Math.floor(k / 7)]
  const s = (k % 7) + 1
  return shift(from, dx * s, dy * s)
}

const PIECE_CODES: Record<number, string> = { 1: 'k', 2: 'q', 3: 'n', 4: 'b', 5: 'r', 6: 'p' }

/**
 * The 28-byte start position: en passant file and side to move, castling
 * rights, move number, then a 192-bit board listing a1, a2, … h8.
 */
export function parseStartPosition(b: Uint8Array): string {
  const epFile = b[1] & 0x0f
  const black = (b[1] & 0x10) !== 0
  const castle = b[2]
  const moveNumber = b[3] || 1

  const board: (string | null)[] = new Array(64).fill(null)
  let bit = 0
  const read = (): number => {
    const v = (b[4 + (bit >> 3)] >> (7 - (bit & 7))) & 1
    bit++
    return v
  }
  for (let sq = 0; sq < 64 && bit < 192; sq++) {
    if (!read()) continue
    const white = read() === 0
    const type = PIECE_CODES[(read() << 2) | (read() << 1) | read()]
    if (!type) throw new CbgFormatError('bad piece in start position')
    board[sq] = white ? type.toUpperCase() : type
  }

  const ranks: string[] = []
  for (let rank = 7; rank >= 0; rank--) {
    let row = ''
    let empty = 0
    for (let file = 0; file < 8; file++) {
      const p = board[file * 8 + rank]
      if (!p) {
        empty++
        continue
      }
      if (empty) row += empty
      empty = 0
      row += p
    }
    ranks.push(empty ? row + empty : row)
  }
  let castling = ''
  if (castle & 2) castling += 'K'
  if (castle & 1) castling += 'Q'
  if (castle & 8) castling += 'k'
  if (castle & 4) castling += 'q'
  const ep = epFile ? 'abcdefgh'[epFile - 1] + (black ? '3' : '6') : '-'
  return `${ranks.join('/')} ${black ? 'b' : 'w'} ${castling || '-'} ${ep} 0 ${moveNumber}`
}

interface SavedState {
  fen: string
  lists: PieceLists
  current: CbMoveNode | null
}

class Decoder {
  readonly roots: CbMoveNode[] = []
  private chess: Chess
  private lists: PieceLists
  private current: CbMoveNode | null = null
  private readonly stack: SavedState[] = []
  private n = 0

  constructor(startFen: string | undefined) {
    try {
      this.chess = startFen ? new Chess(startFen) : new Chess()
    } catch (err) {
      throw new CbgFormatError(`invalid start position: ${(err as Error).message}`)
    }
    this.lists = pieceListsFor(this.chess)
  }

  private push(): void {
    this.stack.push({ fen: this.chess.fen(), lists: cloneLists(this.lists), current: this.current })
  }

  /** Back to the last remembered position; false when the game is over. */
  private pop(): boolean {
    const saved = this.stack.pop()
    if (!saved) return false
    this.chess.load(saved.fen)
    this.lists = saved.lists
    this.current = saved.current
    return true
  }

  private addNode(san: string, color: 'w' | 'b', moveNumber: number): void {
    const node: CbMoveNode = { san, index: this.n, color, moveNumber, children: [] }
    if (this.current) this.current.children.push(node)
    else this.roots.push(node)
    this.current = node
  }

  private play(from: number, to: number, promotion?: string): void {
    const color = this.chess.turn()
    const moveNumber = this.chess.moveNumber()
    let mv: Move
    try {
      mv = this.chess.move({ from: cbSquareName(from), to: cbSquareName(to), promotion })
    } catch {
      throw new CbgFormatError(`illegal move ${cbSquareName(from)}${cbSquareName(to)} (move ${this.n})`)
    }
    this.update(mv)
    this.addNode(mv.san, color, moveNumber)
  }

  /** A move given by its squares, as in two-byte moves and the simple encoding. */
  private playSquares(from: number, to: number, promoBits: number): void {
    const piece = this.chess.get(cbSquareName(from) as Square)
    const lastRank = (to & 7) === 0 || (to & 7) === 7
    this.play(from, to, piece?.type === 'p' && lastRank ? PROMOTIONS[promoBits] : undefined)
  }

  private playNull(): void {
    const color = this.chess.turn()
    const moveNumber = this.chess.moveNumber()
    const f = this.chess.fen().split(' ')
    f[1] = color === 'w' ? 'b' : 'w'
    f[3] = '-'
    if (color === 'b') f[5] = String(Number(f[5]) + 1)
    try {
      this.chess.load(f.join(' '))
    } catch {
      throw new CbgFormatError(`null move from an illegal position (move ${this.n})`)
    }
    this.addNode('--', color, moveNumber)
  }

  /** Keep the piece numbering in step with a move just played. */
  private update(mv: Move): void {
    const side = this.lists[mv.color]
    const opp = this.lists[mv.color === 'w' ? 'b' : 'w']
    const from = cbSquareIndex(mv.from)
    const to = cbSquareIndex(mv.to)

    if (mv.captured) {
      const at = mv.flags.includes('e') ? cbSquareIndex(mv.to[0] + mv.from[1]) : to
      if (mv.captured === 'p') {
        const i = opp.pawns.indexOf(at)
        if (i >= 0) opp.pawns[i] = -1 // a pawn keeps its number
      } else {
        const list = opp[mv.captured as PieceType]
        const i = list.indexOf(at)
        if (i >= 0) list.splice(i, 1) // the pieces above it move down one
      }
    }

    if (mv.piece === 'p') {
      const i = side.pawns.indexOf(from)
      if (mv.promotion) {
        if (i >= 0) side.pawns[i] = -1
        side[mv.promotion as PieceType].push(to)
      } else if (i >= 0) {
        side.pawns[i] = to
      }
    } else {
      const list = side[mv.piece as PieceType]
      const i = list.indexOf(from)
      if (i >= 0) list[i] = to
    }

    if (mv.flags.includes('k') || mv.flags.includes('q')) {
      const kingside = mv.flags.includes('k')
      const rank = mv.from[1]
      const i = side.r.indexOf(cbSquareIndex((kingside ? 'h' : 'a') + rank))
      if (i >= 0) side.r[i] = cbSquareIndex((kingside ? 'f' : 'd') + rank)
    }
  }

  private nth(list: number[], i: number, code: number): number {
    const sq = list[i]
    if (sq === undefined || sq < 0) throw new CbgFormatError(`code ${code} names a missing piece`)
    return sq
  }

  /** From and to squares of a one-byte compact move. */
  private compactSquares(code: number): [number, number] {
    const color = this.chess.turn()
    const s = this.lists[color]
    if (code <= 8) {
      const k = this.nth(s.k, 0, code)
      const [dx, dy] = KING_STEPS[code - 1]
      return [k, shift(k, dx, dy)]
    }
    if (code === 9 || code === 10) {
      const k = this.nth(s.k, 0, code)
      return [k, (code === 9 ? 6 : 2) * 8 + (k & 7)]
    }
    if (code >= PAWN_BASE && code < PAWN_BASE + 32) {
      const k = code - PAWN_BASE
      const sq = this.nth(s.pawns, k >> 2, code)
      const f = color === 'w' ? 1 : -1
      const [dx, dy] = ([[0, f], [0, 2 * f], [f, f], [-f, f]] as const)[k & 3]
      return [sq, shift(sq, dx, dy)]
    }
    for (const type of ['q', 'r', 'b', 'n'] as const) {
      const bases = CODE_BASE[type]
      const span = type === 'q' ? 28 : type === 'n' ? 8 : 14
      for (let i = 0; i < 3; i++) {
        const k = code - bases[i]
        if (k < 0 || k >= span) continue
        const from = this.nth(s[type], i, code)
        if (type === 'n') {
          const [dx, dy] = KNIGHT_STEPS[k]
          return [from, shift(from, dx, dy)]
        }
        return [from, slide(from, type === 'q' ? QUEEN_RAYS : type === 'r' ? ROOK_RAYS : BISHOP_RAYS, k)]
      }
    }
    throw new CbgFormatError(`unknown move code ${code}`)
  }

  decodeCompact(stream: Uint8Array, translate: Translate): void {
    let i = 0
    while (i < stream.length) {
      const code = translate(stream[i++], this.n)
      if (code === 255) {
        if (!this.pop()) return
        continue
      }
      if (code === 254) {
        this.push()
        continue
      }
      if (code === 236) continue
      if (code === 235) {
        if (i + 2 > stream.length) throw new CbgFormatError('truncated two-byte move')
        const v = (translate(stream[i], this.n) << 8) | translate(stream[i + 1], this.n)
        i += 2
        this.playSquares(v & 63, (v >> 6) & 63, (v >> 12) & 3)
      } else if (code === 0) {
        this.playNull()
      } else {
        const [from, to] = this.compactSquares(code)
        this.play(from, to)
      }
      this.n++
    }
  }

  decodeSimple(stream: Uint8Array, translate: Translate): void {
    for (let i = 0; i + 1 < stream.length; i += 2) {
      const v = (translate(stream[i], this.n) << 8) | translate(stream[i + 1], this.n)
      if (v & 0x8000) this.push()
      const from = v & 63
      const to = (v >> 6) & 63
      if (from === 0 && to === 0) this.playNull()
      else this.playSquares(from, to, (v >> 12) & 3)
      this.n++
      if (v & 0x4000 && !this.pop()) return
    }
  }
}

/** Decode one game record from the .cbg file (flags, size, start position, moves). */
export function decodeMoves(rec: Uint8Array): DecodedMoves {
  if (rec.length < 4) throw new CbgFormatError('move record too short')
  const flags = rec[0]
  const size = Math.min(u24be(rec, 1), rec.length)
  const mode = flags & 0x3f
  const translate = translator(mode)

  let offset = 4
  let startFen: string | undefined
  if (flags & 0x40) {
    if (size < 32) throw new CbgFormatError('truncated start position')
    startFen = parseStartPosition(rec.subarray(4, 32))
    offset = 32
  }

  const decoder = new Decoder(startFen)
  const stream = rec.subarray(offset, size)
  if (isCompact(mode)) decoder.decodeCompact(stream, translate)
  else decoder.decodeSimple(stream, translate)
  return { startFen, roots: decoder.roots }
}
