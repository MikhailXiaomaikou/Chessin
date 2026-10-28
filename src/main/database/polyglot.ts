import {
  POLYGLOT_RANDOM,
  RANDOM_CASTLE,
  RANDOM_EN_PASSANT,
  RANDOM_TURN
} from './polyglotRandom'

/**
 * Polyglot Zobrist hashing.
 *
 * Produces the standard 64-bit position key used by the PolyGlot opening-book
 * format. We use it to index every position of every game so that we can answer
 * "which games reached this position?" and build an opening tree with W/D/L
 * statistics — the core capability a serious chess database needs.
 *
 * The hash is well specified, which lets us verify it against published test
 * vectors (see polyglot.test.ts). The one subtle rule: the en-passant term is
 * only mixed in when a pawn of the side to move can actually make the capture.
 */

const MASK64 = (1n << 64n) - 1n

// kind_of_piece index per the PolyGlot spec: black pieces even, white odd.
const PIECE_KIND: Record<string, number> = {
  p: 0,
  P: 1,
  n: 2,
  N: 3,
  b: 4,
  B: 5,
  r: 6,
  R: 7,
  q: 8,
  Q: 9,
  k: 10,
  K: 11
}

export interface ParsedFen {
  /** Board as a 0..63 array, index = 8 * row + file, row 0 = rank 1, file 0 = a-file. */
  board: (string | null)[]
  turn: 'w' | 'b'
  castling: string
  ep: string
}

/** Parse a FEN's board, side-to-move, castling and en-passant fields. */
export function parseFen(fen: string): ParsedFen {
  const parts = fen.trim().split(/\s+/)
  const placement = parts[0] || ''
  const turn = parts[1] === 'b' ? 'b' : 'w'
  const castling = parts[2] ?? '-'
  const ep = parts[3] ?? '-'

  const board: (string | null)[] = new Array(64).fill(null)
  const ranks = placement.split('/') // ranks[0] is rank 8
  for (let r = 0; r < ranks.length; r++) {
    const row = 7 - r // FEN starts at the 8th rank
    let file = 0
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '9') {
        file += ch.charCodeAt(0) - 48
      } else if (file < 8) {
        board[row * 8 + file] = ch
        file++
      }
    }
  }
  return { board, turn, castling, ep }
}

/** Compute the unsigned 64-bit Polyglot Zobrist key for a position given as FEN. */
export function polyglotKey(fen: string): bigint {
  const { board, turn, castling, ep } = parseFen(fen)
  let key = 0n

  // Piece placement
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq]
    if (!piece) continue
    const kind = PIECE_KIND[piece]
    if (kind === undefined) continue
    const row = sq >> 3
    const file = sq & 7
    key ^= POLYGLOT_RANDOM[64 * kind + 8 * row + file]
  }

  // Castling rights (standard FEN letters)
  if (castling.includes('K')) key ^= POLYGLOT_RANDOM[RANDOM_CASTLE + 0]
  if (castling.includes('Q')) key ^= POLYGLOT_RANDOM[RANDOM_CASTLE + 1]
  if (castling.includes('k')) key ^= POLYGLOT_RANDOM[RANDOM_CASTLE + 2]
  if (castling.includes('q')) key ^= POLYGLOT_RANDOM[RANDOM_CASTLE + 3]

  // En passant — only counted when a pawn of the side to move can capture.
  if (ep.length === 2) {
    const file = ep.charCodeAt(0) - 97 // 'a' -> 0
    if (file >= 0 && file < 8) {
      // The pawn that would capture sits on the 5th rank (row 4) for White,
      // the 4th rank (row 3) for Black, on a file adjacent to the ep file.
      const capRow = turn === 'w' ? 4 : 3
      const capPawn = turn === 'w' ? 'P' : 'p'
      const left = file > 0 && board[capRow * 8 + file - 1] === capPawn
      const right = file < 7 && board[capRow * 8 + file + 1] === capPawn
      if (left || right) key ^= POLYGLOT_RANDOM[RANDOM_EN_PASSANT + file]
    }
  }

  // Side to move
  if (turn === 'w') key ^= POLYGLOT_RANDOM[RANDOM_TURN]

  return key & MASK64
}

/**
 * Convert an unsigned 64-bit key to the signed form SQLite stores in an INTEGER
 * column. Equality still works because we apply the same transform on query.
 */
export function toSignedKey(key: bigint): bigint {
  return key >= 1n << 63n ? key - (1n << 64n) : key
}

// --- Incremental hashing (fast path for indexing whole games) ---------------

function sqToIdx(sq: string): number {
  return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97)
}

const CASTLE_BIT: Record<string, number> = { K: 0, Q: 1, k: 2, q: 3 }
// Corner square -> the castling right lost if a rook leaves/is captured there.
const CORNER_RIGHT: Record<number, string> = {
  [sqToIdx('a1')]: 'Q',
  [sqToIdx('h1')]: 'K',
  [sqToIdx('a8')]: 'q',
  [sqToIdx('h8')]: 'k'
}

