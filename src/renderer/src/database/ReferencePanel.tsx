import { useEffect, useState } from 'react'
import { Chess } from 'chess.js'
import { useGameStore } from '@renderer/stores/gameStore'
import { useDatabaseStore } from '@renderer/stores/databaseStore'
import { useT } from '@renderer/i18n/useI18n'
import BookPanel from './BookPanel'
import TablebasePanel from './TablebasePanel'
import type { DbGame, PositionStats } from './types'

const EMPTY: PositionStats = { total: 0, whiteWins: 0, draws: 0, blackWins: 0, moves: [] }

/** A stacked White / Draw / Black result bar. */
function WdlBar({
  white,
  draw,
  black
}: {
  white: number
  draw: number
  black: number
}) {
  const total = white + draw + black
  if (total === 0) return <div className="h-2 rounded bg-surface-tertiary" />
  const w = (white / total) * 100
  const d = (draw / total) * 100
  const b = (black / total) * 100
  return (
    <div
      className="flex h-2 rounded overflow-hidden"
      title={`${white} / ${draw} / ${black}`}
    >
      <div style={{ width: `${w}%` }} className="bg-gray-100" />
      <div style={{ width: `${d}%` }} className="bg-gray-500" />
      <div style={{ width: `${b}%` }} className="bg-gray-800" />
    </div>
  )
}

export default function ReferencePanel() {
  const t = useT()
  const fen = useGameStore((s) => s.fen)
  const epoch = useDatabaseStore((s) => s.epoch)
  const dbName = useDatabaseStore((s) => s.name)
  const [stats, setStats] = useState<PositionStats>(EMPTY)
  const [games, setGames] = useState<DbGame[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!window.electronAPI?.database) return
    let cancelled = false
    setLoading(true)
    const handle = setTimeout(async () => {
      try {
        const [s, g] = await Promise.all([
          window.electronAPI.database.getOpeningStats(fen),
          window.electronAPI.database.positionGames({ fen, limit: 25 })
        ])
        if (cancelled) return
        setStats(s ?? EMPTY)
        setGames(g?.games ?? [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [fen, epoch])

  const playMove = (san: string) => {
    try {
      const chess = new Chess(fen)
      const mv = chess.moves({ verbose: true }).find((m) => m.san === san)
      if (mv) useGameStore.getState().makeMove(mv.from, mv.to, mv.promotion)
    } catch {
      // ignore — invalid position
    }
  }

  const loadGame = async (id: number) => {
    const game = await window.electronAPI.database.getGame(id)
    if (game?.pgn) useGameStore.getState().loadPgn(game.pgn)
  }

  if (!dbName) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <BookPanel />
        <TablebasePanel />
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-sm text-gray-500 text-center">{t('ref.noDatabase')}</p>
        </div>
      </div>
    )
  }

  const totalScore =
    stats.whiteWins + stats.draws + stats.blackWins > 0
      ? ((stats.whiteWins + stats.draws / 2) /
          (stats.whiteWins + stats.draws + stats.blackWins)) *
        100
      : 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BookPanel />
      <TablebasePanel />
      <div className="px-3 py-2 border-b border-[var(--border-color)] shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-300">{t('ref.title')}</span>
          <span className="text-[10px] text-gray-500">
            {stats.total.toLocaleString()} {t('ref.games')}
          </span>
        </div>
        {stats.total > 0 && (
          <div className="mt-1 flex items-center gap-2">
            <div className="flex-1">
              <WdlBar white={stats.whiteWins} draw={stats.draws} black={stats.blackWins} />
            </div>
            <span className="text-[10px] text-gray-500 tabular-nums">
              {totalScore.toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {stats.moves.length === 0 ? (
          <div className="flex items-center justify-center h-24">
            <span className="text-xs text-gray-600">
              {loading ? t('db.loading') : t('ref.noMoves')}
            </span>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-secondary">
              <tr className="text-gray-500 text-left">
                <th className="px-2 py-1 font-medium">{t('ref.move')}</th>
                <th className="px-2 py-1 font-medium text-right">{t('ref.count')}</th>
                <th className="px-2 py-1 font-medium w-[40%]">{t('ref.results')}</th>
              </tr>
            </thead>
            <tbody>
              {stats.moves.map((m) => {
                const pct = stats.total ? (m.count / stats.total) * 100 : 0
                return (
                  <tr
                    key={m.move}
                    onClick={() => playMove(m.move)}
                    className="cursor-pointer hover:bg-surface-tertiary transition-colors border-b border-[var(--border-color)]"
                  >
                    <td className="px-2 py-1 font-semibold text-accent">{m.move}</td>
                    <td className="px-2 py-1 text-right text-gray-400 tabular-nums">
                      {m.count.toLocaleString()}
                      <span className="text-gray-600 ml-1">{pct.toFixed(0)}%</span>
                    </td>
                    <td className="px-2 py-1">
                      <WdlBar white={m.whiteWins} draw={m.draws} black={m.blackWins} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {games.length > 0 && (
          <div className="border-t border-[var(--border-color)] mt-1">
            <div className="px-2 py-1 text-[10px] text-gray-500 uppercase tracking-wide">
              {t('ref.gamesAtPosition')}
            </div>
            <table className="w-full text-[10px]">
              <tbody>
                {games.map((g) => (
                  <tr
                    key={g.id}
                    onClick={() => loadGame(g.id)}
                    className="cursor-pointer hover:bg-surface-tertiary transition-colors border-b border-[var(--border-color)]"
                  >
                    <td className="px-2 py-1 text-gray-300 truncate max-w-[120px]">{g.white}</td>
                    <td className="px-2 py-1 text-gray-300 truncate max-w-[120px]">{g.black}</td>
                    <td className="px-2 py-1 text-gray-500">{g.result}</td>
                    <td className="px-2 py-1 text-gray-600">{g.date.slice(0, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
