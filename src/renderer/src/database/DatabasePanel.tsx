import { useState, useCallback, useEffect } from 'react'
import GameList from './GameList'
import GameFilter from './GameFilter'
import { useGameStore } from '@renderer/stores/gameStore'
import { useDatabaseStore } from '@renderer/stores/databaseStore'
import { useT } from '@renderer/i18n/useI18n'
import type { TranslationKey } from '@renderer/i18n/locales'
import type { DbGame, SearchParams } from './types'

const PAGE_SIZE = 100

export default function DatabasePanel() {
  const t = useT()
  // What is open, and the list's filter, page and selection, outlive this panel:
  // switching tabs unmounts it.
  const dbName = useDatabaseStore((s) => s.name)
  const epoch = useDatabaseStore((s) => s.epoch)
  const importing = useDatabaseStore((s) => s.importing)
  const setImporting = useDatabaseStore((s) => s.setImporting)
  const query = useDatabaseStore((s) => s.query)
  const page = useDatabaseStore((s) => s.page)
  const selectedId = useDatabaseStore((s) => s.selectedId)
  const setOpened = useDatabaseStore((s) => s.setOpened)
  const setQuery = useDatabaseStore((s) => s.setQuery)
  const setSelectedId = useDatabaseStore((s) => s.setSelectedId)
  const isOpen = dbName !== ''
  const [games, setGames] = useState<DbGame[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [importCount, setImportCount] = useState(0)
  const [notice, setNotice] = useState('')

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
    setQuery(params, nextPage)
    setLoading(false)
  }, [setQuery])

  // List the open database: when one is opened, and as it was left when
  // coming back to this tab.
  useEffect(() => {
    const { name, query: q, page: p } = useDatabaseStore.getState()
    if (name) runSearch(q, p)
  }, [epoch, runSearch])

  const handleOpenDatabase = useCallback(async () => {
    if (!window.electronAPI?.database) return
    const filePath = await window.electronAPI.database.openFileDialog()
    if (!filePath) return
    setLoading(true)
    setImportCount(0)
    setImporting(true)
    const result = await window.electronAPI.database.open(filePath)
    setImporting(false)
    if (result.success) {
      setOpened(result.name || filePath.split(/[/\\]/).pop() || filePath, result.count || 0)
      // Say what a ChessBase import left out, so a lower count isn't a mystery.
      const skipped = Object.entries(result.skipped ?? {}).filter(([, n]) => (n ?? 0) > 0)
      if (skipped.length) {
        const total = skipped.reduce((sum, [, n]) => sum + (n ?? 0), 0)
        const parts = skipped.map(([reason, n]) => `${t(`db.skip.${reason}` as TranslationKey)} ${n}`)
        setNotice(`${t('db.skipped')} ${total.toLocaleString()}: ${parts.join(' · ')}`)
        setTimeout(() => setNotice(''), 10000)
      }
    } else {
      setLoading(false)
      // eslint-disable-next-line no-alert
      alert(result.error || 'Failed to open database')
    }
  }, [setImporting, setOpened, t])

  const handleSearch = useCallback((params: SearchParams) => runSearch(params, 0), [runSearch])

  const handleSelectGame = useCallback(async (id: number) => {
    if (!window.electronAPI?.database) return
    setSelectedId(id)
    const game = await window.electronAPI.database.getGame(id)
    if (game?.pgn) useGameStore.getState().loadPgn(game.pgn)
  }, [setSelectedId])

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
        {importing ? (
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
              {t(window.electronAPI?.platform === 'web' ? 'db.supportedFormatsWeb' : 'db.supportedFormats')}
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
      {/* A new database starts with an empty filter. */}
      <GameFilter key={epoch} onSearch={handleSearch} initial={query} />
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
            onClick={() => runSearch(query, page - 1)}
            className="px-2 py-0.5 rounded disabled:opacity-30 hover:text-gray-300 transition-colors"
          >
            ‹ {t('db.prev')}
          </button>
          <span className="tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <button
            disabled={page >= pageCount - 1}
            onClick={() => runSearch(query, page + 1)}
            className="px-2 py-0.5 rounded disabled:opacity-30 hover:text-gray-300 transition-colors"
          >
            {t('db.next')} ›
          </button>
        </div>
      )}
    </div>
  )
}
