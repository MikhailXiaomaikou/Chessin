import { useGameStore } from '@renderer/stores/gameStore'
import { useT } from '@renderer/i18n/useI18n'

export default function MoveNavigation() {
  const t = useT()
  const goToStart = useGameStore((s) => s.goToStart)
  const goBack = useGameStore((s) => s.goBack)
  const goForward = useGameStore((s) => s.goForward)
  const goToEnd = useGameStore((s) => s.goToEnd)
  const currentNodeId = useGameStore((s) => s.currentNodeId)
  const treeNodes = useGameStore((s) => s.treeNodes)
  const rootChildren = useGameStore((s) => s.rootChildren)

  const atStart = currentNodeId === null
  const atEnd =
    currentNodeId === null
      ? rootChildren.length === 0
      : (treeNodes[currentNodeId]?.children.length ?? 0) === 0

  const btnClass = (disabled: boolean) =>
    `flex-1 py-4 text-2xl text-center transition-colors ${
      disabled
        ? 'text-gray-600 cursor-not-allowed'
        : 'text-gray-300 hover:bg-surface-tertiary cursor-pointer'
    }`

  return (
    <div className="flex border-t border-[var(--border-color)]">
      <button onClick={goToStart} disabled={atStart} className={btnClass(atStart)} title={t('nav.goToStart')}>
        &#x23EE;
      </button>
      <button onClick={goBack} disabled={atStart} className={btnClass(atStart)} title={t('nav.goBack')}>
        &#x25C0;
      </button>
      <button onClick={goForward} disabled={atEnd} className={btnClass(atEnd)} title={t('nav.goForward')}>
        &#x25B6;
      </button>
      <button onClick={goToEnd} disabled={atEnd} className={btnClass(atEnd)} title={t('nav.goToEnd')}>
        &#x23ED;
      </button>
    </div>
  )
}
