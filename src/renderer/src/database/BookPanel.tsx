import { useEffect, useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useBookStore } from '@renderer/stores/bookStore'
import { useT } from '@renderer/i18n/useI18n'
import type { BookMove } from './types'

/** Moves the loaded Polyglot book suggests for the current position. */
export default function BookPanel() {
  const t = useT()
  const fen = useGameStore((s) => s.fen)
  const name = useBookStore((s) => s.name)
  const entries = useBookStore((s) => s.entries)
  const epoch = useBookStore((s) => s.epoch)
  const [moves, setMoves] = useState<BookMove[]>([])

  useEffect(() => {
    if (!name || !window.electronAPI?.book) {
      setMoves([])
      return
    }
    let cancelled = false
    window.electronAPI.book.lookup(fen).then((m) => {
      if (!cancelled) setMoves(m ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [fen, name, epoch])

  const loadBook = async () => {
    if (!window.electronAPI?.book) return
    const path = await window.electronAPI.book.openFileDialog()
    if (!path) return
    const res = await window.electronAPI.book.load(path)
    if (res.success) useBookStore.getState().setLoaded(path, res.name ?? '', res.entries ?? 0)
    // eslint-disable-next-line no-alert
    else alert(res.error ?? 'Failed to load book')
  }

  const closeBook = async () => {
    await window.electronAPI?.book?.close()
    useBookStore.getState().clear()
  }

  const playMove = (uci: string) => {
    useGameStore.getState().makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4])
  }

  return (
    <div className="border-b border-[var(--border-color)] shrink-0">
      <div className="flex items-center justify-between px-3 py-1.5 gap-2">
        <span className="text-xs font-medium text-gray-300 shrink-0">{t('book.title')}</span>
        <div className="flex items-center gap-2 min-w-0">
          {name && (
            <span
              className="text-[10px] text-gray-500 truncate"
              title={`${entries.toLocaleString()} ${t('book.entries')}`}
            >
              {name}
            </span>
          )}
          <button
            onClick={loadBook}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0"
          >
            {name ? t('book.change') : t('book.load')}
          </button>
          {name && (
            <button
              onClick={closeBook}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors shrink-0"
            >
              {t('book.close')}
            </button>
          )}
        </div>
      </div>

      {!name ? (
        <p className="px-3 pb-2 text-[10px] text-gray-600">{t('book.none')}</p>
      ) : moves.length === 0 ? (
        <p className="px-3 pb-2 text-[10px] text-gray-600">{t('book.noMoves')}</p>
      ) : (
        <div className="max-h-40 overflow-y-auto pb-1">
          <table className="w-full text-[11px]">
            <tbody>
              {moves.map((m) => (
                <tr
                  key={m.uci}
                  onClick={() => playMove(m.uci)}
                  className="cursor-pointer hover:bg-surface-tertiary transition-colors"
                >
                  <td className="px-3 py-0.5 font-semibold text-accent w-16">{m.san}</td>
                  <td className="px-2 py-0.5">
                    <div className="h-1.5 rounded bg-surface-tertiary overflow-hidden">
                      <div
                        className="h-full bg-accent/70"
                        style={{ width: `${m.probability * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-0.5 text-right text-gray-400 tabular-nums w-14">
                    {(m.probability * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
