import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Chess } from 'chess.js'
import type { CardState } from '@shared/training/srs'
import {
  buildRepertoire,
  positionKey,
  TrainingSession,
  type Side,
  type TrainNode
} from '@shared/training/session'
import { useGameStore } from './gameStore'
import { useTabStore } from './tabStore'

export interface SavedRepertoire {
  id: string
  name: string
  side: Side
  /** The move tree, as PGN. */
  pgn: string
  createdAt: number
}

export type TrainingPrompt =
  | 'thinking' // the trainer is playing a move
  | 'ask' // the trainee's turn
  | 'new' // the trainee's turn, on a move shown for the first time
  | 'lineEnd'
  | 'done'
  | 'paused' // another board tab is showing

export interface ActiveTraining {
  repId: string
  /** The board tab the session plays on. */
  tabId: string
  session: TrainingSession
  prompt: TrainingPrompt
  /** The last answer, until the next one. */
  feedback: { correct: boolean; moves: string[] } | null
  /** Arrows to draw: a new move, a hint, the answer after a mistake. */
  hints: { from: string; to: string }[]
  stats: { answered: number; mistakes: number }
}

interface TrainingState {
  repertoires: SavedRepertoire[]
  /** Card states per repertoire, by position key. */
  cards: Record<string, Record<string, CardState>>
  active: ActiveTraining | null

  addRepertoire: (name: string, side: Side, pgn: string) => string
  updateRepertoire: (id: string, pgn: string) => void
  removeRepertoire: (id: string) => void
  /** Starts a session in a new board tab; false if the repertoire has nothing to train. */
  start: (repId: string, tabName: string) => boolean
  /** The trainee's move on the board. False when it is not accepted (the piece goes back). */
  answer: (from: string, to: string, promotion?: string) => boolean
  showHint: () => void
  stop: () => void
}

const OPPONENT_DELAY = 450
const OWN_DELAY = 250
const LINE_PAUSE = 900

let timer: ReturnType<typeof setTimeout> | null = null
function later(ms: number, fn: () => void): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    fn()
  }, ms)
}

const active = (): ActiveTraining | null => useTrainingStore.getState().active

function update(patch: Partial<ActiveTraining>): void {
  const current = active()
  if (!current) return
  useTrainingStore.setState({
    active: { ...current, ...patch, stats: { ...current.session.stats } }
  })
}

function saveCards(training: ActiveTraining): void {
  useTrainingStore.setState((s) => ({
    cards: { ...s.cards, [training.repId]: { ...training.session.states } }
  }))
}

const onItsTab = (training: ActiveTraining): boolean =>
  useTabStore.getState().activeTabId === training.tabId

/** Puts the session's line on the board, if the trainee wandered off it. */
function syncBoard(session: TrainingSession): void {
  if (positionKey(useGameStore.getState().fen) === positionKey(session.fen)) return
  useGameStore.getState().newGame(session.rep.startFen)
  for (const node of session.line) useGameStore.getState().makeMove(node.from, node.to, node.promotion)
}

/** Shows the session's last move on the board. */
function showMove(session: TrainingSession, node: TrainNode): void {
  const line = session.line
  const before = line.length > 1 ? line[line.length - 2].fen : session.rep.startFen
  const game = useGameStore.getState()
  if (positionKey(game.fen) === positionKey(before)) game.makeMove(node.from, node.to, node.promotion)
  else syncBoard(session)
}

/** Runs the session until it needs the trainee (or ends). */
function step(): void {
  const training = active()
  if (!training) return
  if (!onItsTab(training)) {
    update({ prompt: 'paused' })
    return
  }
  const { session } = training
  const next = session.next()
  switch (next.kind) {
    case 'move':
      update({ prompt: 'thinking', hints: [] })
      later(next.by === 'opponent' ? OPPONENT_DELAY : OWN_DELAY, () => {
        const now = active()
        if (now?.session !== session) return
        if (!onItsTab(now)) {
          update({ prompt: 'paused' })
          return
        }
        showMove(session, next.node)
        step()
      })
      return
    case 'ask':
      syncBoard(session)
      update({
        prompt: next.isNew ? 'new' : 'ask',
        hints: next.isNew ? session.hintSquares() : []
      })
      return
    case 'lineEnd':
      update({ prompt: 'lineEnd', hints: [] })
      later(LINE_PAUSE, () => {
        const now = active()
        if (now?.session !== session) return
        if (onItsTab(now)) useGameStore.getState().newGame(session.rep.startFen)
        update({ feedback: null })
        step()
      })
      return
    case 'done':
      update({ prompt: 'done', hints: [] })
      return
  }
}

