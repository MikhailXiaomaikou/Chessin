import { describe, it, expect } from 'vitest'
import { DAY_MS, learningCard, review, type CardState } from './srs'
import {
  buildRepertoire,
  cardCounts,
  positionKey,
  repertoireCards,
  TrainingSession,
  NEW_PER_SESSION,
  type Step
} from './session'

const NOW = Date.UTC(2026, 0, 1)

describe('spaced repetition', () => {
  it('spaces correct answers ever further apart', () => {
    let card = learningCard(NOW)
    const intervals: number[] = []
    for (let i = 0; i < 4; i++) {
      card = review(card, true, NOW)
      intervals.push(card.interval)
    }
    expect(intervals).toEqual([1, 3, 8, 20])
    expect(card.due).toBe(NOW + 20 * DAY_MS)
  })

  it('brings a mistake back at once and lowers its ease', () => {
    const learned: CardState = { reps: 3, lapses: 0, ease: 2.5, interval: 8, due: NOW }
    const lapsed = review(learned, false, NOW)
    expect(lapsed).toEqual({ reps: 0, lapses: 1, ease: 2.3, interval: 0, due: NOW })
    expect(review(lapsed, true, NOW).interval).toBe(1)
    let worst = lapsed
    for (let i = 0; i < 10; i++) worst = review(worst, false, NOW)
    expect(worst.ease).toBe(1.3)
  })
})

const WHITE_REP = '1. e4 e5 (1... c5 2. Nf3 d6 3. d4) 2. Nf3 Nc6 3. Bb5 *'
const fenAfter = (sans: string): string => {
  const rep = buildRepertoire(sans + ' *', 'w')
  let node = rep.roots[0]
  while (node.children[0]) node = node.children[0]
  return node.fen
}

describe('repertoire', () => {
  it('turns the tree into cards for the trainee side', () => {
    const rep = buildRepertoire(WHITE_REP, 'w')
    const cards = repertoireCards(rep)
    expect([...cards.values()].map((c) => c.moves)).toEqual([['e4'], ['Nf3'], ['Bb5'], ['Nf3'], ['d4']])
    expect(repertoireCards(buildRepertoire(WHITE_REP, 'b')).size).toBe(3) // e5, c5 and d6, Nc6
  })

  it('merges repeated moves and stops a line at an illegal move', () => {
    // A variation after a move is an alternative to it, so these all start from move one.
    const rep = buildRepertoire('1. e4 (1. e4 c5) (1. Ke2) (1. d4 d5 2. Kd7) 1... e5 *', 'b')
    expect(rep.roots.map((n) => n.san)).toEqual(['e4', 'd4'])
    expect(rep.roots[0].children.map((n) => n.san)).toEqual(['e5', 'c5'])
    expect(rep.roots[1].children[0].children).toEqual([])
  })

  it('starts from a FEN tag', () => {
    const rep = buildRepertoire('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n\n1. e4 Kd7 2. e5 *', 'w')
    expect(rep.startFen).toBe('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1')
    expect(repertoireCards(rep).size).toBe(2)
  })

  it('counts due, new and learned cards', () => {
    const cards = repertoireCards(buildRepertoire(WHITE_REP, 'w'))
    const [first, second] = [...cards.keys()]
    const states = {
      [first]: { ...learningCard(NOW), due: NOW - 1 },
      [second]: { ...learningCard(NOW), due: NOW + DAY_MS }
    }
    expect(cardCounts(cards, states, NOW)).toEqual({ due: 1, new: 3, learned: 1, total: 5 })
  })
})

// Plays a session to its end, answering every question correctly.
function drive(session: TrainingSession, limit = 500): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < limit; i++) {
    const step = session.next()
    steps.push(step)
    if (step.kind === 'done') return steps
    if (step.kind === 'ask') session.answer(step.moves[0])
  }
  throw new Error('session did not finish')
}

