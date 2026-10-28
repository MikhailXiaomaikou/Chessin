import { Chess, type Move } from 'chess.js'
import { TRANSLATION_TABLES } from './tables'

/**
 * Test kit: writes a complete synthetic ChessBase database (.cbh .cbg .cba .cbp
 * .cbt .cbc .cbs) from games given as PGN-style movetext. It follows the Morphy
 * specification on its own — constants and piece bookkeeping are written out
 * again here rather than shared with the decoder, so a round trip exercises two
 * independent readings of the format. Not used by the app.
 */

export interface TestAnnotation {
  pos: number
  type: number
  data: number[]
}

export interface TestGame {
  white?: string
  black?: string
  event?: string
  site?: string
  /** Packed parts; 0 = unknown. */
  year?: number
  month?: number
  day?: number
  round?: number
  subround?: number
  result?: '1-0' | '0-1' | '1/2-1/2' | '*'
  whiteElo?: number
  blackElo?: number
  eco?: string
  annotator?: string
  source?: string
  startFen?: string
  /** Encoding mode: 0 (compact, pre), 4 (compact, post) or 5 (simple, post). */
  mode?: number
  /** Moves with variations, e.g. "1. e4 c5 (1... c6) 2. Nf3"; "--" is a null move. */
  movetext?: string
  annotations?: TestAnnotation[]
  /** Write these move numbers (decode order) as two-byte moves. */
  twoByte?: number[]
  deleted?: boolean
  guidingText?: boolean
  /** Raw .cbg record to store instead of encoding (for corrupt-data tests). */
  rawMoves?: number[]
}

// ---- spec constants, transcribed from format/v1/2-moves.md -----------------

const KING = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]]
const KNIGHT = [[2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]]
const RAYS: Record<string, number[][]> = {
  q: [[0, 1], [1, 0], [1, 1], [1, -1]],
  r: [[0, 1], [1, 0]],
  b: [[1, 1], [1, -1]]
}
const FIRST_CODE: Record<string, number[]> = {
  q: [11, 143, 171],
  r: [39, 53, 199],
  b: [67, 81, 213],
  n: [95, 103, 227]
}
const PROMO_BITS: Record<string, number> = { q: 0, r: 1, b: 2, n: 3 }
const PIECE_BITS: Record<string, number> = { k: 1, q: 2, n: 3, b: 4, r: 5, p: 6 }

const sq = (name: string): number => (name.charCodeAt(0) - 97) * 8 + (name.charCodeAt(1) - 49)
const fileOf = (s: number): number => s >> 3
const rankOf = (s: number): number => s & 7
const wrap = (s: number, dx: number, dy: number): number =>
  (((fileOf(s) + dx) % 8 + 8) % 8) * 8 + (((rankOf(s) + dy) % 8 + 8) % 8)

type Lists = Record<'w' | 'b', Record<string, number[]>>

function listsFor(chess: Chess): Lists {
  const lists: Lists = {
    w: { k: [], q: [], r: [], b: [], n: [], p: [] },
    b: { k: [], q: [], r: [], b: [], n: [], p: [] }
  }
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const name = 'abcdefgh'[file] + (rank + 1)
      const piece = chess.get(name as Parameters<Chess['get']>[0])
      if (piece) lists[piece.color][piece.type].push(file * 8 + rank)
    }
  }
  return lists
}

function copyLists(l: Lists): Lists {
  const side = (s: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v]]))
  return { w: side(l.w), b: side(l.b) }
}

/** Move bookkeeping after `mv`, mirroring what ChessBase's numbering does. */
function track(lists: Lists, mv: Move): void {
  const mine = lists[mv.color]
  const theirs = lists[mv.color === 'w' ? 'b' : 'w']
  const from = sq(mv.from)
  const to = sq(mv.to)
  if (mv.captured) {
    const at = mv.flags.includes('e') ? fileOf(to) * 8 + rankOf(from) : to
    const list = theirs[mv.captured]
    const i = list.indexOf(at)
    if (mv.captured === 'p') list[i] = -1
    else list.splice(i, 1)
  }
  const list = mine[mv.piece]
  const i = list.indexOf(from)
  if (mv.promotion) {
    list[i] = -1
    mine[mv.promotion].push(to)
  } else {
    list[i] = to
  }
  if (mv.flags.includes('k') || mv.flags.includes('q')) {
    const rank = rankOf(from)
    const rookFrom = (mv.flags.includes('k') ? 7 : 0) * 8 + rank
    const rookTo = (mv.flags.includes('k') ? 5 : 3) * 8 + rank
    mine.r[mine.r.indexOf(rookFrom)] = rookTo
  }
}

