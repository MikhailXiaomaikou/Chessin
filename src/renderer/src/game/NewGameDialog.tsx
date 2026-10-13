import { useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useEngineStore } from '@renderer/stores/engineStore'
import { useLlmStore, type Seat } from '@renderer/stores/llmStore'
import { useT } from '@renderer/i18n/useI18n'
import LlmPlayersDialog from '@renderer/llm/LlmPlayersDialog'
import { DEFAULT_FEN } from '@shared/constants'

interface NewGameDialogProps {
  onClose: () => void
}

type GameMode = 'analysis' | 'llm' | 'vsEngine' | 'engineVsEngine'
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
  const llmPlayers = useLlmStore((s) => s.players)
  const [whiteSeat, setWhiteSeat] = useState<string>('human')
  const [blackSeat, setBlackSeat] = useState<string>(() => llmPlayers[0]?.id ?? 'human')
  const [showPlayers, setShowPlayers] = useState(false)

  const toSeat = (v: string): Seat =>
    v !== 'human' && llmPlayers.some((p) => p.id === v) ? { kind: 'llm', playerId: v } : { kind: 'human' }
  const white = toSeat(whiteSeat)
  const black = toSeat(blackSeat)
  const llmReady = white.kind === 'llm' || black.kind === 'llm'

  const handleStart = () => {
    const llm = useLlmStore.getState()
    newGame()
    if (mode === 'llm' && llmReady) {
      llm.startMatch(white, black, DEFAULT_FEN)
      // Put the human's pieces at the bottom.
      useGameStore.setState({ orientation: white.kind === 'llm' && black.kind === 'human' ? 'black' : 'white' })
    } else {
      llm.endMatch()
    }
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
              { value: 'llm' as const, label: t('newGame.llm') },
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

        {mode === 'llm' && (
          <div className="mb-4">
            {llmPlayers.length === 0 ? (
              <p className="text-xs text-gray-500 italic mb-2">{t('newGame.noLlmPlayers')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 mb-2">
                {([
                  { label: t('editor.white'), value: whiteSeat, set: setWhiteSeat },
                  { label: t('editor.black'), value: blackSeat, set: setBlackSeat }
                ]).map((seat) => (
                  <div key={seat.label}>
                    <label className="text-xs text-gray-400 mb-1 block">{seat.label}</label>
                    <select value={seat.value} onChange={(e) => seat.set(e.target.value)}
                      className="w-full bg-surface text-gray-200 text-xs p-2 rounded border border-[var(--border-color)]">
                      <option value="human">{t('newGame.human')}</option>
                      {llmPlayers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setShowPlayers(true)}
              className="text-xs text-accent hover:text-accent-hover transition-colors mb-2">
              {t('newGame.managePlayers')}
            </button>
            <p className="text-xs text-gray-500">{t('newGame.noEngineRule')}</p>
          </div>
        )}

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

        {(mode === 'vsEngine' || mode === 'engineVsEngine') && (
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
          <button onClick={handleStart} disabled={mode === 'llm' && !llmReady}
            className="px-4 py-2 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors font-medium">
            {t('newGame.startGame')}
          </button>
        </div>
      </div>
      {showPlayers && <LlmPlayersDialog onClose={() => setShowPlayers(false)} />}
    </div>
  )
}
