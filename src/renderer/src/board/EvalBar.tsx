import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'

interface EvalBarProps {
  score?: { type: 'cp' | 'mate'; value: number } | null
  wdl?: [number, number, number] | null
  accentColor?: string // For multi-engine: small color indicator
  compact?: boolean
}

function cpToPercent(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') return score.value > 0 ? 100 : 0
  return 50 + 50 * (2 / (1 + Math.exp(-0.004 * score.value)) - 1)
}

function wdlToPercent(wdl: [number, number, number]): number {
  const total = wdl[0] + wdl[1] + wdl[2]
  if (total === 0) return 50
  return ((wdl[0] + wdl[1] / 2) / total) * 100
}

function formatCpScore(score: { type: 'cp' | 'mate'; value: number }): string {
  if (score.type === 'mate') return `M${Math.abs(score.value)}`
  const cp = score.value / 100
  return cp > 0 ? `+${cp.toFixed(1)}` : cp.toFixed(1)
}

function formatWdlLabel(wdl: [number, number, number]): string {
  const total = wdl[0] + wdl[1] + wdl[2]
  if (total === 0) return '50%'
  const winPct = (wdl[0] / total) * 100
  const lossPct = (wdl[2] / total) * 100
  return winPct >= lossPct ? `${winPct.toFixed(0)}%` : `${lossPct.toFixed(0)}%`
}

function EvalModeBar({ score, orientation }: { score: { type: 'cp' | 'mate'; value: number }; orientation: 'white' | 'black' }) {
  const whitePercent = cpToPercent(score)
  const displayPercent = orientation === 'white' ? whitePercent : 100 - whitePercent
  return (
    <div className="relative flex flex-col w-full h-full">
      <div className="absolute left-0 right-0 z-10 text-center text-[10px] font-bold"
        style={{ top: displayPercent < 50 ? '4px' : undefined, bottom: displayPercent >= 50 ? '4px' : undefined, color: displayPercent >= 50 ? '#333' : '#fff' }}>
        {formatCpScore(score)}
      </div>
      <div className="transition-all duration-500 ease-out" style={{ height: `${100 - displayPercent}%`, backgroundColor: '#333333', borderTopLeftRadius: '4px', borderTopRightRadius: '4px' }} />
      <div className="transition-all duration-500 ease-out" style={{ height: `${displayPercent}%`, backgroundColor: '#ffffff', borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px' }} />
    </div>
  )
}

function WdlModeBar({ wdl, score, orientation }: { wdl: [number, number, number]; score?: { type: 'cp' | 'mate'; value: number } | null; orientation: 'white' | 'black' }) {
  const total = wdl[0] + wdl[1] + wdl[2]
  if (total === 0) return null
  const winPct = (wdl[0] / total) * 100
  const drawPct = (wdl[1] / total) * 100
  const lossPct = (wdl[2] / total) * 100
  const topPct = orientation === 'white' ? lossPct : winPct
  const midPct = drawPct
  const botPct = orientation === 'white' ? winPct : lossPct
  const whitePercent = wdlToPercent(wdl)
  const displayPercent = orientation === 'white' ? whitePercent : 100 - whitePercent
  return (
    <div className="relative flex flex-col w-full h-full">
      <div className="absolute left-0 right-0 z-10 text-center text-[10px] font-bold"
        style={{ top: displayPercent < 50 ? '4px' : undefined, bottom: displayPercent >= 50 ? '4px' : undefined, color: displayPercent >= 50 ? '#333' : '#fff' }}>
        {score?.type === 'mate' ? formatCpScore(score) : formatWdlLabel(wdl)}
      </div>
      <div className="transition-all duration-500 ease-out" style={{ height: `${topPct}%`, backgroundColor: '#333333', borderTopLeftRadius: '4px', borderTopRightRadius: '4px' }} />
      <div className="transition-all duration-500 ease-out" style={{ height: `${midPct}%`, backgroundColor: '#888888' }} />
      <div className="transition-all duration-500 ease-out" style={{ height: `${botPct}%`, backgroundColor: '#ffffff', borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px' }} />
    </div>
  )
}

export default function EvalBar({ score, wdl, accentColor, compact }: EvalBarProps) {
  const t = useT()
  const orientation = useGameStore((s) => s.orientation)
  const evalBarMode = useUIStore((s) => s.evalBarMode)
  const setEvalBarMode = useUIStore((s) => s.setEvalBarMode)

  const barWidth = compact ? 24 : 36

  return (
    <div className="flex flex-col items-center gap-1 select-none" style={{ height: 'var(--board-size)', maxHeight: '100%' }}>
      {/* Engine color indicator for multi-engine */}
      {accentColor && (
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
      )}
      <div
        className="relative flex flex-col overflow-hidden cursor-pointer"
        style={{ width: `${barWidth}px`, flex: 1 }}
        onClick={() => setEvalBarMode(evalBarMode === 'eval' ? 'wdl' : 'eval')}
        title={evalBarMode === 'eval' ? t('eval.switchToWdl') : t('eval.switchToEval')}
      >
        {evalBarMode === 'wdl' && wdl ? (
          <WdlModeBar wdl={wdl} score={score} orientation={orientation} />
        ) : score ? (
          <EvalModeBar score={score} orientation={orientation} />
        ) : (
          <div className="flex flex-col w-full h-full">
            <div style={{ height: '50%', backgroundColor: '#333333', borderTopLeftRadius: '4px', borderTopRightRadius: '4px' }} />
            <div style={{ height: '50%', backgroundColor: '#ffffff', borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px' }} />
          </div>
        )}
      </div>
      {!compact && (
        <div className="text-[10px] text-gray-500 leading-none">
          {evalBarMode === 'wdl' ? t('eval.wdl') : t('eval.eval')}
        </div>
      )}
    </div>
  )
}
