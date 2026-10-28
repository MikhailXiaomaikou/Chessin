import { describe, it, expect, beforeEach } from 'vitest'
import { Chess } from 'chess.js'
import { useGameStore, NULL_MOVE, type MoveTreeNode } from './gameStore'

const store = () => useGameStore.getState()
const node = (id: string | null | undefined): MoveTreeNode => store().treeNodes[id ?? '']
const sans = (ids: string[]): string[] => ids.map((id) => node(id).san)

function mainline(): string[] {
  const out: string[] = []
  for (let id: string | undefined = store().rootChildren[0]; id; id = node(id).children[0]) {
    out.push(node(id).san)
  }
  return out
}

// The tree without node IDs, for comparing two loads of the same game.
function shape(ids: string[] = store().rootChildren): unknown[] {
  return ids.map((id) => {
    const { san, fen, comment, commentBefore, nags, children } = node(id)
    return { san, fen, comment, commentBefore, nags, children: shape(children) }
  })
}

const ANNOTATED = `[Event "Test"]
[White "Kasparov, G."]
[Black "Topalov, V."]
[Result "1-0"]

{Opening survey} 1. e4 {Best by test} c5 $1 (1... e5 2. Nf3 (2. f4 exf4) 2... Nc6) ({Or} 1... c6) 2. Nf3 d6!? 3. d4 1-0`

beforeEach(() => store().newGame())

describe('gameStore PGN', () => {
  it('loads variations, comments and NAGs', () => {
    expect(store().loadPgn(ANNOTATED)).toBe(true)
    const s = store()
    expect(s.headers).toEqual({
      Event: 'Test',
      White: 'Kasparov, G.',
      Black: 'Topalov, V.',
      Result: '1-0'
    })
    expect(s.gameComment).toBe('Opening survey')
    expect(mainline()).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4'])

    const e4 = node(s.rootChildren[0])
    expect(e4.comment).toBe('Best by test')
    expect(sans(e4.children)).toEqual(['c5', 'e5', 'c6'])
    const [c5, e5, c6] = e4.children.map(node)
    expect(c5.nags).toEqual([1])
    expect(c6.commentBefore).toBe('Or')
    expect(sans(e5.children)).toEqual(['Nf3', 'f4'])
    expect(sans(node(e5.children[1]).children)).toEqual(['exf4'])
    expect(sans(node(e5.children[0]).children)).toEqual(['Nc6'])

    // Opens at the end of the main line.
    expect(node(s.currentNodeId).san).toBe('d4')
    expect(s.lastMove).toEqual({ from: 'd2', to: 'd4' })
    expect(s.moveHistory).toHaveLength(5)
  })

  it('writes everything back and reads it again unchanged', () => {
    store().loadPgn(ANNOTATED)
    const before = shape()
    const pgn = store().getPgn()
    expect(pgn).toBe(
      '[Event "Test"]\n[White "Kasparov, G."]\n[Black "Topalov, V."]\n[Result "1-0"]\n\n' +
        '{Opening survey} 1. e4 {Best by test} 1... c5 $1 (1... e5 2. Nf3 (2. f4 exf4) 2... Nc6) ' +
        '({Or} 1... c6) 2. Nf3 d6 $5 3. d4 1-0'
    )
    store().newGame()
    expect(store().loadPgn(pgn)).toBe(true)
    expect(shape()).toEqual(before)
    expect(store().getPgn()).toBe(pgn)
  })

  it('plays null moves and starts from a FEN tag', () => {
    const pgn = '[SetUp "1"]\n[FEN "8/8/8/4k3/8/8/4K3/7R w - - 0 40"]\n\n40. Rh5+ Kd4 41. -- Kc3 *'
    expect(store().loadPgn(pgn)).toBe(true)
    const s = store()
    expect(s.startFen).toBe('8/8/8/4k3/8/8/4K3/7R w - - 0 40')
    expect(s.headers).toEqual({})
    expect(mainline()).toEqual(['Rh5+', 'Kd4', NULL_MOVE, 'Kc3'])
    expect(s.lastMove).toEqual({ from: 'd4', to: 'c3' })

    const pass = s.moveHistory[2]
    expect(pass.fen).toBe('8/8/8/7R/3k4/8/4K3/8 b - - 3 41')
    s.goToNode(pass.id)
    expect(store().turn).toBe('b')
    expect(store().lastMove).toBeNull()

    expect(store().getPgn()).toBe(
      '[SetUp "1"]\n[FEN "8/8/8/4k3/8/8/4K3/7R w - - 0 40"]\n\n40. Rh5+ Kd4 41. -- Kc3 *'
    )
  })

  it('refuses a null move out of check', () => {
    store().loadPgn('1. e4 f5 2. Qh5+ -- 3. Qe8+ *')
    expect(mainline()).toEqual(['e4', 'f5', 'Qh5+'])
  })

  it('drops an illegal move with the rest of its line only', () => {
    expect(store().loadPgn('1. e4 e5 (1... Ke7 2. Qh5) (1... c5 2. Nf3) 2. Ke3 Nc6 *')).toBe(true)
    expect(mainline()).toEqual(['e4', 'e5'])
    expect(sans(node(store().rootChildren[0]).children)).toEqual(['e5', 'c5'])
  })

  it('rejects text that is not a game and keeps the current one', () => {
    store().loadPgn('1. d4 d5 *')
    expect(store().loadPgn('hello world')).toBe(false)
    expect(store().loadPgn('')).toBe(false)
    expect(store().loadPgn('[FEN "not a position"]\n\n1. e4 *')).toBe(false)
    expect(mainline()).toEqual(['d4', 'd5'])
  })

  it('keeps a game without moves', () => {
    expect(store().loadPgn('[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1-0')).toBe(true)
    expect(store().rootChildren).toEqual([])
    expect(store().getPgn()).toBe('[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1-0')
  })

  it('opens at a requested position, ignoring move counters', () => {
    const chess = new Chess()
    for (const san of ['e4', 'e5', 'Nf3']) chess.move(san)
    const fen = chess.fen().replace(/ \d+ \d+$/, ' 7 30')
    store().loadPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 *', { goToFen: fen })
    expect(node(store().currentNodeId).san).toBe('Nf3')
    expect(store().fen).toBe(chess.fen())

    store().loadPgn('1. e4 e5 *', { goToFen: new Chess().fen() })
    expect(store().currentNodeId).toBeNull()
  })

  it('escapes tag values and braces in comments', () => {
    store().loadPgn('[White "A \\"B\\" \\\\ C"]\n\n1. e4 *')
    const e4 = store().rootChildren[0]
    store().setComment(e4, 'see {this}')
    const pgn = store().getPgn()
    expect(pgn).toBe('[White "A \\"B\\" \\\\ C"]\n\n1. e4 {see (this)} *')
    store().loadPgn(pgn)
    expect(store().headers.White).toBe('A "B" \\ C')
  })

  it('keeps a game played on the board free of tags', () => {
    store().makeMove('e2', 'e4')
    store().makeMove('e7', 'e5')
    expect(store().getPgn()).toBe('1. e4 e5 *')
    store().newGame()
    expect(store().getPgn()).toBe('')
  })
})

