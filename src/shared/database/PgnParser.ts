/**
 * PGN parsing.
 *
 * Splits a (possibly huge, multi-game) PGN into individual games and tokenizes
 * the movetext. We extract the *mainline* SAN moves (skipping variations,
 * comments and NAGs) so they can be replayed for position indexing, while
 * keeping the original movetext intact for faithful re-display.
 *
 * Games come from a string or from any stream of lines, so importing a
 * multi-gigabyte file (a Node read stream, a browser File) never loads it whole.
 */

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

/** A parsed game with its mainline moves split out for indexing. */
export interface ParsedPgnGame {
  headers: PgnGameHeader
  /** Mainline moves as cleaned SAN, ready to feed to a move generator. */
  moves: string[]
  /** Original movetext (with variations/comments/NAGs preserved). */
  movetext: string
  /** Full reconstructed PGN (headers + blank line + movetext). */
  pgn: string
}

/** Legacy shape kept for backward compatibility with existing callers. */
export interface PgnGame {
  headers: PgnGameHeader
  moves: string
  raw: string
}

const HEADER_RE = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '1/2', '*'])

function unescapeHeaderValue(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Normalize a movetext token into SAN a move generator will accept, or return
 * null if the token is not a move (move number, result, NAG-only, null move).
 */
export function cleanSan(tokenRaw: string): string | null {
  // Strip a leading move number such as "12." or "12..." (possibly glued to the move).
  let token = tokenRaw.replace(/^\d+\.+/, '')
  if (!token) return null
  if (RESULTS.has(token)) return null
  // Null / placeholder moves cannot be replayed.
  if (token === '--' || token === 'Z0' || token === '0000') return null
  // Normalize castling written with zeros.
  if (token.startsWith('0-0-0')) token = 'O-O-O' + token.slice(5)
  else if (token.startsWith('0-0')) token = 'O-O' + token.slice(3)
  // Drop trailing annotation glyphs and check/mate marks; the generator re-derives them.
  token = token.replace(/[+#!?]+$/, '')
  return token || null
}

/** Extract the mainline SAN moves from movetext, skipping variations and comments. */
export function extractMainline(movetext: string): string[] {
  const moves: string[] = []
  const n = movetext.length
  let i = 0
  let depth = 0

  while (i < n) {
    const ch = movetext[i]
    if (ch === '{') {
      const end = movetext.indexOf('}', i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (ch === ';') {
      const end = movetext.indexOf('\n', i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      if (depth > 0) depth--
      i++
      continue
    }
    if (ch === '$') {
      i++
      while (i < n && movetext[i] >= '0' && movetext[i] <= '9') i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    // Read a token up to the next whitespace or structural character.
    let j = i
    while (j < n && !' \t\n\r{}();$'.includes(movetext[j])) j++
    const token = movetext.slice(i, j)
    i = j
    if (depth === 0) {
      // A null move can't be replayed: the indexed main line ends there.
      if (token === '--' || token === 'Z0') break
      const san = cleanSan(token)
      if (san) moves.push(san)
    }
  }
  return moves
}

function formatPgn(headers: PgnGameHeader, movetext: string): string {
  let pgn = ''
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) pgn += `[${key} "${escapeHeaderValue(value)}"]\n`
  }
  pgn += '\n' + movetext + (movetext.endsWith('\n') ? '' : '\n')
  return pgn
}

function buildGame(headers: PgnGameHeader, movetext: string): ParsedPgnGame {
  return {
    headers,
    moves: extractMainline(movetext),
    movetext,
    pgn: formatPgn(headers, movetext)
  }
}

function updateCommentState(line: string, inComment: boolean): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inComment) {
      if (c === '}') inComment = false
    } else if (c === '{') {
      inComment = true
    } else if (c === ';') {
      break // line comment — does not span lines
    }
  }
  return inComment
}

/**
 * Incrementally assembles games from a line stream. A header line that appears
 * after movetext marks the start of the next game.
 */
class PgnAssembler {
  private headers: PgnGameHeader = {}
  private movetextLines: string[] = []
  private hasHeaders = false
  private hasMoves = false
  private inComment = false

  push(line: string): ParsedPgnGame | null {
    const trimmed = line.trim()

    if (!this.inComment) {
      const hm = trimmed.match(HEADER_RE)
      if (hm) {
        const completed = this.hasMoves ? this.finish() : null
        this.headers[hm[1]] = unescapeHeaderValue(hm[2])
        this.hasHeaders = true
        return completed
      }
    }

    if (trimmed.length > 0 || this.hasMoves) {
      this.movetextLines.push(line)
      if (trimmed.length > 0) this.hasMoves = true
    }
    this.inComment = updateCommentState(line, this.inComment)
    return null
  }

  finish(): ParsedPgnGame | null {
    let game: ParsedPgnGame | null = null
    if (this.hasHeaders || this.hasMoves) {
      const movetext = this.movetextLines.join('\n').trim()
      if (this.hasHeaders || movetext) game = buildGame(this.headers, movetext)
    }
    this.headers = {}
    this.movetextLines = []
    this.hasHeaders = false
    this.hasMoves = false
    this.inComment = false
    return game
  }
}

/** Iterate games from an in-memory PGN string. */
export function* iteratePgnGames(content: string): Generator<ParsedPgnGame> {
  const asm = new PgnAssembler()
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const line of lines) {
    const game = asm.push(line)
    if (game) yield game
  }
  const last = asm.finish()
  if (last) yield last
}

/** Iterate games from a stream of lines, e.g. a file read piece by piece. */
export async function* iteratePgnLines(
  lines: AsyncIterable<string> | Iterable<string>
): AsyncGenerator<ParsedPgnGame> {
  const asm = new PgnAssembler()
  let first = true
  for await (const raw of lines) {
    const line = first ? raw.replace(/^\uFEFF/, '') : raw
    first = false
    const game = asm.push(line)
    if (game) yield game
  }
  const last = asm.finish()
  if (last) yield last
}

/** Parse all games from a PGN string into the new structured form. */
export function parsePgnGames(content: string): ParsedPgnGame[] {
  return [...iteratePgnGames(content)]
}

// ---------------------------------------------------------------------------
// Backward-compatible helpers (legacy PgnGame shape).
// ---------------------------------------------------------------------------

export function parsePgnString(content: string): PgnGame[] {
  return parsePgnGames(content).map((g) => ({
    headers: g.headers,
    moves: g.movetext,
    raw: g.pgn
  }))
}

export function createPgn(headers: PgnGameHeader, movetext: string): string {
  return formatPgn(headers, movetext)
}
