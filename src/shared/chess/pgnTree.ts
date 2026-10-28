/**
 * PGN to a move tree that keeps what a reader shows: variations, comments
 * before and after moves, NAGs (including glyphs such as "!?") and null moves.
 * Moves are structured, not validated — that needs a board.
 */

export interface PgnTreeNode {
  san: string
  /** Comment shown after the move. */
  comment?: string
  /** Comment shown before the move (e.g. at the start of a variation). */
  commentBefore?: string
  nags: number[]
  /** Continuations; the first is the main line. */
  children: PgnTreeNode[]
}

export interface PgnTree {
  headers: Record<string, string>
  /** Comment before the first move. */
  comment?: string
  roots: PgnTreeNode[]
}

const GLYPH_NAGS: Record<string, number> = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 }
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*'])
const HEADER_RE = /^\s*\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/

function join(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b
}

export function parsePgnTree(pgn: string): PgnTree {
  let text = pgn.replace(/^\uFEFF/, '')
  const headers: Record<string, string> = {}
  for (let m = text.match(HEADER_RE); m; m = text.match(HEADER_RE)) {
    headers[m[1]] = m[2].replace(/\\(["\\])/g, '$1')
    text = text.slice(m[0].length)
  }

  const tree: PgnTree = { headers, roots: [] }
  const parents = new Map<PgnTreeNode, PgnTreeNode | null>()
  const stack: (PgnTreeNode | null)[] = []
  // The last move on the current line; null before the first move of the game.
  let current: PgnTreeNode | null = null
  // True between "(" and the first move of that variation.
  let atVariationStart = false
  let pendingBefore: string | undefined

  const addComment = (raw: string): void => {
    const c = raw.replace(/\s+/g, ' ').trim()
    if (!c) return
    if (atVariationStart) pendingBefore = join(pendingBefore, c)
    else if (current) current.comment = join(current.comment, c)
    else tree.comment = join(tree.comment, c)
  }

  const addMove = (san: string, glyph?: number): void => {
    const node: PgnTreeNode = { san, nags: glyph ? [glyph] : [], children: [] }
    if (pendingBefore) node.commentBefore = pendingBefore
    pendingBefore = undefined
    if (current) current.children.push(node)
    else tree.roots.push(node)
    parents.set(node, current)
    current = node
    atVariationStart = false
  }

  const addToken = (token: string): boolean => {
    if (token.startsWith('$')) {
      const nag = parseInt(token.slice(1))
      if (current && !atVariationStart && nag > 0) current.nags.push(nag)
      return true
    }
    if (RESULTS.has(token)) return stack.length > 0 // a result ends the game
    let san = token.replace(/^\d+\.+/, '') // a move number, possibly glued on
    if (!san || /^\.+$/.test(san)) return true
    if (GLYPH_NAGS[san] !== undefined) {
      if (current && !atVariationStart) current.nags.push(GLYPH_NAGS[san])
      return true
    }
    let glyph: number | undefined
    const m = san.match(/^(.*?)([!?]{1,2})$/)
    if (m && m[1] && GLYPH_NAGS[m[2]] !== undefined) {
      san = m[1]
      glyph = GLYPH_NAGS[m[2]]
    }
    if (san === '--' || san === 'Z0' || san === '0000') san = '--'
    else if (san.startsWith('0-0-0')) san = 'O-O-O' + san.slice(5)
    else if (san.startsWith('0-0')) san = 'O-O' + san.slice(3)
    addMove(san, glyph)
    return true
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const end = text.indexOf('}', i + 1)
      addComment(text.slice(i + 1, end < 0 ? text.length : end))
      i = end < 0 ? text.length : end + 1
    } else if (ch === ';') {
      const end = text.indexOf('\n', i)
      addComment(text.slice(i + 1, end < 0 ? text.length : end))
      i = end < 0 ? text.length : end + 1
    } else if (ch === '(') {
      stack.push(current)
      // An alternative to the last move: it starts from the position before it.
      current = current ? (parents.get(current) ?? null) : null
      atVariationStart = true
      i++
    } else if (ch === ')') {
      if (stack.length) current = stack.pop() ?? null
      atVariationStart = false
      pendingBefore = undefined
      i++
    } else if (/\s/.test(ch)) {
      i++
    } else {
      let j = i
      while (j < text.length && !/[\s{}();]/.test(text[j])) j++
      const keepGoing = addToken(text.slice(i, j))
      i = j
      if (!keepGoing) break
    }
  }
  return tree
}