/** Minimal shape of a chess.js verbose move that the hasher needs. */
export interface HasherMove {
  color: 'w' | 'b'
  from: string
  to: string
  piece: string
  captured?: string
  promotion?: string
  flags: string
}

/**
 * Maintains a running Polyglot key as moves are applied, avoiding a FEN
 * build+parse per ply. Seeded from a verified full-position key so it stays in
 * lockstep with {@link polyglotKey} (enforced by tests).
 */
export class PolyglotHasher {
  private board: (string | null)[]
  private castling: Set<string>
  private epFile: number | null
  private key: bigint

  constructor(fen: string) {
    const parsed = parseFen(fen)
    this.board = parsed.board.slice()
    this.castling = new Set([...parsed.castling].filter((c) => 'KQkq'.includes(c)))
    this.key = polyglotKey(fen)
    this.epFile = applicableEpFile(parsed)
  }

  /** Unsigned 64-bit key of the current position. */
  current(): bigint {
    return this.key
  }

  private xorPiece(piece: string, idx: number): void {
    const kind = PIECE_KIND[piece]
    if (kind === undefined) return
    this.key ^= POLYGLOT_RANDOM[64 * kind + 8 * (idx >> 3) + (idx & 7)]
  }

  private removeRight(right: string): void {
    if (this.castling.has(right)) {
      this.castling.delete(right)
      this.key ^= POLYGLOT_RANDOM[RANDOM_CASTLE + CASTLE_BIT[right]]
    }
  }

  /** Apply a chess.js verbose move, updating the key incrementally. */
  apply(m: HasherMove): void {
    const white = m.color === 'w'
    const fromIdx = sqToIdx(m.from)
    const toIdx = sqToIdx(m.to)
    const movingPiece = white ? m.piece.toUpperCase() : m.piece

    // Clear any en-passant term carried by the previous position.
    if (this.epFile !== null) {
      this.key ^= POLYGLOT_RANDOM[RANDOM_EN_PASSANT + this.epFile]
      this.epFile = null
    }

    // Lift the moving piece off its origin.
    this.xorPiece(movingPiece, fromIdx)
    this.board[fromIdx] = null

    // Remove a captured piece.
    if (m.flags.includes('e')) {
      const capIdx = toIdx + (white ? -8 : 8)
      this.xorPiece(white ? 'p' : 'P', capIdx)
      this.board[capIdx] = null
    } else if (m.captured) {
      this.xorPiece(white ? m.captured : m.captured.toUpperCase(), toIdx)
    }

    // Place the moving (or promoted) piece on the destination.
    const placed = m.promotion ? (white ? m.promotion.toUpperCase() : m.promotion) : movingPiece
    this.xorPiece(placed, toIdx)
    this.board[toIdx] = placed

    // Move the rook when castling.
    if (m.flags.includes('k') || m.flags.includes('q')) {
      const kingside = m.flags.includes('k')
      const rook = white ? 'R' : 'r'
      const rFrom = sqToIdx((kingside ? 'h' : 'a') + (white ? '1' : '8'))
      const rTo = sqToIdx((kingside ? 'f' : 'd') + (white ? '1' : '8'))
      this.xorPiece(rook, rFrom)
      this.board[rFrom] = null
      this.xorPiece(rook, rTo)
      this.board[rTo] = rook
    }

    // Update castling rights.
    if (m.piece === 'k') {
      if (white) {
        this.removeRight('K')
        this.removeRight('Q')
      } else {
        this.removeRight('k')
        this.removeRight('q')
      }
    }
    if (m.piece === 'r' && CORNER_RIGHT[fromIdx]) this.removeRight(CORNER_RIGHT[fromIdx])
    if (m.captured === 'r' && CORNER_RIGHT[toIdx]) this.removeRight(CORNER_RIGHT[toIdx])

    // Flip side to move.
    this.key ^= POLYGLOT_RANDOM[RANDOM_TURN]

    // A double pawn push creates an en-passant term only if a capturer exists.
    if (m.flags.includes('b')) {
      const file = toIdx & 7
      const row = toIdx >> 3
      const oppPawn = white ? 'p' : 'P'
      const left = file > 0 && this.board[row * 8 + file - 1] === oppPawn
      const right = file < 7 && this.board[row * 8 + file + 1] === oppPawn
      if (left || right) {
        this.epFile = file
        this.key ^= POLYGLOT_RANDOM[RANDOM_EN_PASSANT + file]
      }
    }
  }
}

/** Which en-passant file (if any) contributes to a position's key. */
function applicableEpFile(parsed: ParsedFen): number | null {
  const { board, turn, ep } = parsed
  if (ep.length !== 2) return null
  const file = ep.charCodeAt(0) - 97
  if (file < 0 || file > 7) return null
  const capRow = turn === 'w' ? 4 : 3
  const capPawn = turn === 'w' ? 'P' : 'p'
  const left = file > 0 && board[capRow * 8 + file - 1] === capPawn
  const right = file < 7 && board[capRow * 8 + file + 1] === capPawn
  return left || right ? file : null
}

/** Convenience: the signed key for a FEN, ready to bind to a SQLite INTEGER. */
export function positionId(fen: string): bigint {
  return toSignedKey(polyglotKey(fen))
}
