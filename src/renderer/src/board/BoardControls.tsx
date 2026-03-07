import { useGameStore } from '@renderer/stores/gameStore'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'

const btnBase = 'px-6 py-2.5 text-base rounded-md transition-colors'
const btnOff = `${btnBase} bg-surface-secondary text-gray-300 hover:bg-surface-tertiary`
const btnOn = (active: boolean) =>
  active
    ? `${btnBase} bg-accent text-white`
    : btnOff

export default function BoardControls() {
  const t = useT()
  const flipBoard = useGameStore((s) => s.flipBoard)
  const toggleCoordinates = useUIStore((s) => s.toggleCoordinates)
  const toggleLegalMoves = useUIStore((s) => s.toggleLegalMoves)
  const showCoordinates = useUIStore((s) => s.showCoordinates)
  const showLegalMoves = useUIStore((s) => s.showLegalMoves)
  const boardEditorMode = useUIStore((s) => s.boardEditorMode)
  const setBoardEditorMode = useUIStore((s) => s.setBoardEditorMode)

  return (
    <div className="flex items-center gap-3 py-3">
      <button onClick={flipBoard} className={btnOff} title={t('board.flip.title')}>
        {t('board.flip')}
      </button>
      <button onClick={toggleCoordinates} className={btnOn(showCoordinates)} title={t('board.coords.title')}>
        {t('board.coords')}
      </button>
      <button onClick={toggleLegalMoves} className={btnOn(showLegalMoves)} title={t('board.hints.title')}>
        {t('board.hints')}
      </button>
      <button
        onClick={() => setBoardEditorMode(!boardEditorMode)}
        className={btnOn(boardEditorMode)}
        title={t('board.edit.title')}
      >
        {t('board.edit')}
      </button>
    </div>
  )
}
