import { Chess } from 'chess.js'
import { parsePgnTree, type PgnTreeNode } from '../chess/pgnTree'
import { isDue, learningCard, review, type CardState } from './srs'

/**
 * Opening repertoire training. A repertoire is a move tree (a PGN with
 * variations) and the side the trainee plays. Every position where the
 * trainee is to move and the tree has an answer is a card. A session walks
 * the tree line by line: the trainer plays the opponent's replies, steering
 * toward cards that are due, and asks for the trainee's moves.
 */

export type Side = 'w' | 'b'

export interface TrainNode {
  san: string
  from: string
  to: string
  promotion?: string
  /** Position after the move. */
  fen: string
  children: TrainNode[]
}

export interface Repertoire {
  startFen: string
  /** The side the trainee plays. */
  side: Side
  roots: TrainNode[]
}

export interface Card {
  key: string
  fen: string
  /** The repertoire's answers here, in SAN. */
  moves: string[]
}

/** New positions introduced per session; the rest wait for the next one. */
export const NEW_PER_SESSION = 10

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** Board, side to move, castling and en passant: what makes two positions the same. */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

export function sideToMove(fen: string): Side {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

// Adds a node to a list of alternatives, merging it into an equal move.
function addAlternative(list: TrainNode[], node: TrainNode): void {
  const same = list.find((n) => n.san === node.san)
  if (!same) list.push(node)
  else for (const child of node.children) addAlternative(same.children, child)
}

/** A repertoire from a PGN's move tree. An illegal or null move ends its line. */
export function buildRepertoire(pgn: string, side: Side): Repertoire {
  const tree = parsePgnTree(pgn)
  let startFen = DEFAULT_FEN
  try {
    startFen = new Chess(tree.headers.FEN?.trim() || DEFAULT_FEN).fen()
  } catch {
    // keep the standard start
  }
  const build = (line: PgnTreeNode[], fen: string): TrainNode[] => {
    const out: TrainNode[] = []
    for (const p of line) {
      try {
        const chess = new Chess(fen)
        const move = chess.move(p.san)
        const after = chess.fen()
        const node: TrainNode = { san: move.san, from: move.from, to: move.to, fen: after, children: [] }
        if (move.promotion) node.promotion = move.promotion
        node.children = build(p.children, after)
        addAlternative(out, node)
      } catch {
        // not a legal move here (or a null move): the line stops
      }
    }
    return out
  }
  return { startFen, side, roots: build(tree.roots, startFen) }
}

/** Visits every position of the tree with the moves that leave it. */
function walk(rep: Repertoire, visit: (fen: string, children: TrainNode[]) => void): void {
  const go = (fen: string, children: TrainNode[]) => {
    visit(fen, children)
    for (const c of children) go(c.fen, c.children)
  }
  go(rep.startFen, rep.roots)
}

/** The positions the trainee must answer, by position key. Transpositions share a card. */
export function repertoireCards(rep: Repertoire): Map<string, Card> {
  const cards = new Map<string, Card>()
  walk(rep, (fen, children) => {
    if (children.length === 0 || sideToMove(fen) !== rep.side) return
    const key = positionKey(fen)
    let card = cards.get(key)
    if (!card) cards.set(key, (card = { key, fen, moves: [] }))
    for (const c of children) if (!card.moves.includes(c.san)) card.moves.push(c.san)
  })
  return cards
}

export interface CardCounts {
  due: number
  new: number
  learned: number
  total: number
}

export function cardCounts(
  cards: Map<string, Card>,
  states: Record<string, CardState>,
  now: number
): CardCounts {
  const counts: CardCounts = { due: 0, new: 0, learned: 0, total: cards.size }
  for (const key of cards.keys()) {
    const state = states[key]
    if (!state) counts.new++
    else if (isDue(state, now)) counts.due++
    else counts.learned++
  }
  return counts
}

export type Step =
  /** The trainer plays a move: the opponent's reply, or one of the trainee's that is not due. */
  | { kind: 'move'; node: TrainNode; by: 'opponent' | 'trainee' }
  /** The trainee is to find the repertoire move. A new card is shown with its answer first. */
  | { kind: 'ask'; fen: string; moves: string[]; isNew: boolean }
  /** Nothing left to ask down this line; the next one starts from the beginning. */
  | { kind: 'lineEnd' }
  /** Nothing is due anywhere. */
  | { kind: 'done' }

export interface AnswerResult {
  correct: boolean
  /** The repertoire's moves here. */
  moves: string[]
  /** The move played on, when correct. */
  node?: TrainNode
}

export class TrainingSession {
  readonly cards: Map<string, Card>
  /** Card states, updated as the trainee answers; save these. */
  readonly states: Record<string, CardState>
  readonly stats = { answered: 0, mistakes: 0 }
  private readonly introduced = new Set<string>()
  /** Every list of trainee moves at a position, for answers found via a transposition. */
  private readonly answersAt = new Map<string, TrainNode[][]>()
  private path: TrainNode[] = []
  private asking: { key: string; failed: boolean; isNew: boolean } | null = null

  constructor(
    readonly rep: Repertoire,
    states: Record<string, CardState>,
    private readonly clock: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.cards = repertoireCards(rep)
    this.states = { ...states }
    walk(rep, (fen, children) => {
      if (children.length === 0 || sideToMove(fen) !== rep.side) return
      const key = positionKey(fen)
      const lists = this.answersAt.get(key) ?? []
      lists.push(children)
      this.answersAt.set(key, lists)
    })
  }

  /** The moves of the current line, from the start position. */
  get line(): readonly TrainNode[] {
    return this.path
  }

  get fen(): string {
    return this.path.length ? this.path[this.path.length - 1].fen : this.rep.startFen
  }

  private get children(): TrainNode[] {
    return this.path.length ? this.path[this.path.length - 1].children : this.rep.roots
  }

  private needsWork(key: string): boolean {
    const state = this.states[key]
    if (state) return isDue(state, this.clock())
    return this.introduced.has(key) || this.introduced.size < NEW_PER_SESSION
  }

  // Whether a position, or one after it, has a card to work on.
  private hasWork(fen: string, children: TrainNode[]): boolean {
    if (children.length > 0 && sideToMove(fen) === this.rep.side && this.needsWork(positionKey(fen))) {
      return true
    }
    return children.some((c) => this.hasWork(c.fen, c.children))
  }

  next(): Step {
    if (this.asking) return this.question()
    if (!this.hasWork(this.rep.startFen, this.rep.roots)) return { kind: 'done' }
    const fen = this.fen
    const children = this.children
    const ahead = children.filter((c) => this.hasWork(c.fen, c.children))

    if (sideToMove(fen) === this.rep.side && children.length > 0) {
      const key = positionKey(fen)
      if (this.needsWork(key)) {
        this.asking = { key, failed: false, isNew: !this.states[key] }
        return this.question()
      }
      // Known here: play it, toward what still needs work.
      if (ahead.length > 0) return this.play(ahead[0], 'trainee')
    } else if (ahead.length > 0) {
      return this.play(ahead[Math.floor(this.random() * ahead.length)], 'opponent')
    }
    this.path = []
    return { kind: 'lineEnd' }
  }

  private question(): Step {
    const asking = this.asking as { key: string; isNew: boolean }
    const card = this.cards.get(asking.key) as Card
    return { kind: 'ask', fen: this.fen, moves: card.moves, isNew: asking.isNew }
  }

  private play(node: TrainNode, by: 'opponent' | 'trainee'): Step {
    this.path.push(node)
    return { kind: 'move', node, by }
  }

  /** The trainee's move (SAN) for the pending question. A wrong move must be followed by the right one. */
  answer(san: string): AnswerResult {
    const asking = this.asking
    if (!asking) throw new Error('No question is pending')
    const moves = (this.cards.get(asking.key) as Card).moves
    const node = this.children.find((c) => c.san === san) ?? this.transposedAnswer(asking.key, san)
    const now = this.clock()
    const state = this.states[asking.key]

    if (!node) {
      if (!asking.failed) {
        asking.failed = true
        this.stats.mistakes++
        this.states[asking.key] = state ? review(state, false, now) : learningCard(now)
        this.introduced.add(asking.key)
      }
      return { correct: false, moves }
    }

    if (!asking.failed) {
      // A new move was shown with its answer: it is tested later, not now.
      this.states[asking.key] = state ? review(state, true, now) : learningCard(now)
      this.introduced.add(asking.key)
    }
    this.stats.answered++
    this.asking = null
    this.path.push(node)
    return { correct: true, moves, node }
  }

  /** Gives the answer away. Like a mistake, the card comes back soon. */
  reveal(): string[] {
    const asking = this.asking
    if (!asking) return []
    if (!asking.failed && !asking.isNew) {
      asking.failed = true
      this.stats.mistakes++
      this.states[asking.key] = review(this.states[asking.key], false, this.clock())
    }
    return (this.cards.get(asking.key) as Card).moves
  }

  private transposedAnswer(key: string, san: string): TrainNode | undefined {
    for (const list of this.answersAt.get(key) ?? []) {
      const node = list.find((c) => c.san === san)
      if (node) return node
    }
    return undefined
  }

  /** Squares of the repertoire moves at the pending question, for drawing hints. */
  hintSquares(): { from: string; to: string }[] {
    if (!this.asking) return []
    const moves = (this.cards.get(this.asking.key) as Card).moves
    const out: { from: string; to: string }[] = []
    for (const san of moves) {
      try {
        const m = new Chess(this.fen).move(san)
        out.push({ from: m.from, to: m.to })
      } catch {
        // not playable from this transposition
      }
    }
    return out
  }
}
