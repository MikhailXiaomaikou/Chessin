import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import type { PgnGameHeader } from './PgnParser'

/**
 * ChessBase CBH format reader.
 *
 * CBH is a proprietary binary format. A ChessBase database consists of multiple files:
 * - .cbh: Header/index file (46 bytes per game entry)
 * - .cbg: Game data (moves encoded in binary)
 * - .cba: Annotations
 * - .cbp: Player index
 * - .cbt: Tournament index
 * - .cbc: Commentator index
 * - .cbs: Source index
 * - .cbj: Team index
 *
 * This is a partial implementation that reads game headers from the CBH index.
 * Full move decoding from .cbg is complex and not fully reverse-engineered.
 */

export interface CbhGameEntry {
  index: number
  headers: PgnGameHeader
  offset: number
  length: number
}

const CBH_HEADER_SIZE = 46
const CBH_FILE_HEADER = 46 // First 46 bytes are file header

export async function readCbhIndex(cbhPath: string): Promise<CbhGameEntry[]> {
  if (!existsSync(cbhPath)) {
    throw new Error(`CBH file not found: ${cbhPath}`)
  }

  const data = await readFile(cbhPath)
  const entries: CbhGameEntry[] = []

  // Skip file header
  let offset = CBH_FILE_HEADER

  let index = 0
  while (offset + CBH_HEADER_SIZE <= data.length) {
    try {
      const entry = parseGameEntry(data, offset, index)
      if (entry) {
        entries.push(entry)
      }
    } catch {
      // Skip malformed entries
    }
    offset += CBH_HEADER_SIZE
    index++
  }

  // Try to enrich with player names from .cbp
  const dir = dirname(cbhPath)
  const baseName = cbhPath.replace(/\.cbh$/i, '')
  const cbpPath = baseName + '.cbp'

  if (existsSync(cbpPath)) {
    try {
      await enrichWithPlayerNames(entries, cbpPath)
    } catch {
      // Player names not available
    }
  }

  return entries
}

function parseGameEntry(
  data: Buffer,
  offset: number,
  index: number
): CbhGameEntry | null {
  // CBH entry structure (simplified):
  // Bytes 0-3: Offset into .cbg file
  // Bytes 4-7: Length of game data in .cbg
  // Bytes 8-9: White player ID (index into .cbp)
  // Bytes 10-11: Black player ID
  // Bytes 12-13: Tournament ID (index into .cbt)
  // Bytes 14: Round
  // Byte 15: Result (0=unknown, 1=white wins, 2=black wins, 3=draw)
  // Bytes 16-18: Date (encoded)

  const gameOffset = data.readUInt32BE(offset)
  const gameLength = data.readUInt32BE(offset + 4)

  if (gameOffset === 0 && gameLength === 0) return null

  const resultByte = data[offset + 15] & 0x03
  const resultMap: Record<number, string> = {
    0: '*',
    1: '1-0',
    2: '0-1',
    3: '1/2-1/2'
  }

  // Decode date (3 bytes)
  const dateVal = (data[offset + 16] << 16) | (data[offset + 17] << 8) | data[offset + 18]
  const year = (dateVal >> 9) & 0x7FF
  const month = (dateVal >> 5) & 0x0F
  const day = dateVal & 0x1F

  const dateStr =
    year > 0
      ? `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`
      : '????.??.??'

  return {
    index,
    headers: {
      White: `Player ${data.readUInt16BE(offset + 8)}`,
      Black: `Player ${data.readUInt16BE(offset + 10)}`,
      Date: dateStr,
      Result: resultMap[resultByte] || '*',
      Round: String(data[offset + 14] || '?')
    },
    offset: gameOffset,
    length: gameLength
  }
}

async function enrichWithPlayerNames(
  entries: CbhGameEntry[],
  cbpPath: string
): Promise<void> {
  const data = await readFile(cbpPath)

  // CBP player index: variable-length entries
  // Each entry: 4-byte length prefix, then player name as null-terminated string
  const players = new Map<number, string>()
  let offset = 0
  let id = 0

  while (offset + 4 < data.length) {
    const len = data.readUInt32BE(offset)
    if (len === 0 || offset + 4 + len > data.length) break

    const nameBytes = data.subarray(offset + 4, offset + 4 + len)
    // Find null terminator
    const nullIdx = nameBytes.indexOf(0)
    const name = nameBytes
      .subarray(0, nullIdx >= 0 ? nullIdx : len)
      .toString('utf-8')
      .trim()

    if (name) {
      players.set(id, name)
    }

    offset += 4 + len
    id++
  }

  // Update entries with actual player names
  for (const entry of entries) {
    const whiteMatch = entry.headers.White?.match(/^Player (\d+)$/)
    const blackMatch = entry.headers.Black?.match(/^Player (\d+)$/)

    if (whiteMatch) {
      const name = players.get(parseInt(whiteMatch[1]))
      if (name) entry.headers.White = name
    }
    if (blackMatch) {
      const name = players.get(parseInt(blackMatch[1]))
      if (name) entry.headers.Black = name
    }
  }
}

export async function getCbhGameCount(cbhPath: string): Promise<number> {
  const data = await readFile(cbhPath)
  return Math.floor((data.length - CBH_FILE_HEADER) / CBH_HEADER_SIZE)
}