function twoByteValue(from: number, to: number, promotion?: string): number {
  return from | (to << 6) | ((promotion ? PROMO_BITS[promotion] : 0) << 12)
}

/** Compact codes for a move: one byte, or 235 and two more. */
function compactCodes(lists: Lists, mv: Move, forceTwoByte: boolean): number[] {
  const from = sq(mv.from)
  const to = sq(mv.to)
  const two = (): number[] => {
    const v = twoByteValue(from, to, mv.promotion)
    return [235, v >> 8, v & 0xff]
  }
  if (forceTwoByte || mv.promotion) return two()
  if (mv.flags.includes('k')) return [9]
  if (mv.flags.includes('q')) return [10]
  const side = lists[mv.color]
  if (mv.piece === 'k') {
    for (let d = 0; d < 8; d++) if (wrap(from, KING[d][0], KING[d][1]) === to) return [1 + d]
    throw new Error('king move not found')
  }
  if (mv.piece === 'p') {
    const i = side.p.indexOf(from)
    const f = mv.color === 'w' ? 1 : -1
    const dx = fileOf(to) - fileOf(from)
    const dy = rankOf(to) - rankOf(from)
    const kind = dx === 0 ? (Math.abs(dy) === 2 ? 1 : 0) : dx === f ? 2 : 3
    return [111 + 4 * i + kind]
  }
  const index = side[mv.piece].indexOf(from)
  if (index > 2) return two()
  const base = FIRST_CODE[mv.piece][index]
  if (mv.piece === 'n') {
    for (let k = 0; k < 8; k++) if (wrap(from, KNIGHT[k][0], KNIGHT[k][1]) === to) return [base + k]
    throw new Error('knight move not found')
  }
  const rays = RAYS[mv.piece]
  for (let k = 0; k < rays.length * 7; k++) {
    const [dx, dy] = rays[Math.floor(k / 7)]
    const s = (k % 7) + 1
    if (wrap(from, dx * s, dy * s) === to) return [base + k]
  }
  throw new Error(`no code for ${mv.san}`)
}

interface Node {
  san: string
  parent: Node | null
  children: Node[]
}

/** A move tree from movetext with nested variations. */
function parseTree(movetext: string): Node[] {
  const root: Node = { san: '', parent: null, children: [] }
  let current = root
  const stack: Node[] = []
  const tokens = movetext.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    if (t === '(') {
      stack.push(current)
      current = current.parent ?? root // an alternative to the last move
    } else if (t === ')') {
      current = stack.pop() ?? root
    } else if (/^\d+\.+$/.test(t)) {
      continue
    } else {
      const node: Node = { san: t, parent: current === root ? null : current, children: [] }
      current.children.push(node)
      current = node
    }
  }
  return root.children
}

function startPositionBytes(fen: string): number[] {
  const [placement, turn, castling, ep, , fullmove] = fen.split(' ')
  const board: (string | null)[] = new Array(64).fill(null)
  placement.split('/').forEach((row, r) => {
    let file = 0
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch)
      else board[file++ * 8 + (7 - r)] = ch
    }
  })
  const bits: number[] = []
  for (let s = 0; s < 64; s++) {
    const p = board[s]
    if (!p) {
      bits.push(0)
      continue
    }
    const code = PIECE_BITS[p.toLowerCase()]
    bits.push(1, p === p.toLowerCase() ? 1 : 0, (code >> 2) & 1, (code >> 1) & 1, code & 1)
  }
  const out = [1, (ep !== '-' ? ep.charCodeAt(0) - 96 : 0) | (turn === 'b' ? 0x10 : 0), 0, Number(fullmove) || 1]
  out[2] =
    (castling.includes('Q') ? 1 : 0) |
    (castling.includes('K') ? 2 : 0) |
    (castling.includes('q') ? 4 : 0) |
    (castling.includes('k') ? 8 : 0)
  const boardBytes = new Array(24).fill(0)
  bits.forEach((b, i) => {
    if (b) boardBytes[i >> 3] |= 0x80 >> (i & 7)
  })
  return [...out, ...boardBytes]
}

