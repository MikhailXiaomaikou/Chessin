/**
 * Coloured squares and arrows embedded in PGN comments, as written by
 * ChessBase and lichess: `[%csl Ga4,Rb5]` (squares) and `[%cal Ge2e4]` (arrows).
 * Colours are G(reen), R(ed), Y(ellow) and B(lue).
 */

export type ShapeColor = 'G' | 'R' | 'Y' | 'B'

export interface CommentShape {
  orig: string
  /** Set for an arrow; a highlighted square has none. */
  dest?: string
  color: ShapeColor
}

const COMMAND_RE = /\[%(\w+)\s+([^\]]*)\]/g
const SQUARE_RE = /^([GRYB])([a-h][1-8])$/
const ARROW_RE = /^([GRYB])([a-h][1-8])([a-h][1-8])$/

/** The shapes a comment draws, squares first. */
export function parseCommentShapes(comment: string | undefined): CommentShape[] {
  if (!comment) return []
  const squares: CommentShape[] = []
  const arrows: CommentShape[] = []
  for (const [, name, args] of comment.matchAll(COMMAND_RE)) {
    if (name !== 'csl' && name !== 'cal') continue
    for (const item of args.split(',')) {
      const token = item.trim()
      if (name === 'csl') {
        const m = token.match(SQUARE_RE)
        if (m) squares.push({ color: m[1] as ShapeColor, orig: m[2] })
      } else {
        const m = token.match(ARROW_RE)
        if (m) arrows.push({ color: m[1] as ShapeColor, orig: m[2], dest: m[3] })
      }
    }
  }
  return [...squares, ...arrows]
}

/** A comment's text without any `[%...]` commands (clock times, evals, shapes). */
export function commentText(comment: string | undefined): string {
  if (!comment) return ''
  return comment.replace(COMMAND_RE, ' ').replace(/\s+/g, ' ').trim()
}

/** Replaces a comment's text, keeping its `[%...]` commands. Returns '' when nothing is left. */
export function withCommentText(comment: string | undefined, text: string): string {
  const commands = (comment ?? '').match(COMMAND_RE) ?? []
  return [...commands, text.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ')
}

/**
 * Replaces the shapes in a comment, keeping its text and other commands.
 * Returns '' when nothing is left.
 */
export function withCommentShapes(comment: string | undefined, shapes: CommentShape[]): string {
  const rest = (comment ?? '')
    .replace(COMMAND_RE, (cmd, name: string) => (name === 'csl' || name === 'cal' ? ' ' : cmd))
    .replace(/\s+/g, ' ')
    .trim()
  const squares = shapes.filter((s) => !s.dest).map((s) => `${s.color}${s.orig}`)
  const arrows = shapes.filter((s) => s.dest).map((s) => `${s.color}${s.orig}${s.dest}`)
  const commands = [
    squares.length ? `[%csl ${squares.join(',')}]` : '',
    arrows.length ? `[%cal ${arrows.join(',')}]` : ''
  ].filter(Boolean)
  return [...commands, rest].filter(Boolean).join(' ')
}
