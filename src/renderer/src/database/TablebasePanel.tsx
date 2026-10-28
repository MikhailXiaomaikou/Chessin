import { useEffect, useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'
import type { TranslationKey } from '@renderer/i18n/locales'
import {
  isTablebasePosition,
  outcomeOf,
  type TbCategory,
  type TbOutcome,
  type TbProbeResponse,
  type TbResult
} from '@shared/chess/tablebase'

const OUTCOME_COLOR: Record<TbOutcome, string> = {
  win: 'text-green-400',
  draw: 'text-gray-300',
  loss: 'text-red-400',
  unknown: 'text-gray-500'
}

const CATEGORY_LABEL: Record<TbCategory, TranslationKey> = {
  win: 'tb.win',
  'syzygy-win': 'tb.win',
  'maybe-win': 'tb.maybeWin',
  'cursed-win': 'tb.cursedWin',
  draw: 'tb.drawShort',
  'blessed-loss': 'tb.blessedLoss',
  'maybe-loss': 'tb.maybeLoss',
  'syzygy-loss': 'tb.loss',
  loss: 'tb.loss',
  unknown: 'tb.unknownShort'
}

function distance(dtm: number | null, dtz: number | null): string {
  if (dtm != null && dtm !== 0) return `DTM ${Math.abs(dtm)}`
  if (dtz != null && dtz !== 0) return `DTZ ${Math.abs(dtz)}`
  return ''
}

function verdictKey(r: TbResult, turn: 'w' | 'b'): TranslationKey {
  if (r.checkmate) return 'tb.checkmate'
  if (r.stalemate) return 'tb.stalemate'
  if (r.category === 'cursed-win' || r.category === 'blessed-loss') return 'tb.drawn50'
  const outcome = outcomeOf(r.category)
  if (outcome === 'win') return turn === 'w' ? 'tb.whiteWins' : 'tb.blackWins'
  if (outcome === 'loss') return turn === 'w' ? 'tb.blackWins' : 'tb.whiteWins'
  return outcome === 'draw' ? 'tb.draw' : 'tb.unknownShort'
}

/** Perfect-play verdict and moves for endgames with 7 or fewer pieces. */
export default function TablebasePanel() {
  const t = useT()
  const fen = useGameStore((s) => s.fen)
  const enabled = useUIStore((s) => s.tablebaseEnabled)
  const toggle = useUIStore((s) => s.toggleTablebase)
  const [answer, setAnswer] = useState<{ fen: string; res: TbProbeResponse } | null>(null)
  const eligible = isTablebasePosition(fen)

  useEffect(() => {
    if (!eligible || !enabled || !window.electronAPI?.tablebase) return
    let cancelled = false
    // Let the position settle so stepping through a game doesn't flood the service.
    const handle = setTimeout(async () => {
      const res = await window.electronAPI.tablebase.probe(fen)
      if (!cancelled) setAnswer({ fen, res })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [fen, eligible, enabled])

  if (!eligible) return null

  const playMove = (uci: string) => {
    useGameStore.getState().makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4])
  }
  const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w'

  let body: React.ReactNode = null
  if (!enabled) {
    body = <p className="px-3 pb-2 text-[10px] text-gray-600">{t('tb.off')}</p>
  } else if (!answer || answer.fen !== fen) {
    body = <p className="px-3 pb-2 text-[10px] text-gray-600">{t('tb.loading')}</p>
  } else if (!answer.res.ok) {
    body = (
      <p className="px-3 pb-2 text-[10px] text-gray-500">
        {t(answer.res.error === 'rate-limited' ? 'tb.rateLimited' : 'tb.unavailable')}
      </p>
    )
  } else if (answer.res.result) {
    const r = answer.res.result
    body = (
      <>
        <div className="px-3 pb-1 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-gray-100">{t(verdictKey(r, turn))}</span>
          <span className="text-[10px] text-gray-500 tabular-nums">{distance(r.dtm, r.dtz)}</span>
        </div>
        {r.moves.length > 0 && (
          <div className="max-h-40 overflow-y-auto pb-1">
            <table className="w-full text-[11px]">
              <tbody>
                {r.moves.map((m) => {
                  const color = OUTCOME_COLOR[outcomeOf(m.category)]
                  return (
                    <tr
                      key={m.uci}
                      onClick={() => playMove(m.uci)}
                      className="cursor-pointer hover:bg-surface-tertiary transition-colors"
                    >
                      <td className={`px-3 py-0.5 font-semibold w-16 ${color}`}>{m.san}</td>
                      <td className={`px-2 py-0.5 ${color}`}>
                        {m.checkmate ? t('tb.checkmate') : t(CATEGORY_LABEL[m.category])}
                      </td>
                      <td className="px-3 py-0.5 text-right text-gray-500 tabular-nums">
                        {distance(m.dtm, m.dtz)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="border-b border-[var(--border-color)] shrink-0">
      <div className="flex items-center justify-between px-3 py-1.5 gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-xs font-medium text-gray-300">{t('tb.title')}</span>
          <span className="text-[10px] text-gray-600 truncate">{t('tb.source')}</span>
        </div>
        <button
          onClick={toggle}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors shrink-0"
        >
          {enabled ? t('tb.disable') : t('tb.enable')}
        </button>
      </div>
      {body}
    </div>
  )
}
