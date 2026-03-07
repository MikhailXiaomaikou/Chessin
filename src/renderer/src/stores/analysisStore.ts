import { create } from 'zustand'

export type MoveClassification =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'book'

export interface MoveEval {
  moveIndex: number
  scoreBefore: number // centipawns (from white's perspective)
  scoreAfter: number
  bestMove: string // SAN
  playedMove: string // SAN
  classification: MoveClassification
  evalLoss: number // centipawns lost
}

export interface GameAnalysisState {
  moveEvals: MoveEval[]
  isAnalyzingGame: boolean
  analysisProgress: number // 0 to 1
  analysisTotalMoves: number

  setMoveEvals: (evals: MoveEval[]) => void
  addMoveEval: (eval_: MoveEval) => void
  setAnalyzingGame: (analyzing: boolean) => void
  setAnalysisProgress: (current: number, total: number) => void
  clearAnalysis: () => void
}

export function classifyMove(evalLoss: number, isBestMove: boolean): MoveClassification {
  if (isBestMove) {
    if (evalLoss <= 0) return 'best'
    return 'best'
  }
  // evalLoss is positive = player lost centipawns
  if (evalLoss <= 0) return 'best'
  if (evalLoss <= 10) return 'good'
  if (evalLoss <= 30) return 'good'
  if (evalLoss <= 50) return 'inaccuracy'
  if (evalLoss <= 100) return 'mistake'
  return 'blunder'
}

// Upgraded classification: detect brilliant/great moves
export function classifyMoveAdvanced(
  evalLoss: number,
  isBestMove: boolean,
  scoreBefore: number,
  scoreAfter: number,
  turn: 'w' | 'b'
): MoveClassification {
  // From the perspective of the player who moved
  const playerScoreBefore = turn === 'w' ? scoreBefore : -scoreBefore
  const playerScoreAfter = turn === 'w' ? scoreAfter : -scoreAfter
  const gain = playerScoreAfter - playerScoreBefore

  if (evalLoss <= 0 && gain > 150) return 'brilliant'
  if (evalLoss <= 0 && gain > 50) return 'great'
  if (isBestMove || evalLoss <= 5) return 'best'
  if (evalLoss <= 25) return 'good'
  if (evalLoss <= 50) return 'inaccuracy'
  if (evalLoss <= 100) return 'mistake'
  return 'blunder'
}

export const CLASSIFICATION_COLORS: Record<MoveClassification, string> = {
  brilliant: '#1baca6',
  great: '#5c8bb0',
  best: '#96bc4b',
  good: '#96bc4b',
  inaccuracy: '#f7c631',
  mistake: '#e58f2a',
  blunder: '#ca3431',
  book: '#a88764'
}

export const CLASSIFICATION_SYMBOLS: Record<MoveClassification, string> = {
  brilliant: '!!',
  great: '!',
  best: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  book: ''
}

export const useAnalysisStore = create<GameAnalysisState>((set) => ({
  moveEvals: [],
  isAnalyzingGame: false,
  analysisProgress: 0,
  analysisTotalMoves: 0,

  setMoveEvals: (evals) => set({ moveEvals: evals }),
  addMoveEval: (eval_) =>
    set((state) => ({ moveEvals: [...state.moveEvals, eval_] })),
  setAnalyzingGame: (analyzing) => set({ isAnalyzingGame: analyzing }),
  setAnalysisProgress: (current, total) =>
    set({ analysisProgress: current, analysisTotalMoves: total }),
  clearAnalysis: () =>
    set({ moveEvals: [], isAnalyzingGame: false, analysisProgress: 0, analysisTotalMoves: 0 })
}))