describe('training session', () => {
  it('introduces new moves, then asks them again until known', () => {
    const session = new TrainingSession(buildRepertoire(WHITE_REP, 'w'), {}, () => NOW, () => 0)
    const first = session.next()
    expect(first).toMatchObject({ kind: 'ask', moves: ['e4'], isNew: true })
    expect(session.hintSquares()).toEqual([{ from: 'e2', to: 'e4' }])
    expect(session.answer('e4')).toMatchObject({ correct: true })
    expect(session.next()).toMatchObject({ kind: 'move', by: 'opponent', node: { san: 'e5' } })

    const steps = [first, ...drive(session)]
    const asks = steps.filter((s) => s.kind === 'ask')
    // Five positions: each shown once as new, then asked once more.
    expect(asks.filter((s) => s.kind === 'ask' && s.isNew)).toHaveLength(5)
    expect(asks).toHaveLength(10)
    expect(Object.values(session.states).every((s) => s.reps === 1 && s.interval === 1)).toBe(true)
  })

  it('plays known moves itself and steers toward what is due', () => {
    const rep = buildRepertoire(WHITE_REP, 'w')
    const later = { ...learningCard(NOW), reps: 2, interval: 3, due: NOW + DAY_MS }
    const states: Record<string, CardState> = {}
    for (const key of repertoireCards(rep).keys()) states[key] = later
    const dueKey = positionKey(fenAfter('1. e4 c5 2. Nf3 d6'))
    states[dueKey] = { ...later, due: NOW - 1 }

    const session = new TrainingSession(rep, states, () => NOW, () => 0.99)
    const played: string[] = []
    let step = session.next()
    while (step.kind === 'move') {
      played.push(`${step.by}:${step.node.san}`)
      step = session.next()
    }
    expect(played).toEqual(['trainee:e4', 'opponent:c5', 'trainee:Nf3', 'opponent:d6'])
    expect(step).toMatchObject({ kind: 'ask', moves: ['d4'], isNew: false })
  })

  it('records a mistake once and waits for the right move', () => {
    const rep = buildRepertoire('1. d4 d5 2. c4 *', 'w')
    const known = { ...learningCard(NOW), reps: 3, interval: 8, due: NOW - 1 }
    const keys = [...repertoireCards(rep).keys()]
    const session = new TrainingSession(rep, { [keys[0]]: known, [keys[1]]: known }, () => NOW)
    expect(session.next()).toMatchObject({ kind: 'ask', moves: ['d4'] })
    expect(session.answer('e4')).toEqual({ correct: false, moves: ['d4'] })
    expect(session.answer('Nf3')).toEqual({ correct: false, moves: ['d4'] })
    expect(session.stats.mistakes).toBe(1)
    expect(session.states[keys[0]]).toMatchObject({ reps: 0, lapses: 1, due: NOW })
    expect(session.answer('d4')).toMatchObject({ correct: true })
    // The failed card keeps its lapse: getting it right after the fact is no review.
    expect(session.states[keys[0]]).toMatchObject({ reps: 0, lapses: 1 })
    expect(session.next()).toMatchObject({ kind: 'move', node: { san: 'd5' } })
    expect(session.next()).toMatchObject({ kind: 'ask', moves: ['c4'] })
  })

  it('counts a revealed answer as a miss, but not for a new move', () => {
    const rep = buildRepertoire('1. d4 d5 2. c4 *', 'w')
    const [first] = repertoireCards(rep).keys()
    const known = { ...learningCard(NOW), reps: 3, interval: 8, due: NOW - 1 }
    const session = new TrainingSession(rep, { [first]: known }, () => NOW)
    session.next()
    expect(session.reveal()).toEqual(['d4'])
    expect(session.reveal()).toEqual(['d4'])
    expect(session.stats.mistakes).toBe(1)
    expect(session.states[first]).toMatchObject({ reps: 0, lapses: 1 })
    session.answer('d4')
    session.next() // 1... d5
    expect(session.next()).toMatchObject({ kind: 'ask', isNew: true })
    session.reveal() // a new move is shown anyway
    expect(session.stats.mistakes).toBe(1)
  })

  it('reports done when nothing is due', () => {
    const rep = buildRepertoire(WHITE_REP, 'w')
    const states: Record<string, CardState> = {}
    for (const key of repertoireCards(rep).keys()) {
      states[key] = { ...learningCard(NOW), reps: 1, interval: 1, due: NOW + DAY_MS }
    }
    expect(new TrainingSession(rep, states, () => NOW).next()).toEqual({ kind: 'done' })
  })

  it(`introduces at most ${NEW_PER_SESSION} new positions per session`, () => {
    const firstMoves = ['e4', 'd4', 'c4', 'Nf3', 'g3', 'b3', 'f4', 'Nc3', 'b4', 'e3', 'd3', 'c3']
    const others = firstMoves.slice(1).map((m) => `(1. ${m} e6)`)
    const pgn = `1. ${firstMoves[0]} ${others.join(' ')} 1... e6 *`
    const rep = buildRepertoire(pgn, 'b')
    expect(repertoireCards(rep).size).toBe(12)
    const session = new TrainingSession(rep, {}, () => NOW, Math.random)
    drive(session)
    expect(Object.keys(session.states)).toHaveLength(NEW_PER_SESSION)
  })

  it('accepts a move found through a transposition', () => {
    // Black's repertoire answers the same position differently in two lines.
    const rep = buildRepertoire('1. d4 (1. Nf3 d5 2. d4 Bf5) 1... d5 2. Nf3 Nf6 *', 'b')
    const key = positionKey(fenAfter('1. d4 d5 2. Nf3'))
    expect(repertoireCards(rep).get(key)?.moves).toEqual(['Nf6', 'Bf5'])

    const session = new TrainingSession(rep, {}, () => NOW, () => 0)
    let step = session.next()
    while (!(step.kind === 'ask' && positionKey(step.fen) === key)) {
      if (step.kind === 'ask') session.answer(step.moves[0])
      step = session.next()
    }
    expect(session.line.map((n) => n.san)).toEqual(['d4', 'd5', 'Nf3'])
    expect(session.answer('Bf5')).toMatchObject({ correct: true, node: { san: 'Bf5' } })
  })
})