describe('gameStore annotations', () => {
  it('edits comment text without losing its shapes', () => {
    store().loadPgn('1. e4 {[%cal Ge2e4] Old} e5 *')
    const e4 = store().rootChildren[0]
    store().setComment(e4, 'New idea')
    expect(node(e4).comment).toBe('[%cal Ge2e4] New idea')
    store().setShapes(e4, [{ color: 'R', orig: 'f7' }])
    expect(node(e4).comment).toBe('[%csl Rf7] New idea')
    store().setShapes(e4, [])
    store().setComment(e4, '  ')
    expect(node(e4).comment).toBeUndefined()

    store().setComment(null, 'Intro')
    expect(store().gameComment).toBe('Intro')
    expect(store().getPgn()).toBe('{Intro} 1. e4 e5 *')
  })

  it('toggles NAGs, one move mark and one evaluation at a time', () => {
    store().loadPgn('1. e4 e5 *')
    const e4 = store().rootChildren[0]
    store().toggleNag(e4, 14)
    store().toggleNag(e4, 1)
    store().toggleNag(e4, 3)
    expect(node(e4).nags).toEqual([3, 14])
    store().toggleNag(e4, 16)
    store().toggleNag(e4, 146)
    expect(node(e4).nags).toEqual([3, 16, 146])
    for (const nag of [3, 16, 146]) store().toggleNag(e4, nag)
    expect(node(e4).nags).toBeUndefined()
  })

  it('keeps the current line in step with edited nodes', () => {
    store().loadPgn('1. e4 e5 *')
    const e4 = store().rootChildren[0]
    store().toggleNag(e4, 1)
    expect(store().moveHistory[0]).toBe(node(e4))
    expect(store().moveHistory[0].nags).toEqual([1])
  })
})
