import type { DatabaseGame } from './DatabasePanel'
import { useT } from '@renderer/i18n/useI18n'

interface GameListProps {
  games: DatabaseGame[]
  onSelectGame: (index: number) => void
}

export default function GameList({ games, onSelectGame }: GameListProps) {
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
          {games.map((game) => (
            <tr key={game.index} onClick={() => onSelectGame(game.index)}
              className="cursor-pointer hover:bg-surface-tertiary transition-colors border-b border-[var(--border-color)]">
              <td className="px-2 py-1 text-gray-600">{game.index + 1}</td>
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
