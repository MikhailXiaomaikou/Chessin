import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LlmPlayerConfig } from '@shared/llm/types'
import type { GameOutcome, LlmAttempt } from '@shared/llm/turn'

export type Seat = { kind: 'human' } | { kind: 'llm'; playerId: string }

export type MatchStatus = 'running' | 'paused' | 'finished'

export interface MatchResult {
  result: GameOutcome['result'] | '*'
  reason: GameOutcome['reason'] | 'forfeit' | 'resign' | 'aborted'
  detail?: string
}

export interface LlmLogEntry {
  id: string
  ply: number
  side: 'white' | 'black'
  playerName: string
  san?: string
  attempts: LlmAttempt[]
  error?: string
}

export interface LlmMatch {
  id: string
  white: Seat
  black: Seat
  status: MatchStatus
  startFen: string
  maxPlies: number
  result?: MatchResult
  error?: string // last API error, shown while paused
  thinking: 'white' | 'black' | null
}

export const DEFAULT_MAX_PLIES = 300

interface LlmState {
  players: LlmPlayerConfig[]
  match: LlmMatch | null
  log: LlmLogEntry[]

  addPlayer: (p: LlmPlayerConfig) => void
  updatePlayer: (p: LlmPlayerConfig) => void
  removePlayer: (id: string) => void

  startMatch: (white: Seat, black: Seat, startFen: string) => void
  pauseMatch: (error?: string) => void
  resumeMatch: () => void
  finishMatch: (result: MatchResult) => void
  endMatch: () => void
  setThinking: (side: 'white' | 'black' | null) => void
  addLog: (entry: LlmLogEntry) => void
}

export const useLlmStore = create<LlmState>()(
  persist(
    (set) => ({
      players: [],
      match: null,
      log: [],

      addPlayer: (p) => set((s) => ({ players: [...s.players, p] })),
      updatePlayer: (p) => set((s) => ({ players: s.players.map((x) => (x.id === p.id ? p : x)) })),
      removePlayer: (id) => set((s) => ({ players: s.players.filter((x) => x.id !== id) })),

      startMatch: (white, black, startFen) =>
        set({
          match: { id: `match_${Date.now()}`, white, black, status: 'running', startFen, maxPlies: DEFAULT_MAX_PLIES, thinking: null },
          log: []
        }),
      pauseMatch: (error) =>
        set((s) => (s.match ? { match: { ...s.match, status: 'paused', error, thinking: null } } : {})),
      resumeMatch: () =>
        set((s) =>
          s.match && s.match.status === 'paused'
            ? { match: { ...s.match, status: 'running', error: undefined } }
            : {}
        ),
      finishMatch: (result) =>
        set((s) => (s.match ? { match: { ...s.match, status: 'finished', result, thinking: null } } : {})),
      endMatch: () => set({ match: null, log: [] }),
      setThinking: (side) => set((s) => (s.match ? { match: { ...s.match, thinking: side } } : {})),
      addLog: (entry) => set((s) => ({ log: [...s.log, entry] }))
    }),
    {
      name: 'chess-gui-llm-players',
      // Only the player list is saved; a match lives as long as the window.
      partialize: (s) => ({ players: s.players })
    }
  )
)

export function seatFor(match: LlmMatch, turn: 'w' | 'b'): Seat {
  return turn === 'w' ? match.white : match.black
}

// True while a game with at least one LLM player is in progress.
export function isLlmGameActive(match: LlmMatch | null): boolean {
  return !!match && match.status !== 'finished' && (match.white.kind === 'llm' || match.black.kind === 'llm')
}
