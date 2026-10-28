import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Node has no window.localStorage; the store saves progress there.
const storage = vi.hoisted(() => {
  const data = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    }
  }
  ;(globalThis as { window?: unknown }).window = { localStorage }
  return localStorage
})

import { useTrainingStore } from './trainingStore'
import { useGameStore } from './gameStore'
import { useTabStore } from './tabStore'

const REPERTOIRE = '1. e4 e5 2. Nf3 Nc6 3. Bb5 *'
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const training = () => useTrainingStore.getState()
const prompt = () => training().active?.prompt
const line = (): string[] => useGameStore.getState().moveHistory.map((n) => n.san)

describe('training store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useTrainingStore.setState({ repertoires: [], cards: {}, active: null })
  })
  afterEach(() => {
    training().stop()
    vi.useRealTimers()
  })

  it('drills a line on its own board: new moves, replies, mistakes', () => {
    const before = useTabStore.getState().tabs.length
    const id = training().addRepertoire('Ruy Lopez', 'w', REPERTOIRE)
    expect(training().start(id, 'Training')).toBe(true)
    expect(useTabStore.getState().tabs).toHaveLength(before + 1)
    expect(useGameStore.getState().orientation).toBe('white')

    // First time: the move is shown, then played.
    expect(prompt()).toBe('new')
    expect(training().active?.hints).toEqual([{ from: 'e2', to: 'e4' }])
    expect(training().answer('e2', 'e4')).toBe(true)
    expect(training().answer('e7', 'e5')).toBe(false) // not the trainee's turn
    vi.advanceTimersByTime(250 + 450)
    expect(line()).toEqual(['e4', 'e5'])
    expect(prompt()).toBe('new')

    training().answer('g1', 'f3')
    vi.advanceTimersByTime(250 + 450)
    training().answer('f1', 'b5')
    vi.advanceTimersByTime(250)
    expect(prompt()).toBe('lineEnd')
    vi.advanceTimersByTime(900)

    // Second pass: asked without help; a mistake shows the answer.
    expect(useGameStore.getState().fen).toBe(START)
    expect(prompt()).toBe('ask')
    expect(training().active?.hints).toEqual([])
    expect(training().answer('d2', 'd4')).toBe(false)
    expect(training().active?.feedback).toEqual({ correct: false, moves: ['e4'] })
    expect(training().active?.hints).toEqual([{ from: 'e2', to: 'e4' }])
    expect(training().active?.stats.mistakes).toBe(1)
    expect(Object.values(training().cards[id])[0]).toMatchObject({ lapses: 1 })

    expect(training().answer('e2', 'e4')).toBe(true)
    expect(training().active?.feedback?.correct).toBe(true)

    // Progress is saved; the session itself is not.
    const saved = JSON.parse(storage.getItem('chessin-training') as string).state
    expect(Object.keys(saved.cards[id])).toHaveLength(3)
    expect(saved.repertoires[0]).toMatchObject({ name: 'Ruy Lopez', side: 'w' })
    expect(saved.active).toBeUndefined()
  })

  it('pauses on another board tab and picks up on return', () => {
    const id = training().addRepertoire('Ruy Lopez', 'w', REPERTOIRE)
    training().start(id, 'Training')
    const trainingTab = useTabStore.getState().activeTabId
    training().answer('e2', 'e4') // the reply is now pending

    const other = useTabStore.getState().tabs.find((t) => t.id !== trainingTab)?.id as string
    useTabStore.getState().switchTab(other)
    vi.advanceTimersByTime(1000)
    expect(prompt()).toBe('paused')
    expect(line()).not.toContain('e5') // the other board was left alone

    useTabStore.getState().switchTab(trainingTab)
    vi.advanceTimersByTime(1000)
    expect(prompt()).toBe('new')
    expect(line()).toEqual(['e4', 'e5'])
  })

  it('ends with its tab, and reports a repertoire with nothing to train', () => {
    const id = training().addRepertoire('Ruy Lopez', 'w', REPERTOIRE)
    training().start(id, 'Training')
    useTabStore.getState().closeTab(useTabStore.getState().activeTabId)
    expect(training().active).toBeNull()

    const blackOnly = training().addRepertoire('Nothing for White', 'w', '1. e4 *')
    expect(training().start(blackOnly, 'Training')).toBe(true) // White's first move is a card
    const empty = training().addRepertoire('Empty', 'b', '1. e4 *')
    expect(training().start(empty, 'Training')).toBe(false)
  })
})
