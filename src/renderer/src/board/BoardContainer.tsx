import ChessBoard from './ChessBoard'
import EvalBar from './EvalBar'
import BoardControls from './BoardControls'
import { useUIStore } from '@renderer/stores/uiStore'
import { useEngineStore, ENGINE_COLORS } from '@renderer/stores/engineStore'
export default function BoardContainer() {
  const showEvalBar = useUIStore((s) => s.showEvalBar)
  const engines = useEngineStore((s) => s.engines)
  const analysisResults = useEngineStore((s) => s.analysisResults)

  const activeEngines = engines.filter((e) => e.isActive)

  // Build eval bar data for each active engine
  // Scores are already converted to white's perspective in useEngine.ts
  const evalBars = activeEngines.map((engine) => {
    const result = analysisResults.get(engine.id)
    const score = result?.lines?.[0]?.score ?? null
    const wdl = result?.wdl ?? null
    const color = ENGINE_COLORS[engines.indexOf(engine) % ENGINE_COLORS.length]

    return { engine, score, wdl, color }
  })

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-start gap-1">
        {showEvalBar && evalBars.map((bar) => (
          <EvalBar
            key={bar.engine.id}
            score={bar.score}
            wdl={bar.wdl}
            accentColor={evalBars.length > 1 ? bar.color : undefined}
            compact={evalBars.length > 1}
          />
        ))}
        {showEvalBar && activeEngines.length === 0 && (
          <EvalBar score={null} wdl={null} />
        )}
        <ChessBoard />
      </div>
      <BoardControls />
    </div>
  )
}
