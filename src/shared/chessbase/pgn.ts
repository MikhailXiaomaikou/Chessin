import type { CbMoveNode, DecodedMoves } from './moves'
import type { MoveAnnotations } from './annotations'

/** Turn a decoded move tree and its annotations into PGN. */

function commentBody(a: MoveAnnotations | undefined, which: 'before' | 'after'): string {
  if (!a) return ''
  const parts = which === 'before' ? [...a.textBefore] : [...a.textAfter]
  if (which === 'after') {
    if (a.squares.length) parts.push(`[%csl ${a.squares.join(',')}]`)
    if (a.arrows.length) parts.push(`[%cal ${a.arrows.join(',')}]`)
  }
  // A brace would end the PGN comment early.
  return parts.join(' ').replace(/\{/g, '(').replace(/\}/g, ')').trim()
}

/** Movetext with variations, comments and symbols, ending in the result. */
export function buildMovetext(
  moves: DecodedMoves,
  annotations: Map<number, MoveAnnotations>,
  result: string
): string {
  const tokens: string[] = []
  // Adjacent comments are merged: PGN has no separate "before the move" slot,
  // and some readers (chess.js among them) reject two comments in a row.
  const pushComment = (body: string): void => {
    if (!body) return
    const last = tokens[tokens.length - 1]
    if (last?.startsWith('{')) tokens[tokens.length - 1] = `${last.slice(0, -1)} ${body}}`
    else tokens.push(`{${body}}`)
  }

  const game = annotations.get(-1)
  pushComment(commentBody(game, 'before'))
  pushComment(commentBody(game, 'after'))

  // Write one move; true if what follows needs a move number.
  const writeMove = (node: CbMoveNode, force: boolean): boolean => {
    const a = annotations.get(node.index)
    const before = commentBody(a, 'before')
    if (before) {
      pushComment(before)
      force = true
    }
    if (node.color === 'w') tokens.push(`${node.moveNumber}.`)
    else if (force) tokens.push(`${node.moveNumber}...`)
    tokens.push(node.san)
    if (a) for (const nag of a.nags) tokens.push(`$${nag}`)
    const after = commentBody(a, 'after')
    pushComment(after)
    return after !== ''
  }

  // Write the alternatives at a position: the main move, its variations, then
  // the main line onward.
  const writeLine = (alternatives: CbMoveNode[], forceFirst: boolean): void => {
    let alts = alternatives
    let force = forceFirst
    while (alts.length > 0) {
      const [main, ...variations] = alts
      let next = writeMove(main, force)
      for (const v of variations) {
        tokens.push('(')
        writeLine([v], true)
        tokens.push(')')
        next = true
      }
      force = next
      alts = main.children
    }
  }

  writeLine(moves.roots, true)
  tokens.push(result)
  return tokens.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')
}

/** Main-line moves in SAN, stopping at a null move (it can't be replayed). */
export function mainlineOf(moves: DecodedMoves): string[] {
  const out: string[] = []
  let node = moves.roots[0]
  while (node && node.san !== '--') {
    out.push(node.san)
    node = node.children[0]
  }
  return out
}

function escapeTag(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function formatPgn(headers: Record<string, string>, movetext: string): string {
  const tags = Object.entries(headers)
    .map(([k, v]) => `[${k} "${escapeTag(v)}"]`)
    .join('\n')
  return `${tags}\n\n${movetext}\n`
}
