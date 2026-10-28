import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { iteratePgnLines, type ParsedPgnGame } from '../../shared/database/PgnParser'

/** Iterate games from a PGN file without loading it all into memory. */
export function iteratePgnFile(filePath: string): AsyncGenerator<ParsedPgnGame> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  return iteratePgnLines(lines)
}
