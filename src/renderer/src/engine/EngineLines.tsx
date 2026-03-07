import type { PVLine } from '@renderer/stores/engineStore'
import { useT } from '@renderer/i18n/useI18n'

// Scores are already in white's perspective (converted in useEngine.ts)
function formatScore(score: { type: 'cp' | 'mate'; value: number }): string {
  if (score.type === 'mate') {
    const prefix = score.value > 0 ? '+' : '-'
    return `${prefix}M${Math.abs(score.value)}`
  }
  const cp = score.value / 100
  return cp > 0 ? `+${cp.toFixed(2)}` : cp.toFixed(2)
}

function scoreColor(score: { type: 'cp' | 'mate'; value: number }): string {
  if (score.type === 'mate') return score.value > 0 ? 'text-green-400' : 'text-red-400'
  if (score.value > 50) return 'text-green-400'
  if (score.value < -50) return 'text-red-400'
  return 'text-gray-300'
}

interface EngineLinesProps {
  lines: PVLine[]
  onClickLine?: (line: PVLine) => void
}

export default function EngineLines({ lines, onClickLine }: EngineLinesProps) {
  const t = useT()

  if (lines.length === 0) {
    return (
      <div className="text-base text-gray-600 italic px-5 py-3">{t('engine.waiting')}</div>
    )
  }

  return (
    <div className="space-y-1 pb-2">
      {lines.map((line) => (
        <div key={line.multipv}
          className="flex items-start gap-3 px-5 py-1.5 hover:bg-surface-tertiary cursor-pointer text-base"
          onClick={() => onClickLine?.(line)}>
          <span className={`font-bold w-20 shrink-0 text-right font-mono ${scoreColor(line.score)}`}>
            {formatScore(line.score)}
          </span>
          <span className="text-gray-500 w-8 shrink-0">d{line.depth}</span>
          <span className="text-gray-300 font-mono truncate">{line.pv.join(' ')}</span>
        </div>
      ))}
    </div>
  )
}
