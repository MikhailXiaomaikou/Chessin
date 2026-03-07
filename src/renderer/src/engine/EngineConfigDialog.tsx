import { useState, useEffect } from 'react'
import { useEngineStore } from '@renderer/stores/engineStore'
import { useT } from '@renderer/i18n/useI18n'

interface Props {
  engineId: string
  onClose: () => void
}

interface UciOption {
  name: string
  type: string
  default?: string | number | boolean
  min?: number
  max?: number
  vars?: string[]
  value?: string | number | boolean
}

// Important UCI options to show prominently
const IMPORTANT_OPTIONS = ['Threads', 'Hash', 'MultiPV', 'UCI_ShowWDL', 'SyzygyPath', 'Move Overhead']

export default function EngineConfigDialog({ engineId, onClose }: Props) {
  const t = useT()
  const engine = useEngineStore((s) => s.engines.find((e) => e.id === engineId))
  const setMultiPv = useEngineStore((s) => s.setMultiPv)
  const [options, setOptions] = useState<UciOption[]>([])
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!window.electronAPI?.engine) return
    window.electronAPI.engine.getOptions(engineId).then((opts) => {
      const uciOpts = opts as UciOption[]
      setOptions(uciOpts)
      const vals: Record<string, string | number | boolean> = {}
      for (const opt of uciOpts) {
        if (opt.name === 'MultiPV' && engine) {
          vals[opt.name] = engine.multiPv
        } else if (opt.default !== undefined) {
          vals[opt.name] = opt.default
        }
      }
      setValues(vals)
    })
  }, [engineId, engine])

  const handleChange = async (name: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }))

    if (name === 'MultiPV') {
      const numVal = typeof value === 'number' ? value : parseInt(String(value), 10)
      if (!isNaN(numVal) && numVal >= 1) {
        setMultiPv(engineId, numVal)
      }
    }

    await window.electronAPI.engine.setOption(engineId, name, value)
  }

  if (!engine) return null

  const importantOpts = options.filter((o) => IMPORTANT_OPTIONS.includes(o.name))
  const otherOpts = options.filter(
    (o) => !IMPORTANT_OPTIONS.includes(o.name) && o.type !== 'button' && o.name !== 'UCI_Chess960' && o.name !== 'Ponder'
  )
  const displayOpts = showAll ? [...importantOpts, ...otherOpts] : importantOpts

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-secondary rounded-lg shadow-xl w-[520px] max-h-[80vh] flex flex-col p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{engine.name} — {t('engine.config')}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>

        <div className="text-xs text-gray-500 mb-3">{engine.path}</div>

        <div className="overflow-y-auto flex-1 space-y-3">
          {displayOpts.map((opt) => (
            <OptionRow
              key={opt.name}
              option={opt}
              value={values[opt.name]}
              onChange={(v) => handleChange(opt.name, v)}
            />
          ))}

          {otherOpts.length > 0 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-sm text-accent hover:text-accent-hover transition-colors"
            >
              {showAll ? t('engine.showLess') : t('engine.showAll')} ({otherOpts.length})
            </button>
          )}
        </div>

        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            {t('engine.done')}
          </button>
        </div>
      </div>
    </div>
  )
}

function OptionRow({
  option,
  value,
  onChange
}: {
  option: UciOption
  value: string | number | boolean | undefined
  onChange: (v: string | number | boolean) => void
}) {
  const displayName = option.name.replace(/_/g, ' ')

  if (option.type === 'check') {
    const checked = value === true || value === 'true'
    return (
      <div className="flex items-center justify-between">
        <label className="text-sm text-gray-300">{displayName}</label>
        <button
          onClick={() => onChange(!checked)}
          className={`w-10 h-5 rounded-full transition-colors relative ${
            checked ? 'bg-accent' : 'bg-gray-600'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform ${
              checked ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    )
  }

  if (option.type === 'spin') {
    const numVal = typeof value === 'number' ? value : parseInt(String(value || option.default || 0), 10)
    return (
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-300 shrink-0">{displayName}</label>
        <div className="flex items-center gap-2">
          {option.min !== undefined && (
            <span className="text-xs text-gray-600">{option.min}</span>
          )}
          <input
            type="range"
            min={option.min ?? 1}
            max={Math.min(option.max ?? 999, option.name === 'Hash' ? 16384 : option.name === 'Threads' ? 128 : (option.max ?? 999))}
            value={numVal}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--accent)] min-w-[100px]"
          />
          <input
            type="number"
            min={option.min}
            max={option.max}
            value={numVal}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!isNaN(v)) onChange(v)
            }}
            className="w-16 bg-surface text-gray-200 text-sm px-2 py-1 rounded border border-[var(--border-color)] text-right"
          />
        </div>
      </div>
    )
  }

  if (option.type === 'combo' && option.vars) {
    return (
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-300">{displayName}</label>
        <select
          value={String(value || option.default || '')}
          onChange={(e) => onChange(e.target.value)}
          className="bg-surface text-gray-200 text-sm px-2 py-1 rounded border border-[var(--border-color)]"
        >
          {option.vars.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>
    )
  }

  if (option.type === 'string') {
    return (
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm text-gray-300 shrink-0">{displayName}</label>
        <input
          type="text"
          value={String(value || '')}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-surface text-gray-200 text-sm px-2 py-1 rounded border border-[var(--border-color)] min-w-0"
        />
      </div>
    )
  }

  return null
}
