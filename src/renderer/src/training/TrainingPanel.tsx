import { useMemo, useState } from 'react'
import { useGameStore } from '@renderer/stores/gameStore'
import { useTrainingStore, type SavedRepertoire } from '@renderer/stores/trainingStore'
import { useT } from '@renderer/i18n/useI18n'
import {
  buildRepertoire,
  cardCounts,
  repertoireCards,
  type Side
} from '@shared/training/session'

const button =
  'px-3 py-1.5 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

/** Opening repertoire training: save lines from the board, then drill them. */
export default function TrainingPanel() {
  const active = useTrainingStore((s) => s.active)
  return active ? <SessionView /> : <RepertoireList />
}

function RepertoireList() {
  const t = useT()
  const repertoires = useTrainingStore((s) => s.repertoires)
  const addRepertoire = useTrainingStore((s) => s.addRepertoire)
  const hasMoves = useGameStore((s) => s.rootChildren.length > 0)
  const [name, setName] = useState('')
  const [side, setSide] = useState<Side>('w')

  const save = () => {
    const game = useGameStore.getState()
    const fallback = game.headers.Event || game.headers.White || `${t('train.tabName')} ${repertoires.length + 1}`
    addRepertoire(name.trim() || fallback, side, game.getPgn())
    setName('')
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3 gap-3 text-sm">
      <p className="text-xs text-gray-400 leading-relaxed">{t('train.intro')}</p>

      <div className="rounded border border-[var(--border-color)] p-2 space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('train.namePlaceholder')}
          className="w-full bg-surface text-gray-200 text-xs px-2 py-1.5 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent"
        />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">{t('train.side')}</span>
          {(['w', 'b'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`${button} ${
                side === s ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
              }`}
            >
              {s === 'w' ? t('train.white') : t('train.black')}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={save}
            disabled={!hasMoves}
            className={`${button} bg-accent text-white hover:bg-accent-hover`}
          >
            {t('train.save')}
          </button>
        </div>
        {!hasMoves && <p className="text-[10px] text-gray-500">{t('train.noMoves')}</p>}
      </div>

      {repertoires.map((rep) => (
        <RepertoireRow key={rep.id} rep={rep} />
      ))}
    </div>
  )
}

function RepertoireRow({ rep }: { rep: SavedRepertoire }) {
  const t = useT()
  const states = useTrainingStore((s) => s.cards[rep.id])
  const start = useTrainingStore((s) => s.start)
  const updateRepertoire = useTrainingStore((s) => s.updateRepertoire)
  const removeRepertoire = useTrainingStore((s) => s.removeRepertoire)
  const hasMoves = useGameStore((s) => s.rootChildren.length > 0)
  const [message, setMessage] = useState('')

  const cards = useMemo(() => repertoireCards(buildRepertoire(rep.pgn, rep.side)), [rep.pgn, rep.side])
  const counts = cardCounts(cards, states ?? {}, Date.now())

  const train = () => {
    if (!start(rep.id, `${t('train.tabName')} · ${rep.name}`)) setMessage(t('train.noPositions'))
  }

  return (
    <div className="rounded border border-[var(--border-color)] p-2">
      <div className="flex items-center gap-2">
        <span className={`w-3 h-3 rounded-sm border border-gray-500 ${rep.side === 'w' ? 'bg-gray-100' : 'bg-gray-800'}`} />
        <span className="flex-1 truncate text-gray-200" title={rep.name}>
          {rep.name}
        </span>
        <button onClick={train} className={`${button} bg-accent text-white hover:bg-accent-hover`}>
          {t('train.start')}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        <span className="text-yellow-400">
          {counts.due} {t('train.due')}
        </span>
        <span className="text-sky-300">
          {counts.new} {t('train.new')}
        </span>
        <span className="text-gray-400">
          {counts.learned} {t('train.learned')}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => updateRepertoire(rep.id, useGameStore.getState().getPgn())}
          disabled={!hasMoves}
          className="text-gray-500 hover:text-gray-300 disabled:opacity-40"
          title={t('train.updateHint')}
        >
          {t('train.update')}
        </button>
        <button
          onClick={() => {
            // eslint-disable-next-line no-alert
            if (confirm(t('train.confirmDelete'))) removeRepertoire(rep.id)
          }}
          className="text-red-400/80 hover:text-red-400"
        >
          {t('train.delete')}
        </button>
      </div>
      {message && <p className="mt-1 text-[11px] text-red-400">{message}</p>}
    </div>
  )
}

function SessionView() {
  const t = useT()
  const active = useTrainingStore((s) => s.active)
  const rep = useTrainingStore((s) => s.repertoires.find((r) => r.id === s.active?.repId))
  const showHint = useTrainingStore((s) => s.showHint)
  const stop = useTrainingStore((s) => s.stop)
  if (!active) return null

  const counts = cardCounts(active.session.cards, active.session.states, Date.now())
  const prompt: Record<typeof active.prompt, string> = {
    thinking: t('train.thinking'),
    ask: t('train.yourMove'),
    new: t('train.newMove'),
    lineEnd: t('train.lineEnd'),
    done: t('train.done'),
    paused: t('train.paused')
  }
  const asking = active.prompt === 'ask' || active.prompt === 'new'

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 gap-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span
          className={`w-3 h-3 rounded-sm border border-gray-500 ${rep?.side === 'w' ? 'bg-gray-100' : 'bg-gray-800'}`}
        />
        <span className="truncate">{rep?.name}</span>
      </div>

      <div className="text-xl font-semibold text-gray-100" data-testid="training-prompt">
        {prompt[active.prompt]}
      </div>

      {active.feedback && (
        <div
          className={`text-sm ${active.feedback.correct ? 'text-green-400' : 'text-red-400'}`}
          data-testid="training-feedback"
        >
          {active.feedback.correct
            ? `✓ ${t('train.correct')}`
            : `✗ ${t('train.wrong')} ${active.feedback.moves.join(', ')}`}
        </div>
      )}

      <div className="flex gap-4 text-xs text-gray-400">
        <span>
          {active.stats.answered} {t('train.answered')}
        </span>
        <span>
          {active.stats.mistakes} {t('train.mistakes')}
        </span>
        <span className="text-yellow-400">
          {counts.due} {t('train.due')}
        </span>
        <span className="text-sky-300">
          {counts.new} {t('train.new')}
        </span>
      </div>

      <div className="flex gap-2">
        {active.prompt !== 'done' && (
          <button
            onClick={showHint}
            disabled={!asking}
            className={`${button} bg-surface-tertiary text-gray-200 hover:bg-surface-hover`}
          >
            {t('train.hint')}
          </button>
        )}
        <button onClick={stop} className={`${button} bg-surface-tertiary text-gray-200 hover:bg-surface-hover`}>
          {active.prompt === 'done' ? t('train.close') : t('train.stop')}
        </button>
      </div>
    </div>
  )
}
