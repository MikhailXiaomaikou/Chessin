import { useState, useCallback } from 'react'
import GameList from './GameList'
import GameFilter from './GameFilter'
import { useGameStore } from '@renderer/stores/gameStore'
import { useT } from '@renderer/i18n/useI18n'

export interface DatabaseGame {
  index: number
  white: string
  black: string
  result: string
  date: string
  event?: string
  eco?: string
  whiteElo?: string
  blackElo?: string
  pgn?: string
}

interface SearchParams {
  white?: string
  black?: string
  result?: string
  eco?: string
}

export default function DatabasePanel() {
  const t = useT()
  const [isOpen, setIsOpen] = useState(false)
  const [games, setGames] = useState<DatabaseGame[]>([])
  const [gameCount, setGameCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [dbName, setDbName] = useState('')

  const handleOpenDatabase = useCallback(async () => {
    if (!window.electronAPI?.database) return
    const filePath = await window.electronAPI.database.openFileDialog()
    if (!filePath) return
    setLoading(true)
    const result = await window.electronAPI.database.open(filePath)
    if (result.success) {
      setGameCount(result.count)
      setDbName(filePath.split('/').pop() || filePath)
      setIsOpen(true)
      const initial = await window.electronAPI.database.search({ limit: 100 })
      setGames(initial)
    }
    setLoading(false)
  }, [])

  const handleSearch = useCallback(async (params: SearchParams) => {
    if (!window.electronAPI?.database) return
    setLoading(true)
    const results = await window.electronAPI.database.search({ ...params, limit: 100 })
    setGames(results)
    setLoading(false)
  }, [])

  const handleSelectGame = useCallback(async (index: number) => {
    if (!window.electronAPI?.database) return
    const game = await window.electronAPI.database.getGame(index)
    if (game?.pgn) {
      useGameStore.getState().loadPgn(game.pgn)
    }
  }, [])

  if (!isOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <p className="text-sm text-gray-500 mb-3">{t('db.noDatabase')}</p>
        <button onClick={handleOpenDatabase}
          className="px-4 py-2 text-xs rounded bg-accent hover:bg-accent-hover text-white font-medium transition-colors">
          {t('db.openDatabase')}
        </button>
        <p className="text-[10px] text-gray-600 mt-2 text-center">{t('db.supportedFormats')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)]">
        <div>
          <span className="text-xs font-medium text-gray-300">{dbName}</span>
          <span className="text-[10px] text-gray-500 ml-2">{gameCount} games</span>
        </div>
        <button onClick={handleOpenDatabase}
          className="text-[10px] text-accent hover:text-accent-hover transition-colors">
          {t('db.open')}
        </button>
      </div>
      <GameFilter onSearch={handleSearch} />
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs text-gray-500">{t('db.loading')}</span>
        </div>
      ) : (
        <GameList games={games} onSelectGame={handleSelectGame} />
      )}
    </div>
  )
}
