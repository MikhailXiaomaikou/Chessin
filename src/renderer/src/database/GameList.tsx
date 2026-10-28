import type { DbGame } from './types'
import { useT } from '@renderer/i18n/useI18n'

interface GameListProps {
  games: DbGame[]
  onSelectGame: (id: number) => void
  /** Row number of the first game (for paginated displays). */
  startIndex?: number
  selectedId?: number | null
}

export default function GameList({
  games,
  onSelectGame,
  startIndex = 0,
  selectedId = null
}: GameListProps) {
  const t = useT()

  if (games.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-gray-600">{t('db.noGames')}</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 bg-surface-secondary">
          <tr className="text-gray-500 text-left">
            <th className="px-2 py-1 font-medium">{t('db.headerNum')}</th>
            <th className="px-2 py-1 font-medium">{t('db.headerWhite')}</th>
            <th className="px-2 py-1 font-medium">{t('db.headerBlack')}</th>
            <th className="px-2 py-1 font-medium">{t('db.headerResult')}</th>
            <th className="px-2 py-1 font-medium">{t('db.headerEco')}</th>
            <th className="px-2 py-1 font-medium">{t('db.headerDate')}</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game, i) => (
            <tr
              key={game.id}
              onClick={() => onSelectGame(game.id)}
              className={`cursor-pointer transition-colors border-b border-[var(--border-color)] ${
                game.id === selectedId ? 'bg-surface-tertiary' : 'hover:bg-surface-tertiary'
              }`}
            >
              <td className="px-2 py-1 text-gray-600">{startIndex + i + 1}</td>
              <td className="px-2 py-1 text-gray-200">
                {game.white}
                {game.whiteElo && <span className="text-gray-500 ml-1">({game.whiteElo})</span>}
              </td>
              <td className="px-2 py-1 text-gray-200">
                {game.black}
                {game.blackElo && <span className="text-gray-500 ml-1">({game.blackElo})</span>}
              </td>
              <td className="px-2 py-1 text-gray-400">{game.result}</td>
              <td className="px-2 py-1 text-gray-500">{game.eco || '-'}</td>
              <td className="px-2 py-1 text-gray-500">{game.date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
