import { readFile, writeFile } from 'fs/promises'

export interface PgnGameHeader {
  Event?: string
  Site?: string
  Date?: string
  Round?: string
  White?: string
  Black?: string
  Result?: string
  ECO?: string
  WhiteElo?: string
  BlackElo?: string
  [key: string]: string | undefined
}

export interface PgnGame {
  headers: PgnGameHeader
  moves: string
  raw: string
}

export async function parsePgnFile(filePath: string): Promise<PgnGame[]> {
  const content = await readFile(filePath, 'utf-8')
  return parsePgnString(content)
}

export function parsePgnString(content: string): PgnGame[] {
  const games: PgnGame[] = []
  const lines = content.split('\n')

  let currentHeaders: PgnGameHeader = {}
  let currentMoves = ''
  let inHeaders = false
  let gameStarted = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('[')) {
      if (gameStarted && currentMoves.trim()) {
        // Save previous game
        games.push({
          headers: currentHeaders,
          moves: currentMoves.trim(),
          raw: formatPgn(currentHeaders, currentMoves.trim())
        })
        currentHeaders = {}
        currentMoves = ''
      }
      inHeaders = true
      gameStarted = true

      // Parse header: [Key "Value"]
      const match = trimmed.match(/^\[(\w+)\s+"(.*)"\]$/)
      if (match) {
        currentHeaders[match[1]] = match[2]
      }
    } else if (trimmed.length > 0) {
      inHeaders = false
      currentMoves += ' ' + trimmed
    }
  }

  // Save last game
  if (gameStarted && (currentMoves.trim() || Object.keys(currentHeaders).length > 0)) {
    games.push({
      headers: currentHeaders,
      moves: currentMoves.trim(),
      raw: formatPgn(currentHeaders, currentMoves.trim())
    })
  }

  return games
}

function formatPgn(headers: PgnGameHeader, moves: string): string {
  let pgn = ''
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      pgn += `[${key} "${value}"]\n`
    }
  }
  pgn += '\n' + moves
  return pgn
}

export async function writePgnFile(
  filePath: string,
  games: PgnGame[]
): Promise<void> {
  const content = games.map((g) => g.raw).join('\n\n')
  await writeFile(filePath, content, 'utf-8')
}

export function createPgn(headers: PgnGameHeader, movetext: string): string {
  return formatPgn(headers, movetext)
}
