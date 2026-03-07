import { NAG_SYMBOLS } from '@shared/constants'

interface NagSelectorProps {
  onSelect: (nag: number) => void
  onClose: () => void
}

const COMMON_NAGS = [
  { nag: 1, label: '!' },
  { nag: 2, label: '?' },
  { nag: 3, label: '!!' },
  { nag: 4, label: '??' },
  { nag: 5, label: '!?' },
  { nag: 6, label: '?!' },
  { nag: 10, label: '=' },
  { nag: 14, label: '⩲' },
  { nag: 15, label: '⩱' },
  { nag: 16, label: '±' },
  { nag: 17, label: '∓' },
  { nag: 18, label: '+-' },
  { nag: 19, label: '-+' },
  { nag: 13, label: '∞' }
]

export default function NagSelector({ onSelect, onClose }: NagSelectorProps) {
  return (
    <div className="absolute z-50 bg-surface-secondary border border-[var(--border-color)] rounded shadow-lg p-2">
      <div className="grid grid-cols-7 gap-1">
        {COMMON_NAGS.map(({ nag, label }) => (
          <button
            key={nag}
            onClick={() => {
              onSelect(nag)
              onClose()
            }}
            className="w-8 h-8 flex items-center justify-center text-sm rounded
                       hover:bg-surface-tertiary text-gray-200 transition-colors"
            title={NAG_SYMBOLS[nag] || String(nag)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