/** The untranslated compact code stream for a game (for tests against the spec). */
export function compactCodeStream(movetext: string, startFen?: string): number[] {
  return encodeMoveStream(movetext, startFen, 0, [], true)
}

function encodeMoveStream(
  movetext: string,
  startFen: string | undefined,
  mode: number,
  twoByte: number[],
  raw = false
): number[] {
  const table = TRANSLATION_TABLES[mode]
  const inverse = new Array<number>(256)
  table.forEach((v, i) => (inverse[v] = i))
  const pre = mode < 4
  const tr = (value: number, n: number): number =>
    raw ? value : pre ? (inverse[value] + n) & 0xff : inverse[(value + n) & 0xff]
  const compact = mode !== 5

  let chess = startFen ? new Chess(startFen) : new Chess()
  let lists = listsFor(chess)
  const saved: { fen: string; lists: Lists }[] = []
  const out: number[] = []
  const simple: { v: number; n: number }[] = []
  let startNext = false
  let n = 0

  const playNull = (): void => {
    const f = chess.fen().split(' ')
    if (f[1] === 'b') f[5] = String(Number(f[5]) + 1)
    f[1] = f[1] === 'w' ? 'b' : 'w'
    f[3] = '-'
    chess = new Chess(f.join(' '))
  }

  const emit = (node: Node): void => {
    let codes: number[]
    let v = 0
    if (node.san === '--') {
      playNull()
      codes = [0]
    } else {
      const mv = chess.move(node.san)
      codes = compactCodes(lists, mv, twoByte.includes(n))
      v = twoByteValue(sq(mv.from), sq(mv.to), mv.promotion)
      track(lists, mv)
    }
    if (compact) out.push(...codes.map((c) => tr(c, n)))
    else simple.push({ v: v | (startNext ? 0x8000 : 0), n })
    startNext = false
    n++
  }
  const push = (): void => {
    saved.push({ fen: chess.fen(), lists: copyLists(lists) })
    if (compact) out.push(tr(254, n))
    else startNext = true
  }
  const pop = (): void => {
    if (compact) out.push(tr(255, n))
    else simple[simple.length - 1].v |= 0x4000
    const s = saved.pop()
    if (s) {
      chess = new Chess(s.fen)
      lists = s.lists
    }
  }
  const encodeFrom = (alternatives: Node[]): void => {
    alternatives.forEach((node, i) => {
      if (i < alternatives.length - 1) push()
      emit(node)
      if (node.children.length) encodeFrom(node.children)
      else pop()
    })
  }

  const roots = parseTree(movetext)
  if (roots.length) encodeFrom(roots)
  else if (compact) out.push(tr(255, 0))
  if (compact) return out
  return simple.flatMap(({ v, n: k }) => [tr(v >> 8, k), tr(v & 0xff, k)])
}

// ---- file writers ------------------------------------------------------------

class Bytes {
  readonly a: number[] = []
  u8(v: number): this {
    this.a.push(v & 0xff)
    return this
  }
  u16be(v: number): this {
    return this.u8(v >> 8).u8(v)
  }
  u24be(v: number): this {
    return this.u8(v >> 16).u8(v >> 8).u8(v)
  }
  u32be(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v)
  }
  i32le(v: number): this {
    return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >> 24)
  }
  /** A fixed-size ISO 8859-1 field, zero-padded; unmappable characters become "?". */
  str(s: string, len: number): this {
    const b = Array.from(s, (ch) => (ch.charCodeAt(0) <= 0xff ? ch.charCodeAt(0) : 0x3f)).slice(0, len - 1)
    for (let i = 0; i < len; i++) this.u8(b[i] ?? 0)
    return this
  }
  raw(b: number[]): this {
    this.a.push(...b)
    return this
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.a)
  }
}

class Entities {
  private readonly ids = new Map<string, number>()
  readonly records: number[][] = []
  constructor(private readonly encode: (key: string) => number[]) {}
  id(key: string): number {
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.records.length
      this.ids.set(key, id)
      this.records.push(this.encode(key))
    }
    return id
  }
  file(dataSize: number): Uint8Array {
    const b = new Bytes()
      .i32le(this.records.length)
      .i32le(0)
      .i32le(1234567890)
      .i32le(dataSize)
      .i32le(-1)
      .i32le(this.records.length)
      .i32le(0)
    for (const r of this.records) b.i32le(-1).i32le(-1).u8(0).raw(r)
    return b.bytes()
  }
}

