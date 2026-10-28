import { useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useEngine } from '@renderer/engine/hooks/useEngine'
import { useAnalysisStore } from '@renderer/stores/analysisStore'
import { useGameAnalysis } from '@renderer/analysis/useGameAnalysis'
import { useT } from '@renderer/i18n/useI18n'
import NewGameDialog from './NewGameDialog'

export default function GameControls() {
  const t = useT()
  const locale = useUIStore((s) => s.locale)
  const setLocale = useUIStore((s) => s.setLocale)
  const [showNewGame, setShowNewGame] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const { isAnalyzing, toggleAnalysis, engines } = useEngine()
  const { analyzeGame, stopAnalysis: stopGameAnalysis } = useGameAnalysis()
  const isAnalyzingGame = useAnalysisStore((s) => s.isAnalyzingGame)
  const getPgn = useGameStore((s) => s.getPgn)
  const loadPgn = useGameStore((s) => s.loadPgn)
  const newGame = useGameStore((s) => s.newGame)
  const moveHistory = useGameStore((s) => s.moveHistory)

  const showCopied = (label: string) => {
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const handleCopyPgn = () => {
    const pgn = getPgn()
    window.electronAPI.clipboard.writeText(pgn)
    showCopied('PGN')
  }

  const handleCopyFen = () => {
    const fen = useGameStore.getState().fen
    window.electronAPI.clipboard.writeText(fen)
    showCopied('FEN')
  }

  const handleSave = async () => {
    const pgn = getPgn()
    const result = await window.electronAPI.file.savePgn(pgn)
    if (result) {
      showCopied(t('game.saved'))
    }
  }

  const handleAnalyzeGame = () => {
    if (isAnalyzingGame) {
      stopGameAnalysis()
    } else {
      analyzeGame(18)
    }
  }

  const hasEngines = engines.length > 0
  const hasMoves = moveHistory.length > 0

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-color)] relative flex-wrap">
        <button
          onClick={() => setShowNewGame(true)}
          className="px-5 py-2 text-base rounded-md bg-accent hover:bg-accent-hover text-white font-medium transition-colors"
        >
          {t('game.new')}
        </button>
        {hasEngines && hasMoves && (
          <button
            onClick={handleAnalyzeGame}
            className={`px-5 py-2 text-base rounded-md font-medium transition-colors ${
              isAnalyzingGame
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-surface-tertiary hover:bg-surface-hover text-gray-300'
            }`}
          >
            {isAnalyzingGame ? t('analysis.stop') : t('analysis.analyzeGame')}
          </button>
        )}
        <button
          onClick={() => setShowImport(true)}
          className="px-4 py-2 text-base rounded-md text-gray-400 hover:text-gray-200 hover:bg-surface-tertiary transition-colors"
        >
          {t('game.import')}
        </button>
        <button
          onClick={handleSave}
          className="px-4 py-2 text-base rounded-md text-gray-400 hover:text-gray-200 hover:bg-surface-tertiary transition-colors"
          title={t('game.savePgn')}
        >
          {t('game.save')}
        </button>
        <div className="flex-1" />
        <button
          onClick={handleCopyFen}
          className="px-3 py-1.5 text-sm rounded-md text-gray-500 hover:text-gray-300 hover:bg-surface-tertiary transition-colors"
          title={t('game.copyFen')}
        >
          FEN
        </button>
        <button
          onClick={handleCopyPgn}
          className="px-3 py-1.5 text-sm rounded-md text-gray-500 hover:text-gray-300 hover:bg-surface-tertiary transition-colors"
          title={t('game.copyPgn')}
        >
          PGN
        </button>
        <button
          onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          className="px-3 py-1.5 text-sm rounded-md text-gray-500 hover:text-gray-300 hover:bg-surface-tertiary transition-colors font-medium"
          title="Switch language / 切换语言"
        >
          {locale === 'zh' ? 'EN' : '中文'}
        </button>

        {/* Copy toast */}
        {copied && (
          <div className="absolute right-4 -bottom-8 bg-accent text-white text-sm px-3 py-1 rounded shadow-lg z-50 animate-pulse">
            {copied === t('game.saved') ? copied : `${copied} ${locale === 'zh' ? '已复制' : 'copied'}`}
          </div>
        )}
      </div>

      {showNewGame && <NewGameDialog onClose={() => setShowNewGame(false)} />}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onImportPgn={(pgn) => {
            if (!loadPgn(pgn)) return false
            setShowImport(false)
            return true
          }}
          onImportFen={(fen) => {
            newGame(fen)
            setShowImport(false)
          }}
        />
      )}
    </>
  )
}

function ImportDialog({
  onClose,
  onImportPgn,
  onImportFen
}: {
  onClose: () => void
  /** Returns false if the PGN held no game. */
  onImportPgn: (pgn: string) => boolean
  onImportFen: (fen: string) => void
}) {
  const t = useT()
  const [mode, setMode] = useState<'pgn' | 'fen'>('pgn')
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed) return

    if (mode === 'fen') {
      // Basic FEN validation
      const parts = trimmed.split(' ')
      if (parts.length < 4) {
        setError(t('import.invalidFen'))
        return
      }
      onImportFen(trimmed)
    } else if (!onImportPgn(trimmed)) {
      setError(t('import.invalidPgn'))
    }
  }

  const handleOpenFile = async () => {
    const path = await window.electronAPI.file.openPgn()
    if (path) {
      const content = await window.electronAPI.file.readFile(path)
      if (content) {
        setText(content)
        setMode('pgn')
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary rounded-lg shadow-xl w-[480px] p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('import.title')}</h2>
          <button
            onClick={handleOpenFile}
            className="text-sm text-accent hover:text-accent-hover transition-colors"
          >
            {t('import.openFile')}
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => { setMode('pgn'); setError('') }}
            className={`flex-1 py-2 text-sm rounded transition-colors ${
              mode === 'pgn' ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
            }`}
          >
            PGN
          </button>
          <button
            onClick={() => { setMode('fen'); setError('') }}
            className={`flex-1 py-2 text-sm rounded transition-colors ${
              mode === 'fen' ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
            }`}
          >
            FEN
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setError('') }}
          placeholder={mode === 'pgn' ? t('import.pgnPlaceholder') : t('import.fenPlaceholder')}
          className="w-full h-40 bg-surface text-gray-200 text-sm p-3 rounded border border-[var(--border-color)] resize-none font-mono focus:outline-none focus:border-accent"
        />

        {error && <div className="text-red-400 text-sm mt-2">{error}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded text-gray-400 hover:text-gray-200 transition-colors"
          >
            {t('editor.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent-hover transition-colors font-medium"
          >
            {t('import.import')}
          </button>
        </div>
      </div>
    </div>
  )
}
