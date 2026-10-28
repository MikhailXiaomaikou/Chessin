import { type ByteSource, u16be, u24be, u32be, i32le, fixedString } from './bytes'

/**
 * Fixed-size records: the .cbh game headers and the entity files (.cbp
 * players, .cbt tournaments, .cbc annotators, .cbs sources). Layouts follow the
 * Morphy specification (format/v1/1-game-headers.md and 4-entities.md).
 */

export const CBH_RECORD_SIZE = 46

export interface CbhRecord {
  id: number
  deleted: boolean
  guidingText: boolean
  /** Offset of the moves in .cbg. */
  movesOffset: number
  /** Offset of the annotations in .cba, 0 when the game has none. */
  annotationsOffset: number
  white: number
  black: number
  tournament: number
  annotator: number
  source: number
  date: number
  result: number
  round: number
  subround: number
  whiteElo: number
  blackElo: number
  eco: number
  flags: number
}

/** Number of game records in a .cbh file. */
export function cbhRecordCount(cbh: ByteSource): number {
  return Math.max(0, Math.floor((cbh.size - CBH_RECORD_SIZE) / CBH_RECORD_SIZE))
}

/** The record of game `id` (1-based), or null past the last game. */
export function readCbhRecord(cbh: ByteSource, id: number): CbhRecord | null {
  const b = cbh.read(CBH_RECORD_SIZE * id, CBH_RECORD_SIZE)
  if (b.length < CBH_RECORD_SIZE || (b[0] & 1) === 0) return null
  return {
    id,
    deleted: (b[0] & 0x80) !== 0,
    guidingText: (b[0] & 0x02) !== 0,
    movesOffset: u32be(b, 0x01),
    annotationsOffset: u32be(b, 0x05),
    white: u24be(b, 0x09),
    black: u24be(b, 0x0c),
    tournament: u24be(b, 0x0f),
    annotator: u24be(b, 0x12),
    source: u24be(b, 0x15),
    date: u24be(b, 0x18),
    result: b[0x1b],
    round: b[0x1d],
    subround: b[0x1e],
    whiteElo: u16be(b, 0x1f),
    blackElo: u16be(b, 0x21),
    eco: u16be(b, 0x23),
    flags: u32be(b, 0x27)
  }
}

/** A packed date (bits 0-4 day, 5-8 month, 9-20 year) as a PGN date. */
export function formatCbDate(value: number): string {
  const day = value & 31
  const month = (value >> 5) & 15
  const year = (value >> 9) & 0xfff
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${year ? String(year).padStart(4, '0') : '????'}.${month ? pad(month) : '??'}.${day ? pad(day) : '??'}`
}

/** An ECO field as a code such as "B90", or undefined for none / Chess960. */
export function formatCbEco(value: number): string | undefined {
  if (value === 0 || value >= 64576) return undefined
  const index = Math.floor(value / 128) - 1
  if (index < 0 || index > 499) return undefined
  return 'ABCDE'[Math.floor(index / 100)] + String(index % 100).padStart(2, '0')
}

const RESULTS = ['0-1', '1/2-1/2', '1-0', '*', '0-1', '1/2-1/2', '1-0', '*']

/** Result byte to PGN; forfeits keep their score, "both lost" and lines are "*". */
export function formatCbResult(value: number): string {
  return RESULTS[value] ?? '*'
}

/**
 * One entity file. Records are 9 bytes of tree node followed by the entity's
 * data; the id of an entity is the position of its record.
 */
export class EntityFile {
  private readonly headerSize: number
  private readonly recordSize: number
  private readonly count: number
  private readonly cache = new Map<number, string>()

  constructor(
    private readonly source: ByteSource | undefined,
    private readonly decode: (data: Uint8Array) => string
  ) {
    const h = source ? source.read(0, 32) : new Uint8Array(0)
    if (h.length < 28) {
      this.headerSize = 0
      this.recordSize = 1
      this.count = 0
      return
    }
    this.count = i32le(h, 0x00)
    this.recordSize = 9 + i32le(h, 0x0c)
    this.headerSize = 28 + (i32le(h, 0x18) === 4 ? 4 : 0)
  }

  /** The entity's display text; empty for a missing, deleted or blank entity. */
  text(id: number): string {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    let text = ''
    if (this.source && id >= 0 && id < this.count) {
      const rec = this.source.read(this.headerSize + id * this.recordSize, this.recordSize)
      // A deleted record has −999 as its left child.
      if (rec.length === this.recordSize && i32le(rec, 0) !== -999) text = this.decode(rec.subarray(9))
    }
    this.cache.set(id, text)
    return text
  }
}

export function playerName(data: Uint8Array): string {
  const last = fixedString(data, 0x00, 30)
  const first = fixedString(data, 0x1e, 20)
  return first ? `${last}, ${first}` : last
}

/** Tournament title and place, packed as "title\tplace". */
export function tournamentText(data: Uint8Array): string {
  return `${fixedString(data, 0x00, 40)}\t${fixedString(data, 0x28, 30)}`
}

export function annotatorName(data: Uint8Array): string {
  return fixedString(data, 0x00, 45)
}

export function sourceTitle(data: Uint8Array): string {
  return fixedString(data, 0x00, 25)
}
