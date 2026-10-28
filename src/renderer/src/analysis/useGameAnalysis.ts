import { useCallback, useRef } from 'react'
import { Chess } from 'chess.js'
import { useGameStore } from '@renderer/stores/gameStore'
import { useEngineStore } from '@renderer/stores/engineStore'
import { useAnalysisStore, classifyMoveAdvanced, type MoveEval } from '@renderer/stores/analysisStore'

// Analyze each position in the game using the active engine.
// We send position → wait for a fixed depth → collect best score & best move → move on.
export function useGameAnalysis() {
  const abortRef = useRef(false)

  const analyzeGame = useCallback(async (depth: number = 18) => {
    const { moveHistory, startFen } = useGameStore.getState()
    if (moveHistory.length === 0) return

    const engines = useEngineStore.getState().engines
    const activeEngine = engines.find((e) => e.isActive)
    if (!activeEngine || !window.electronAPI?.engine) return

    const { setAnalyzingGame, setAnalysisProgress, addMoveEval, clearAnalysis } =
      useAnalysisStore.getState()

    clearAnalysis()
    setAnalyzingGame(true)
    abortRef.current = false

    const totalMoves = moveHistory.length

    // We'll analyze each position by:
    // 1. Setting up the position (FEN after first N moves)
    // 2. Requesting depth-limited search
    // 3. Waiting for bestmove + collecting info lines

    let prevScore = 0 // centipawns, from white's perspective

    for (let i = 0; i < totalMoves; i++) {
      if (abortRef.current) break

      setAnalysisProgress(i, totalMoves)

      // The tree stores every position, so a set-up start or a null move needs no replaying.
      const move = moveHistory[i]
      const posFen = i === 0 ? startFen : moveHistory[i - 1].fen
      if (!move.from) continue // a null move has nothing to judge
      const turn = posFen.split(' ')[1] as 'w' | 'b' // who is about to play move i
      const chess = new Chess(move.fen)

      // Analyze the position BEFORE the move to find engine's best
      const result = await analyzePosition(activeEngine.id, posFen, depth)

      if (!result || abortRef.current) break

      // Engine score is from the perspective of side to move
      // Convert to white's perspective
      const engineScore = result.score // cp from side-to-move perspective
      const scoreBeforeWhite = turn === 'w' ? engineScore : -engineScore

      // Score after the played move: analyze the position AFTER the move
      const resultAfter = await analyzePosition(activeEngine.id, chess.fen(), depth)
      if (!resultAfter || abortRef.current) break

      // Score after is from the NEW side to move's perspective
      const turnAfter = chess.turn()
      const scoreAfterWhite = turnAfter === 'w' ? resultAfter.score : -resultAfter.score

      // Eval loss: how much did the played move lose compared to the best?
      // From the moving player's perspective
      const playerScoreBefore = turn === 'w' ? scoreBeforeWhite : -scoreBeforeWhite
      const playerScoreAfter = turn === 'w' ? scoreAfterWhite : -scoreAfterWhite
      // The engine says best was playerScoreBefore, after the move it's -playerScoreAfter (opponent's turn)
      // Actually: evalLoss = bestEval - actualEval (from the player's perspective)
      // bestEval = |engineScore| (the engine's eval of the best move from this position)
      // actualEval = what the position is worth after the played move
      const evalLoss = playerScoreBefore - playerScoreAfter
      const isBestMove = result.bestMove === `${move.from}${move.to}${move.promotion || ''}`

      const classification = classifyMoveAdvanced(
        Math.max(0, evalLoss),
        isBestMove,
        scoreBeforeWhite,
        scoreAfterWhite,
        turn
      )

      const eval_: MoveEval = {
        moveIndex: i,
        scoreBefore: scoreBeforeWhite,
        scoreAfter: scoreAfterWhite,
        bestMove: result.bestMoveSan,
        playedMove: move.san,
        classification,
        evalLoss: Math.max(0, evalLoss)
      }

      addMoveEval(eval_)
      prevScore = scoreAfterWhite
    }

    setAnalysisProgress(totalMoves, totalMoves)
    setAnalyzingGame(false)
  }, [])

  const stopAnalysis = useCallback(() => {
    abortRef.current = true
    useAnalysisStore.getState().setAnalyzingGame(false)
  }, [])

  return { analyzeGame, stopAnalysis }
}

interface PositionResult {
  score: number // centipawns from side-to-move perspective
  bestMove: string // UCI
  bestMoveSan: string
}

function analyzePosition(engineId: string, fen: string, depth: number): Promise<PositionResult | null> {
  return new Promise((resolve) => {
    let bestScore = 0
    let bestMoveUci = ''
    let bestPv: string[] = []
    let resolved = false

    const cleanup = window.electronAPI.engine.onOutput((data) => {
      if (data.engineId !== engineId) return

      if (data.type === 'info' && data.info) {
        const info = data.info as {
          depth: number
          multipv: number
          score: { type: 'cp' | 'mate'; value: number }
          pv: string[]
        }
        if (info.multipv === 1 && info.depth >= Math.min(depth, 5)) {
          if (info.score.type === 'mate') {
            bestScore = info.score.value > 0 ? 10000 - info.score.value : -10000 - info.score.value
          } else {
            bestScore = info.score.value
          }
          if (info.pv.length > 0) {
            bestMoveUci = info.pv[0]
            bestPv = info.pv
          }
        }
      }

      if (data.type === 'bestmove' && !resolved) {
        resolved = true
        cleanup()

        const bm = data.bestmove as { move: string }
        const uci = bm?.move || bestMoveUci

        // Convert bestmove to SAN
        let bestMoveSan = uci
        try {
          const chess = new Chess(fen)
          const from = uci.slice(0, 2)
          const to = uci.slice(2, 4)
          const promo = uci.length > 4 ? uci[4] : undefined
          const result = chess.move({ from, to, promotion: promo })
          if (result) bestMoveSan = result.san
        } catch { /* keep UCI */ }

        resolve({
          score: bestScore,
          bestMove: uci,
          bestMoveSan
        })
      }
    })

    // Start analysis with fixed depth
    window.electronAPI.engine.startAnalysis({
      engineId,
      fen,
      moves: [],
      params: { depth }
    }).catch(() => {
      cleanup()
      resolve(null)
    })

    // Timeout: 30s max per position
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        window.electronAPI.engine.stopAnalysis(engineId).catch(() => {})
        resolve(bestMoveUci ? { score: bestScore, bestMove: bestMoveUci, bestMoveSan: bestMoveUci } : null)
      }
    }, 30000)
  })
}
