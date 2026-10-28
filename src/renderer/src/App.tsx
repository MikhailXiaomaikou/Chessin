import { useEffect } from 'react'
import MainLayout from '@renderer/layout/MainLayout'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useBookStore } from '@renderer/stores/bookStore'
import type {
  DbGame,
  SearchParams,
  SearchResult,
  PositionStats,
  OpenResult,
  BookMove,
  BookLoadResult,
  BookExportResult
} from '@renderer/database/types'
import type { TbProbeResponse } from '@shared/chess/tablebase'

declare global {
  interface Window {
    electronAPI: {
      platform: string
      file: {
        selectEngine: () => Promise<string | null>
        openPgn: () => Promise<string | null>
        readFile: (filePath: string) => Promise<string | null>
        savePgn: (content: string) => Promise<string | null>
      }
      engine: {
        add: (id: string, path: string) => Promise<{ success: boolean; identity: { name: string; author: string }; options: unknown[] }>
        remove: (engineId: string) => Promise<{ success: boolean }>
        startAnalysis: (params: {
          engineId: string
          fen: string
          moves: string[]
          params: { infinite?: boolean; depth?: number; movetime?: number }
        }) => Promise<{ success: boolean }>
        stopAnalysis: (engineId: string) => Promise<{ success: boolean }>
        setOption: (engineId: string, name: string, value: string | number | boolean) => Promise<{ success: boolean }>
        getOptions: (engineId: string) => Promise<unknown[]>
        onOutput: (callback: (data: {
          engineId: string
          type: 'info' | 'bestmove'
          info?: unknown
          bestmove?: unknown
        }) => void) => () => void
      }
      database: {
        openFileDialog: () => Promise<string | null>
        open: (filePath: string) => Promise<OpenResult>
        search: (params: SearchParams) => Promise<SearchResult>
        getGame: (id: number) => Promise<DbGame | null>
        getOpeningStats: (fen: string) => Promise<PositionStats>
        positionGames: (params: {
          fen: string
          limit?: number
          offset?: number
        }) => Promise<SearchResult>
        addGame: (pgn: string) => Promise<{ success: boolean; id: number; error?: string }>
        deleteGame: (id: number) => Promise<{ success: boolean; error?: string }>
        playerSuggest: (prefix: string) => Promise<string[]>
        onImportProgress: (callback: (data: { count: number }) => void) => () => void
      }
      book: {
        openFileDialog: () => Promise<string | null>
        load: (filePath: string) => Promise<BookLoadResult>
        lookup: (fen: string) => Promise<BookMove[]>
        close: () => Promise<{ success: boolean }>
        exportFromDatabase: (opts?: {
          maxPly?: number
          minGames?: number
          weighting?: 'popularity' | 'score'
        }) => Promise<BookExportResult>
      }
      tablebase: {
        probe: (fen: string) => Promise<TbProbeResponse>
      }
      clipboard: {
        writeText: (text: string) => void
      }
      onMenuEvent: (channel: string, callback: () => void) => () => void
    }
  }
}

export default function App() {
  const flipBoard = useGameStore((s) => s.flipBoard)
  const goToStart = useGameStore((s) => s.goToStart)
  const goBack = useGameStore((s) => s.goBack)
  const goForward = useGameStore((s) => s.goForward)
  const goToEnd = useGameStore((s) => s.goToEnd)
  const newGame = useGameStore((s) => s.newGame)
  const theme = useUIStore((s) => s.theme)

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.className = theme
  }, [theme])

  // Reopen the opening book from the last session, if any.
  useEffect(() => {
    const { path, setLoaded, clear } = useBookStore.getState()
    if (!path || !window.electronAPI?.book) return
    window.electronAPI.book.load(path).then((res) => {
      if (res.success) setLoaded(path, res.name ?? '', res.entries ?? 0)
      else clear()
    })
  }, [])

  // Register menu event handlers
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanups = [
      window.electronAPI.onMenuEvent('menu:flip-board', flipBoard),
      window.electronAPI.onMenuEvent('menu:go-start', goToStart),
      window.electronAPI.onMenuEvent('menu:go-back', goBack),
      window.electronAPI.onMenuEvent('menu:go-forward', goForward),
      window.electronAPI.onMenuEvent('menu:go-end', goToEnd),
      window.electronAPI.onMenuEvent('menu:new-game', () => newGame())
    ]

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [flipBoard, goToStart, goBack, goForward, goToEnd, newGame])

  // Keyboard shortcuts (for when menu accelerators don't work, e.g., in dev mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          goBack()
          break
        case 'ArrowRight':
          e.preventDefault()
          goForward()
          break
        case 'Home':
          e.preventDefault()
          goToStart()
          break
        case 'End':
          e.preventDefault()
          goToEnd()
          break
        case 'f':
          if (!e.ctrlKey && !e.metaKey) {
            flipBoard()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goBack, goForward, goToStart, goToEnd, flipBoard])

  return <MainLayout />
}