export const useTrainingStore = create<TrainingState>()(
  persist(
    (set, get) => ({
      repertoires: [],
      cards: {},
      active: null,

      addRepertoire: (name, side, pgn) => {
        const id = `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        set((s) => ({ repertoires: [...s.repertoires, { id, name, side, pgn, createdAt: Date.now() }] }))
        return id
      },

      updateRepertoire: (id, pgn) => {
        set((s) => ({ repertoires: s.repertoires.map((r) => (r.id === id ? { ...r, pgn } : r)) }))
      },

      removeRepertoire: (id) => {
        if (get().active?.repId === id) get().stop()
        set((s) => {
          const cards = { ...s.cards }
          delete cards[id]
          return { repertoires: s.repertoires.filter((r) => r.id !== id), cards }
        })
      },

      start: (repId, tabName) => {
        get().stop()
        const saved = get().repertoires.find((r) => r.id === repId)
        if (!saved) return false
        const session = new TrainingSession(buildRepertoire(saved.pgn, saved.side), get().cards[repId] ?? {})
        if (session.cards.size === 0) return false

        // A board of its own, so the game on the current one is kept.
        useTabStore.getState().addTab(tabName)
        useGameStore.getState().newGame(session.rep.startFen)
        useGameStore.setState({ orientation: saved.side === 'w' ? 'white' : 'black' })
        set({
          active: {
            repId,
            tabId: useTabStore.getState().activeTabId,
            session,
            prompt: 'thinking',
            feedback: null,
            hints: [],
            stats: { ...session.stats }
          }
        })
        step()
        return true
      },

      answer: (from, to, promotion) => {
        const training = get().active
        if (!training || (training.prompt !== 'ask' && training.prompt !== 'new')) return false
        const { session } = training
        // The move must be made from the session's position.
        if (positionKey(useGameStore.getState().fen) !== positionKey(session.fen)) {
          syncBoard(session)
          return false
        }
        let san: string
        try {
          san = new Chess(session.fen).move({ from, to, promotion }).san
        } catch {
          return false
        }
        const result = session.answer(san)
        saveCards(training)
        if (!result.correct || !result.node) {
          update({ feedback: { correct: false, moves: result.moves }, hints: session.hintSquares() })
          return false
        }
        const node = result.node
        useGameStore.getState().makeMove(node.from, node.to, node.promotion)
        update({ prompt: 'thinking', feedback: { correct: true, moves: result.moves }, hints: [] })
        later(OWN_DELAY, step)
        return true
      },

      showHint: () => {
        const training = get().active
        if (!training || (training.prompt !== 'ask' && training.prompt !== 'new')) return
        training.session.reveal()
        saveCards(training)
        update({ hints: training.session.hintSquares() })
      },

      stop: () => {
        if (timer) clearTimeout(timer)
        timer = null
        set({ active: null })
      }
    }),
    {
      name: 'chessin-training',
      partialize: (s) => ({ repertoires: s.repertoires, cards: s.cards })
    }
  )
)

// Pause while another board tab shows; pick up again on return; end with the tab.
useTabStore.subscribe((state, prev) => {
  const training = active()
  if (!training) return
  if (!state.tabs.some((t) => t.id === training.tabId)) {
    useTrainingStore.getState().stop()
    return
  }
  if (state.activeTabId === training.tabId && prev.activeTabId !== training.tabId) {
    // After the tab switch has loaded this tab's game.
    setTimeout(() => {
      const now = active()
      if (now && now.prompt === 'paused') step()
    }, 0)
  }
})