const RESULT_BYTE: Record<string, number> = { '0-1': 0, '1/2-1/2': 1, '1-0': 2, '*': 3 }

export interface TestDatabase {
  cbh: Uint8Array
  cbg: Uint8Array
  cba: Uint8Array
  cbp: Uint8Array
  cbt: Uint8Array
  cbc: Uint8Array
  cbs: Uint8Array
}

export function encodeDatabase(games: TestGame[]): TestDatabase {
  const players = new Entities((name) => {
    const [last, first = ''] = name.split(', ')
    return new Bytes().str(last, 30).str(first, 20).i32le(1).i32le(0).a
  })
  const tournaments = new Entities((key) => {
    const [title, place] = key.split('\t')
    // title, place, start date, 8 bytes of type/nation/category/flags/rounds, refs, first game
    return new Bytes().str(title, 40).str(place, 30).i32le(0).raw(new Array(8).fill(0)).i32le(1).i32le(0).a
  })
  const annotators = new Entities((name) => new Bytes().str(name, 45).i32le(1).i32le(0).a)
  const sources = new Entities((title) =>
    new Bytes().str(title, 25).str('', 16).i32le(0).i32le(0).u8(0).u8(0).i32le(1).i32le(0).a
  )

  const cbg = new Bytes().u16be(26).raw(new Array(24).fill(0))
  const cba = new Bytes().u16be(26).raw(new Array(24).fill(0))
  const cbh = new Bytes()
    .u8(0)
    .u16be(44)
    .u16be(46)
    .u8(1)
    .u32be(games.length + 1)
    .raw(new Array(36).fill(0))

  games.forEach((g, i) => {
    const id = i + 1
    const mode = g.mode ?? 0
    const movesOffset = cbg.a.length
    if (g.rawMoves) {
      cbg.raw(g.rawMoves)
    } else {
      const stream = encodeMoveStream(g.movetext ?? '', g.startFen, mode, g.twoByte ?? [])
      const start = g.startFen ? startPositionBytes(g.startFen) : []
      cbg.u8(mode | (g.startFen ? 0x40 : 0)).u24be(4 + start.length + stream.length).raw(start).raw(stream)
    }

    let annotationsOffset = 0
    if (g.annotations?.length) {
      annotationsOffset = cba.a.length
      const body = new Bytes()
      for (const a of g.annotations) body.u24be(a.pos & 0xffffff).u8(a.type).u16be(6 + a.data.length).raw(a.data)
      cba.u24be(id).raw([1, 0, 0x0e, 0x0e]).u24be(g.annotations.length + 1).u32be(14 + body.a.length).raw(body.a)
    }

    let ecoValue = 0
    if (g.eco) ecoValue = ((g.eco.charCodeAt(0) - 65) * 100 + Number(g.eco.slice(1)) + 1) * 128
    cbh
      .u8(1 | (g.guidingText ? 2 : 0) | (g.deleted ? 0x80 : 0))
      .u32be(movesOffset)
      .u32be(annotationsOffset)
      .u24be(players.id(g.white ?? ''))
      .u24be(players.id(g.black ?? ''))
      .u24be(tournaments.id(`${g.event ?? ''}\t${g.site ?? ''}`))
      .u24be(annotators.id(g.annotator ?? ''))
      .u24be(sources.id(g.source ?? ''))
      .u24be(((g.year ?? 0) << 9) | ((g.month ?? 0) << 5) | (g.day ?? 0))
      .u8(RESULT_BYTE[g.result ?? '*'])
      .u8(0)
      .u8(g.round ?? 0)
      .u8(g.subround ?? 0)
      .u16be(g.whiteElo ?? 0)
      .u16be(g.blackElo ?? 0)
      .u16be(ecoValue)
      .u16be(0)
      .u32be(g.startFen ? 1 : 0)
      .u16be(0)
      .u8(0)
  })

  return {
    cbh: cbh.bytes(),
    cbg: cbg.bytes(),
    cba: cba.bytes(),
    cbp: players.file(58),
    cbt: tournaments.file(90),
    cbc: annotators.file(53),
    cbs: sources.file(59)
  }
}
