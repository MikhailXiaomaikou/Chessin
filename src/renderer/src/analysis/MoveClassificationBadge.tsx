import { CLASSIFICATION_COLORS, CLASSIFICATION_SYMBOLS, type MoveClassification } from '@renderer/stores/analysisStore'

interface Props {
  classification: MoveClassification
}

export default function MoveClassificationBadge({ classification }: Props) {
  const symbol = CLASSIFICATION_SYMBOLS[classification]
  if (!symbol) return null

  const color = CLASSIFICATION_COLORS[classification]

  return (
    <span
      className="text-xs font-bold ml-0.5"
      style={{ color }}
    >
      {symbol}
    </span>
  )
}
