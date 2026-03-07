import { useT } from '@renderer/i18n/useI18n'

interface WdlBarProps {
  wdl: [number, number, number]
}

export default function WdlBar({ wdl }: WdlBarProps) {
  const t = useT()
  const total = wdl[0] + wdl[1] + wdl[2]
  if (total === 0) return null

  const winPct = (wdl[0] / total) * 100
  const drawPct = (wdl[1] / total) * 100
  const lossPct = (wdl[2] / total) * 100

  return (
    <div className="px-5 py-1.5">
      <div className="flex h-5 rounded overflow-hidden text-xs font-bold leading-5">
        <div className="bg-white text-black flex items-center justify-center transition-all duration-500"
          style={{ width: `${winPct}%` }}>
          {winPct >= 10 && `${winPct.toFixed(0)}%`}
        </div>
        <div className="bg-gray-500 text-white flex items-center justify-center transition-all duration-500"
          style={{ width: `${drawPct}%` }}>
          {drawPct >= 10 && `${drawPct.toFixed(0)}%`}
        </div>
        <div className="bg-gray-900 text-white flex items-center justify-center transition-all duration-500"
          style={{ width: `${lossPct}%` }}>
          {lossPct >= 10 && `${lossPct.toFixed(0)}%`}
        </div>
      </div>
      <div className="flex justify-between text-sm text-gray-500 mt-1">
        <span>{t('wdl.win')}{(wdl[0] / 10).toFixed(1)}%</span>
        <span>{t('wdl.draw')}{(wdl[1] / 10).toFixed(1)}%</span>
        <span>{t('wdl.loss')}{(wdl[2] / 10).toFixed(1)}%</span>
      </div>
    </div>
  )
}
