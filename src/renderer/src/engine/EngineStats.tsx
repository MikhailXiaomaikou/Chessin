import type { AnalysisResult } from '@renderer/stores/engineStore'
import { useT } from '@renderer/i18n/useI18n'

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface EngineStatsProps {
  result: AnalysisResult
}

export default function EngineStats({ result }: EngineStatsProps) {
  const t = useT()
  return (
    <div className="flex items-center gap-4 text-sm text-gray-500 px-5 py-1">
      <span>{t('stats.depth')}{result.depth}{result.seldepth ? `/${result.seldepth}` : ''}</span>
      {result.nodes !== undefined && <span>{formatNumber(result.nodes)}{t('stats.nodes')}</span>}
      {result.nps !== undefined && <span>{formatNumber(result.nps)}{t('stats.nps')}</span>}
      {result.time !== undefined && <span>{(result.time / 1000).toFixed(1)}s</span>}
      {result.hashfull !== undefined && (
        <span>{t('stats.hash')}{(result.hashfull / 10).toFixed(0)}%</span>
      )}
    </div>
  )
}
