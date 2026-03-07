import { useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useEngineStore } from '@renderer/stores/engineStore'
import { useT } from '@renderer/i18n/useI18n'

interface NewGameDialogProps {
  onClose: () => void
}

type GameMode = 'analysis' | 'vsEngine' | 'engineVsEngine'
type PlayerColor = 'white' | 'black' | 'random'

const TIME_CONTROLS = [
  { key: 'noTime', time: 0, inc: 0 },
  { key: '1+0', time: 60, inc: 0 },
  { key: '3+0', time: 180, inc: 0 },
  { key: '3+2', time: 180, inc: 2 },
  { key: '5+0', time: 300, inc: 0 },
  { key: '5+3', time: 300, inc: 3 },
  { key: '10+0', time: 600, inc: 0 },
  { key: '15+10', time: 900, inc: 10 },
  { key: '30+0', time: 1800, inc: 0 }
]

export default function NewGameDialog({ onClose }: NewGameDialogProps) {
  const t = useT()
  const [mode, setMode] = useState<GameMode>('analysis')
  const [color, setColor] = useState<PlayerColor>('white')
  const [timeControl, setTimeControl] = useState(0)
  const newGame = useGameStore((s) => s.newGame)
  const engines = useEngineStore((s) => s.engines)

  const handleStart = () => {
    newGame()
    onClose()
  }

  const tcLabel = (key: string) => (key === 'noTime' ? t('newGame.noTime') : key)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary rounded-lg shadow-xl w-96 p-5">
        <h2 className="text-lg font-semibold mb-4">{t('newGame.title')}</h2>

        <div className="mb-4">
          <label className="text-xs text-gray-400 mb-1 block">{t('newGame.mode')}</label>
          <div className="flex gap-1">
            {([
              { value: 'analysis' as const, label: t('newGame.analysis') },
              { value: 'vsEngine' as const, label: t('newGame.vsEngine') },
              { value: 'engineVsEngine' as const, label: t('newGame.engineVsEngine') }
            ]).map((opt) => (
              <button key={opt.value} onClick={() => setMode(opt.value)}
                className={`flex-1 py-1.5 text-xs rounded transition-colors ${
                  mode === opt.value ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
                }`}>{opt.label}</button>
            ))}
          </div>
        </div>

        {mode === 'vsEngine' && (
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-1 block">{t('newGame.playAs')}</label>
            <div className="flex gap-1">
              {([
                { value: 'white' as const, label: t('editor.white') },
                { value: 'black' as const, label: t('editor.black') },
                { value: 'random' as const, label: t('newGame.random') }
              ]).map((opt) => (
                <button key={opt.value} onClick={() => setColor(opt.value)}
                  className={`flex-1 py-1.5 text-xs rounded transition-colors ${
                    color === opt.value ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
                  }`}>{opt.label}</button>
              ))}
            </div>
          </div>
        )}

        {(mode === 'vsEngine' || mode === 'engineVsEngine') && (
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-1 block">{t('newGame.engine')}</label>
            {engines.length === 0 ? (
              <p className="text-xs text-gray-500 italic">{t('newGame.noEngines')}</p>
            ) : (
              <select className="w-full bg-surface text-gray-200 text-xs p-2 rounded border border-[var(--border-color)]">
                {engines.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {mode !== 'analysis' && (
          <div className="mb-4">
            <label className="text-xs text-gray-400 mb-1 block">{t('newGame.timeControl')}</label>
            <div className="grid grid-cols-3 gap-1">
              {TIME_CONTROLS.map((tc, i) => (
                <button key={tc.key} onClick={() => setTimeControl(i)}
                  className={`py-1.5 text-xs rounded transition-colors ${
                    timeControl === i ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
                  }`}>{tcLabel(tc.key)}</button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-4 py-2 text-xs rounded text-gray-400 hover:text-gray-200 transition-colors">
            {t('editor.cancel')}
          </button>
          <button onClick={handleStart}
            className="px-4 py-2 text-xs rounded bg-accent text-white hover:bg-accent-hover transition-colors font-medium">
            {t('newGame.startGame')}
          </button>
        </div>
      </div>
    </div>
  )
}
