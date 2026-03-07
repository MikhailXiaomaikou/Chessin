import { useEffect, useCallback, useRef } from 'react'
import { Chess } from 'chess.js'
import { useEngineStore, type PVLine } from '@renderer/stores/engineStore'
import { useGameStore } from '@renderer/stores/gameStore'

// Convert UCI moves (e2e4) to SAN (e4) given a starting FEN
function uciToSan(fen: string, uciMoves: string[]): string[] {
  try {
    const chess = new Chess(fen)
    const sanMoves: string[] = []
    for (const uciMove of uciMoves) {
      const from = uciMove.slice(0, 2)
      const to = uciMove.slice(2, 4)
      const promotion = uciMove.length > 4 ? uciMove[4] : undefined
      try {
        const result = chess.move({ from, to, promotion })
        sanMoves.push(result.san)
      } catch {
        break // Invalid move in PV, stop
      }
    }
    return sanMoves
  } catch {
    return uciMoves // Fallback to UCI notation
  }
}

export function useEngine() {
  const engines = useEngineStore((s) => s.engines)
  const isAnalyzing = useEngineStore((s) => s.isAnalyzing)
  const setAnalyzing = useEngineStore((s) => s.setAnalyzing)
  const updatePVLine = useEngineStore((s) => s.updatePVLine)
  const updateAnalysis = useEngineStore((s) => s.updateAnalysis)
  const clearAnalysis = useEngineStore((s) => s.clearAnalysis)

  const fen = useGameStore((s) => s.fen)
  const fenRef = useRef(fen)
  fenRef.current = fen

  // Re-initialize persisted engines on app start.
  // The engineStore persists engine entries, but the main process EngineManager
  // is empty after restart — we need to re-spawn the engine processes.
  const initDoneRef = useRef(false)
  useEffect(() => {
    if (initDoneRef.current || !window.electronAPI?.engine) return
    initDoneRef.current = true

    const storedEngines = useEngineStore.getState().engines
    if (storedEngines.length === 0) return

    // Ensure analysis is stopped (stale state from previous session)
    useEngineStore.getState().setAnalyzing(false)

    ;(async () => {
      for (const entry of storedEngines) {
        try {
          const result = await window.electronAPI.engine.add(entry.id, entry.path)
          if (result.success) {
            // Restore settings
            await window.electronAPI.engine.setOption(entry.id, 'MultiPV', entry.multiPv)
            const options = result.options as { name: string }[]
            if (options.some((o) => o.name === 'UCI_ShowWDL')) {
              await window.electronAPI.engine.setOption(entry.id, 'UCI_ShowWDL', true)
            }
          } else {
            // Engine binary no longer available, remove from store
            useEngineStore.getState().removeEngine(entry.id)
          }
        } catch {
          useEngineStore.getState().removeEngine(entry.id)
        }
      }
    })()
  }, [])

  // Subscribe to engine output
  useEffect(() => {
    if (!window.electronAPI?.engine) return

    const cleanup = window.electronAPI.engine.onOutput((data) => {
      if (data.type === 'info' && data.info) {
        const info = data.info as {
          depth: number
          seldepth?: number
          multipv: number
          score: { type: 'cp' | 'mate'; value: number }
          nodes?: number
          nps?: number
          time?: number
          pv: string[]
          wdl?: [number, number, number]
          hashfull?: number
        }

        // Convert PV from UCI to SAN
        const sanMoves = uciToSan(fenRef.current, info.pv)

        // Determine side-to-move from the FEN the engine is analyzing.
        // Convert score & WDL to white's perspective immediately so that
        // display components don't need to flip based on the (possibly
        // already-changed) `turn` value — this prevents the eval bar
        // from briefly showing the wrong direction after a move.
        const analysisTurn = fenRef.current.split(' ')[1] // 'w' or 'b'
        const flipScore = analysisTurn === 'b' ? -1 : 1

        const whiteScore = {
          type: info.score.type,
          value: info.score.value * flipScore
        } as { type: 'cp' | 'mate'; value: number }

        const pvLine: PVLine = {
          multipv: info.multipv,
          score: whiteScore,
          depth: info.depth,
          pv: sanMoves,
          pvUci: info.pv
        }

        updatePVLine(data.engineId, pvLine)

        // Convert WDL to white's perspective too
        const whiteWdl = info.wdl
          ? (analysisTurn === 'b'
            ? [info.wdl[2], info.wdl[1], info.wdl[0]] as [number, number, number]
            : info.wdl)
          : undefined

        // Only update top-level WDL from the best line (multipv=1)
        // to prevent the eval bar from jumping between different lines
        updateAnalysis(data.engineId, {
          depth: info.depth,
          seldepth: info.seldepth,
          nodes: info.nodes,
          nps: info.nps,
          time: info.time,
          hashfull: info.hashfull,
          ...(info.multipv === 1 && whiteWdl ? { wdl: whiteWdl } : {})
        })
      }
    })

    return cleanup
  }, [updatePVLine, updateAnalysis])

  const startAnalysis = useCallback(async () => {
    if (!window.electronAPI?.engine) return

    const activeEngines = engines.filter((e) => e.isActive)
    if (activeEngines.length === 0) return

    for (const engine of activeEngines) {
      // Don't clear old results — keep them visible until new data arrives
      // to prevent the panel from flickering/jumping.
      await window.electronAPI.engine.startAnalysis({
        engineId: engine.id,
        fen: fenRef.current,
        moves: [],
        params: { infinite: true }
      })
    }
    setAnalyzing(true)
  }, [engines, clearAnalysis, setAnalyzing])

  const stopAnalysis = useCallback(async () => {
    if (!window.electronAPI?.engine) return

    const activeEngines = engines.filter((e) => e.isActive)
    for (const engine of activeEngines) {
      await window.electronAPI.engine.stopAnalysis(engine.id)
    }
    setAnalyzing(false)
  }, [engines, setAnalyzing])

  const toggleAnalysis = useCallback(() => {
    if (isAnalyzing) {
      stopAnalysis()
    } else {
      startAnalysis()
    }
  }, [isAnalyzing, startAnalysis, stopAnalysis])

  // Re-analyze when position changes
  useEffect(() => {
    if (!isAnalyzing) return
    // Debounce to avoid rapid re-analysis
    const timeout = setTimeout(() => {
      startAnalysis()
    }, 50)
    return () => clearTimeout(timeout)
  }, [fen, isAnalyzing, startAnalysis])

  const addEngine = useCallback(
    async (path: string) => {
      if (!window.electronAPI?.engine) return null

      const id = `engine_${Date.now()}`
      const result = await window.electronAPI.engine.add(id, path)

      if (result.success) {
        useEngineStore.getState().addEngine({
          id,
          name: result.identity.name,
          path,
          isActive: true,
          multiPv: 3
        })

        // Set MultiPV
        await window.electronAPI.engine.setOption(id, 'MultiPV', 3)

        // Enable WDL output if supported (LC0 and newer Stockfish)
        const options = await window.electronAPI.engine.getOptions(id)
        const hasWdl = (options as { name: string }[]).some(
          (o) => o.name === 'UCI_ShowWDL'
        )
        if (hasWdl) {
          await window.electronAPI.engine.setOption(id, 'UCI_ShowWDL', true)
        }

        return { id, name: result.identity.name }
      }

      return null
    },
    []
  )

  const removeEngine = useCallback(async (id: string) => {
    if (!window.electronAPI?.engine) return
    await window.electronAPI.engine.remove(id)
    useEngineStore.getState().removeEngine(id)
  }, [])

  return {
    engines,
    isAnalyzing,
    startAnalysis,
    stopAnalysis,
    toggleAnalysis,
    addEngine,
    removeEngine
  }
}
