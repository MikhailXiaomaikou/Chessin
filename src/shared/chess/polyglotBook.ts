import { Chess } from 'chess.js'
import { polyglotKey, parseFen } from './polyglot'

/**
 * Polyglot opening books (.bin).
 *
 * A book is a flat array of 16-byte big-endian entries — key (u64), move (u16),
 * weight (u16), learn (u32) — sorted by key, so a position's moves are found by
 * binary search on its Polyglot hash. Castling is stored as "king takes own
 * rook" (e1h1, e1a1, e8h8, e8a8) and converted to the usual king move on read.
 *
 * Works on a plain Uint8Array so the same code runs in Electron's main process
 * and in the browser build.
 */

export const BOOK_ENTRY_SIZE = 16

export interface BookEntry {
  key: bigint
  move: number
  weight: number
  learn: number
}

export interface BookMove {
  uci: string
  san: string
  weight: number
  learn: number
  /** Share of the position's total (legal) weight, 0..1. */
  probability: number
}

const PROMO_CHARS = ' nbrq'
const FILES = 'abcdefgh'

function squareName(idx: number): string {
  return FILES[idx & 7] + String((idx >> 3) + 1)
}

function squareIndex(name: string): number {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97)
}

/**
 * Convert a raw Polyglot move to UCI for a board (0..63, a1 = 0), turning
 * "king takes own rook" back into a normal castling move. The board is needed
 * because e1h1 is only castling when the piece on e1 is the king.
 */
export function polyglotMoveToUci(raw: number, board: (string | null)[]): string {
  const toIdx = raw & 0x3f
  const fromIdx = (raw >> 6) & 0x3f
  const promo = (raw >> 12) & 7
  const from = squareName(fromIdx)
  let to = squareName(toIdx)
  const piece = board[fromIdx]
  if ((piece === 'K' && from === 'e1') || (piece === 'k' && from === 'e8')) {
    if (to === 'h1') to = 'g1'
    else if (to === 'a1') to = 'c1'
    else if (to === 'h8') to = 'g8'
    else if (to === 'a8') to = 'c8'
  }
  return from + to + (promo ? PROMO_CHARS[promo] : '')
}

/**
 * Encode a move (chess.js verbose shape) the Polyglot way. Castling (flags
 * containing 'k' or 'q') is written as the king capturing its own rook.
 */
export function encodePolyglotMove(m: {
  from: string
  to: string
  promotion?: string
  flags?: string
}): number {
  let to = m.to
  if (m.flags?.includes('k')) to = 'h' + m.to[1]
  else if (m.flags?.includes('q')) to = 'a' + m.to[1]
  const promo = m.promotion ? Math.max(PROMO_CHARS.indexOf(m.promotion), 0) : 0
  return squareIndex(to) | (squareIndex(m.from) << 6) | (promo << 12)
}

export class PolyglotBook {
  private readonly view: DataView
  readonly entryCount: number

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.entryCount = Math.floor(data.byteLength / BOOK_ENTRY_SIZE)
  }

  private keyAt(i: number): bigint {
    return this.view.getBigUint64(i * BOOK_ENTRY_SIZE, false)
  }

  /** All raw entries stored under a key (binary search for the first match). */
  entries(key: bigint): BookEntry[] {
    let lo = 0
    let hi = this.entryCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.keyAt(mid) < key) lo = mid + 1
      else hi = mid
    }
    const out: BookEntry[] = []
    for (let i = lo; i < this.entryCount && this.keyAt(i) === key; i++) {
      const off = i * BOOK_ENTRY_SIZE
      out.push({
        key,
        move: this.view.getUint16(off + 8, false),
        weight: this.view.getUint16(off + 10, false),
        learn: this.view.getUint32(off + 12, false)
      })
    }
    return out
  }

  /** Book moves for a position — legal moves only, heaviest first. */
  lookup(fen: string): BookMove[] {
    const entries = this.entries(polyglotKey(fen))
    if (entries.length === 0) return []

    let legal: Map<string, string>
    try {
      const chess = new Chess(fen)
      legal = new Map(
        chess.moves({ verbose: true }).map((m) => [m.from + m.to + (m.promotion ?? ''), m.san])
      )
    } catch {
      return []
    }

    const { board } = parseFen(fen)
    const byUci = new Map<string, BookMove>()
    for (const e of entries) {
      const uci = polyglotMoveToUci(e.move, board)
      const san = legal.get(uci)
      if (!san) continue // hash collision or corrupt entry
      const existing = byUci.get(uci)
      if (existing) existing.weight += e.weight
      else byUci.set(uci, { uci, san, weight: e.weight, learn: e.learn, probability: 0 })
    }

    const moves = [...byUci.values()]
    const total = moves.reduce((sum, m) => sum + m.weight, 0)
    for (const m of moves) m.probability = total > 0 ? m.weight / total : 0
    return moves.sort((a, b) => b.weight - a.weight)
  }
}

/** Serialize entries into a valid Polyglot book (sorted by key, heaviest first). */
export function writePolyglotBook(
  entries: { key: bigint; move: number; weight: number; learn?: number }[]
): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : b.weight - a.weight
  )
  const out = new Uint8Array(sorted.length * BOOK_ENTRY_SIZE)
  const view = new DataView(out.buffer)
  sorted.forEach((e, i) => {
    const off = i * BOOK_ENTRY_SIZE
    view.setBigUint64(off, e.key, false)
    view.setUint16(off + 8, e.move, false)
    view.setUint16(off + 10, e.weight, false)
    view.setUint32(off + 12, e.learn ?? 0, false)
  })
  return out
}
