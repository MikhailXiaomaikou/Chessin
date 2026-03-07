import { NAG_SYMBOLS } from '@shared/constants'

interface MoveNodeProps {
  san: string
  moveNumber?: number
  isWhite: boolean
  isActive: boolean
  nags?: number[]
  comment?: string
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

export default function MoveNode({
  san,
  moveNumber,
  isWhite,
  isActive,
  nags,
  comment,
  onClick,
  onContextMenu
}: MoveNodeProps) {
  const nagStr = nags?.map((n) => NAG_SYMBOLS[n] || '').join('') || ''

  return (
    <span className="inline">
      {moveNumber !== undefined && (
        <span className="text-gray-500 select-none">
          {moveNumber}.{!isWhite && '..'}
        </span>
      )}
      <span
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={`px-0.5 rounded cursor-pointer transition-colors font-mono ${
          isActive
            ? 'bg-accent text-white'
            : 'hover:bg-surface-tertiary text-gray-200'
        }`}
      >
        {san}
        {nagStr && (
          <span className="text-yellow-400 ml-0.5">{nagStr}</span>
        )}
      </span>
      {comment && (
        <span className="text-gray-500 italic text-[10px] mx-1">
          {'{' + comment + '}'}
        </span>
      )}
    </span>
  )
}
