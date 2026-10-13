import { useEffect, useRef, useCallback } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Key } from 'chessground/types'
import type { DrawShape } from 'chessground/draw'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useEngineStore, ENGINE_COLORS } from '@renderer/stores/engineStore'
import { useSounds } from '@renderer/board/hooks/useSounds'
import { useLlmStore, seatFor } from '@renderer/stores/llmStore'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'

// Map engine colors to chessground brush names.
// We use built-in brushes + custom brush via color hex.
const BRUSH_NAMES = ['green', 'blue', 'yellow', 'red', 'green', 'blue'] as const

export default function ChessBoard() {
  const boardRef = useRef<HTMLDivElement>(null)
  const cgRef = useRef<Api | null>(null)

  const fen = useGameStore((s) => s.fen)
  const turn = useGameStore((s) => s.turn)
  const isCheck = useGameStore((s) => s.isCheck)
  const lastMove = useGameStore((s) => s.lastMove)
  const orientation = useGameStore((s) => s.orientation)
  const isGameOver = useGameStore((s) => s.isGameOver)
  const makeMove = useGameStore((s) => s.makeMove)
  const getAllLegalDests = useGameStore((s) => s.getAllLegalDests)

  const showCoordinates = useUIStore((s) => s.showCoordinates)
  const showLegalMoves = useUIStore((s) => s.showLegalMoves)
  const showEngineArrows = useUIStore((s) => s.showEngineArrows)

  const engines = useEngineStore((s) => s.engines)
  const analysisResults = useEngineStore((s) => s.analysisResults)
  const isAnalyzing = useEngineStore((s) => s.isAnalyzing)

  const playSound = useSounds()

  // During an LLM game the board only accepts moves for a human seat, at the
  // latest position, while the game is running.
  const match = useLlmStore((s) => s.match)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const treeNodes = useGameStore((s) => s.treeNodes)
  const rootChildren = useGameStore((s) => s.rootChildren)
  const atTip = (currentNodeId === null ? rootChildren : treeNodes[currentNodeId]?.children ?? []).length === 0
  const boardLocked =
    !!match &&
    match.status !== 'finished' &&
    (match.status !== 'running' || !atTip || seatFor(match, turn).kind !== 'human')

  const toDests = useCallback((): Map<Key, Key[]> => {
    const dests = getAllLegalDests()
    const cgDests = new Map<Key, Key[]>()
    for (const [from, tos] of dests) {
      cgDests.set(from as Key, tos as Key[])
    }
    return cgDests
  }, [getAllLegalDests])

  const onMove = useCallback(
    (orig: Key, dest: Key) => {
      const chess = useGameStore.getState().chess
      const moves = chess.moves({ verbose: true })
      const isPromotion = moves.some(
        (m) => m.from === orig && m.to === dest && m.promotion
      )

      let promotion: string | undefined
      if (isPromotion) {
        promotion = 'q'
      }

      const result = makeMove(orig, dest, promotion)
      if (result) {
        playSound(result)
      }
    },
    [makeMove, playSound]
  )

  // Initialize chessground
  useEffect(() => {
    if (!boardRef.current) return

    const cg = Chessground(boardRef.current, {
      fen,
      orientation,
      turnColor: turn === 'w' ? 'white' : 'black',
      movable: {
        free: false,
        color: turn === 'w' ? 'white' : 'black',
        dests: toDests(),
        showDests: showLegalMoves,
        events: {
          after: onMove
        }
      },
      draggable: {
        enabled: true,
        showGhost: true
      },
      highlight: {
        lastMove: true,
        check: true
      },
      animation: {
        enabled: true,
        duration: 150
      },
      premovable: {
        enabled: false
      },
      drawable: {
        enabled: true,
        visible: true
      },
      coordinates: showCoordinates,
      lastMove: lastMove ? [lastMove.from as Key, lastMove.to as Key] : undefined,
      check: isCheck ? (turn === 'w' ? 'white' : 'black') : undefined
    })

    cgRef.current = cg

    return () => {
      cg.destroy()
      cgRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync state changes to chessground
  useEffect(() => {
    if (!cgRef.current) return

    const turnColor = turn === 'w' ? 'white' : 'black'

    cgRef.current.set({
      fen,
      turnColor,
      movable: {
        free: false,
        color: isGameOver || boardLocked ? undefined : turnColor,
        dests: isGameOver || boardLocked ? new Map() : toDests(),
        showDests: showLegalMoves
      },
      lastMove: lastMove ? [lastMove.from as Key, lastMove.to as Key] : undefined,
      check: isCheck ? turnColor : undefined,
      coordinates: showCoordinates
    })
  }, [fen, turn, isCheck, lastMove, isGameOver, boardLocked, showCoordinates, showLegalMoves, toDests])

  // Sync orientation
  useEffect(() => {
    cgRef.current?.set({ orientation })
  }, [orientation])

  // Re-bind move handler
  useEffect(() => {
    cgRef.current?.set({
      movable: {
        events: {
          after: onMove
        }
      }
    })
  }, [onMove])

  // Draw engine arrows — per engine with distinct colors
  useEffect(() => {
    if (!cgRef.current) return

    if (!showEngineArrows || !isAnalyzing) {
      cgRef.current.setAutoShapes([])
      return
    }

    const shapes: DrawShape[] = []
    const activeEngines = engines.filter((e) => e.isActive)

    for (let eIdx = 0; eIdx < activeEngines.length; eIdx++) {
      const engine = activeEngines[eIdx]
      const result = analysisResults.get(engine.id)
      if (!result || result.lines.length === 0) continue

      // Use engine's assigned brush color
      const globalIdx = engines.indexOf(engine)
      const brush = BRUSH_NAMES[globalIdx % BRUSH_NAMES.length]

      const lines = result.lines.slice(0, 3) // Top 3 lines per engine

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.pvUci.length === 0) continue

        const uci = line.pvUci[0]
        const from = uci.slice(0, 2) as Key
        const to = uci.slice(2, 4) as Key

        // Line width: best=14, 2nd=10, 3rd=6
        const lineWidth = i === 0 ? 14 : i === 1 ? 10 : 6

        shapes.push({
          orig: from,
          dest: to,
          brush,
          modifiers: { lineWidth }
        })
      }
    }

    cgRef.current.setAutoShapes(shapes)
  }, [showEngineArrows, isAnalyzing, engines, analysisResults])

  return (
    <div
      ref={boardRef}
      style={{
        width: 'var(--board-size)',
        height: 'var(--board-size)',
        maxWidth: '100%',
        maxHeight: '100%',
        aspectRatio: '1'
      }}
    />
  )
}
