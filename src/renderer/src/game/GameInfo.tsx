import { useMemo } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'
import { lookupOpening, type Opening } from '@renderer/data/openings'
import { DEFAULT_FEN } from '@shared/constants'

export default function GameInfo() {
  const t = useT()
  const locale = useUIStore((s) => s.locale)
  const isCheckmate = useGameStore((s) => s.isCheckmate)
  const isStalemate = useGameStore((s) => s.isStalemate)
  const isDraw = useGameStore((s) => s.isDraw)
  const turn = useGameStore((s) => s.turn)
  const isCheck = useGameStore((s) => s.isCheck)
  const moveHistory = useGameStore((s) => s.moveHistory)
  const currentMoveIndex = useGameStore((s) => s.currentMoveIndex)
  const headers = useGameStore((s) => s.headers)

  // PGN marks unknown values with "?" (e.g. "????.??.??").
  const tag = (key: string): string => {
    const value = headers[key]?.trim() ?? ''
    return /^[?.*\s-]*$/.test(value) ? '' : value
  }
  const player = (name: string, elo: string) => (elo && elo !== '0' ? `${name} (${elo})` : name)
  const white = tag('White')
  const black = tag('Black')
  const players =
    white || black
      ? `${player(white || '?', tag('WhiteElo'))} – ${player(black || '?', tag('BlackElo'))}`
      : ''
  const round = tag('Round')
  const details = [
    tag('Event'),
    tag('Site'),
    tag('Date').replace(/\.\?\?/g, ''),
    round ? `${t('game.round')} ${round}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  // Scan all positions from the start up to the current move index.
  // Return the deepest (most specific) opening match found.
  // Each node in moveHistory stores its FEN directly, so we can look up openings
  // without replaying moves.
  const opening = useMemo<Opening | null>(() => {
    let best = lookupOpening(DEFAULT_FEN)

    if (moveHistory.length === 0) return best

    const limit = Math.min(currentMoveIndex, moveHistory.length - 1, 30)

    for (let i = 0; i <= limit; i++) {
      const match = lookupOpening(moveHistory[i].fen)
      if (match) {
        best = match
      }
    }

    return best
  }, [moveHistory, currentMoveIndex])

  let status = ''
  if (isCheckmate) {
    status = turn === 'w' ? t('game.checkmateBlackWins') : t('game.checkmateWhiteWins')
  } else if (isStalemate) {
    status = t('game.stalemate')
  } else if (isDraw) {
    status = t('game.draw')
  } else if (isCheck) {
    status = turn === 'w' ? t('game.whiteInCheck') : t('game.blackInCheck')
  }

  return (
    <div className="px-5 py-3 border-b border-[var(--border-color)]">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-200">{t('game.moves')}</h2>
        <span className="text-sm text-gray-500">
          {moveHistory.length > 0
            ? `${t('game.move')}${Math.ceil(moveHistory.length / 2)}`
            : t('game.ready')}
        </span>
      </div>
      {players && (
        <div className="mt-1 text-sm text-gray-300 truncate" title={players}>
          {players}
          {tag('Result') && <span className="ml-2 text-gray-500">{tag('Result')}</span>}
        </div>
      )}
      {details && (
        <div className="text-xs text-gray-500 truncate" title={details}>
          {details}
        </div>
      )}
      {opening && opening.eco !== 'A00' && (
        <div className="mt-1 text-sm text-accent">
          <span className="text-gray-500 mr-1">{opening.eco}</span>
          {locale === 'zh' ? opening.nameZh : opening.name}
        </div>
      )}
      {status && (
        <div className="mt-1 text-sm font-medium text-yellow-400">{status}</div>
      )}
    </div>
  )
}
