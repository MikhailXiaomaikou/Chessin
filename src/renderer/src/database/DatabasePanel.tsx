import { useState, useCallback, useEffect, useRef } from 'react'
import GameList from './GameList'
import GameFilter from './GameFilter'
import { useGameStore } from '@renderer/stores/gameStore'
import { useDatabaseStore } from '@renderer/stores/databaseStore'
import { useT } from '@renderer/i18n/useI18n'
import type { DbGame, SearchParams } from './types'

const PAGE_SIZE = 100

export default function DatabasePanel() {
  const t = useT()
  const setOpened = useDatabaseStore((s) => s.setOpened)
  const [isOpen, setIsOpen] = useState(false)
  const [games, setGames] = useState<DbGame[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [importCount, setImportCount] = useState<number | null>(null)
  const [dbName, setDbName] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const paramsRef = useRef<SearchParams>({})

  // Forward import progress from the main process.
  useEffect(() => {
    if (!window.electronAPI?.database) return
    return window.electronAPI.database.onImportProgress(({ count }) => setImportCount(count))
  }, [])

  const runSearch = useCallback(async (params: SearchParams, nextPage: number) => {
    if (!window.electronAPI?.database) return
    setLoading(true)
    const res = await window.electronAPI.database.search({
      ...params,
      limit: PAGE_SIZE,
      offset: nextPage * PAGE_SIZE
    })
    setGames(res.games)
    setTotal(res.total)
    setPage(nextPage)
    paramsRef.current = params
    setLoading(false)
  }, [])

  const handleOpenDatabase = useCallback(async () => {
    if (!window.electronAPI?.database) return
    const filePath = await window.electronAPI.database.openFileDialog()
    if (!filePath) return
    setLoading(true)
    setImportCount(0)
    const result = await window.electronAPI.database.open(filePath)
    setImportCount(null)
    if (result.success) {
      setDbName(result.name || filePath.split(/[/\\]/).pop() || filePath)
      setIsOpen(true)
      setOpened(result.name || '', result.count || 0)
      await runSearch({}, 0)
    } else {
      setLoading(false)
      // eslint-disable-next-line no-alert
      alert(result.error || 'Failed to open database')
    }
  }, [runSearch, setOpened])

  const handleSearch = useCallback((params: SearchParams) => runSearch(params, 0), [runSearch])

  const handleSelectGame = useCallback(async (id: number) => {
    if (!window.electronAPI?.database) return
    setSelectedId(id)
    const game = await window.electronAPI.database.getGame(id)
    if (game?.pgn) useGameStore.getState().loadPgn(game.pgn)
  }, [])

  const handleExportBook = useCallback(async () => {
    if (!window.electronAPI?.book) return
    const res = await window.electronAPI.book.exportFromDatabase()
    if (res.success) {
      setNotice(`${t('book.exported')} · ${(res.entries ?? 0).toLocaleString()} ${t('book.entries')}`)
      setTimeout(() => setNotice(''), 4000)
    } else if (!res.canceled) {
      // eslint-disable-next-line no-alert
      alert(res.error || 'Export failed')
    }
  }, [t])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (!isOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        {importCount !== null ? (
          <>
            <p className="text-sm text-gray-400 mb-1">{t('db.importing')}</p>
            <p className="text-xs text-accent tabular-nums">
              {importCount.toLocaleString()} {t('ref.games')}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-3">{t('db.noDatabase')}</p>
            <button
              onClick={handleOpenDatabase}
              className="px-4 py-2 text-xs rounded bg-accent hover:bg-accent-hover text-white font-medium transition-colors"
            >
              {t('db.openDatabase')}
            </button>
            <p className="text-[10px] text-gray-600 mt-2 text-center">
              {t('db.supportedFormats')}
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)]">
        <div className="min-w-0">
          <span className="text-xs font-medium text-gray-300 truncate">{dbName}</span>
          <span className="text-[10px] text-gray-500 ml-2">
            {total.toLocaleString()} {t('ref.games')}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleExportBook}
            className="text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
          >
            {t('book.export')}
          </button>
          <button
            onClick={handleOpenDatabase}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors"
          >
            {t('db.open')}
          </button>
        </div>
      </div>
      {notice && (
        <div className="px-3 py-1 text-[10px] text-accent border-b border-[var(--border-color)]">
          {notice}
        </div>
      )}
      <GameFilter onSearch={handleSearch} />
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs text-gray-500">{t('db.loading')}</span>
        </div>
      ) : (
        <GameList
          games={games}
          onSelectGame={handleSelectGame}
          startIndex={page * PAGE_SIZE}
          selectedId={selectedId}
        />
      )}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-gray-500">
          <button
            disabled={page === 0}
            onClick={() => runSearch(paramsRef.current, page - 1)}
            className="px-2 py-0.5 rounded disabled:opacity-30 hover:text-gray-300 transition-colors"
          >
            ‹ {t('db.prev')}
          </button>
          <span className="tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <button
            disabled={page >= pageCount - 1}
            onClick={() => runSearch(paramsRef.current, page + 1)}
            className="px-2 py-0.5 rounded disabled:opacity-30 hover:text-gray-300 transition-colors"
          >
            {t('db.next')} ›
          </button>
        </div>
      )}
    </div>
  )
}
