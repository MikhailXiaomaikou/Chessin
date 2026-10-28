import { useState } from 'react'
import { useT } from '@renderer/i18n/useI18n'
import type { SearchParams } from './types'

interface GameFilterProps {
  onSearch: (params: SearchParams) => void
}

const inputCls =
  'bg-surface text-gray-200 text-[10px] px-2 py-1 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent'

export default function GameFilter({ onSearch }: GameFilterProps) {
  const t = useT()
  const [white, setWhite] = useState('')
  const [black, setBlack] = useState('')
  const [ignoreColors, setIgnoreColors] = useState(false)
  const [eco, setEco] = useState('')
  const [result, setResult] = useState('')
  const [event, setEvent] = useState('')
  const [minElo, setMinElo] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch({
      white: white || undefined,
      black: black || undefined,
      ignoreColors: ignoreColors || undefined,
      eco: eco || undefined,
      result: result || undefined,
      event: event || undefined,
      minElo: minElo ? parseInt(minElo) : undefined
    })
  }

  const clear = () => {
    setWhite('')
    setBlack('')
    setIgnoreColors(false)
    setEco('')
    setResult('')
    setEvent('')
    setMinElo('')
    onSearch({})
  }

  return (
    <form
      onSubmit={submit}
      className="px-2 py-2 border-b border-[var(--border-color)] space-y-1"
    >
      <div className="flex gap-1">
        <input
          type="text"
          placeholder={t('filter.white')}
          value={white}
          onChange={(e) => setWhite(e.target.value)}
          className={`flex-1 ${inputCls}`}
        />
        <input
          type="text"
          placeholder={t('filter.black')}
          value={black}
          onChange={(e) => setBlack(e.target.value)}
          className={`flex-1 ${inputCls}`}
        />
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          placeholder={t('filter.event')}
          value={event}
          onChange={(e) => setEvent(e.target.value)}
          className={`flex-1 ${inputCls}`}
        />
        <input
          type="text"
          placeholder={t('filter.eco')}
          value={eco}
          onChange={(e) => setEco(e.target.value)}
          className={`w-16 ${inputCls}`}
        />
        <input
          type="number"
          placeholder={t('filter.minElo')}
          value={minElo}
          onChange={(e) => setMinElo(e.target.value)}
          className={`w-20 ${inputCls}`}
        />
      </div>
      <div className="flex gap-1 items-center">
        <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={ignoreColors}
            onChange={(e) => setIgnoreColors(e.target.checked)}
            className="accent-accent"
          />
          {t('filter.ignoreColors')}
        </label>
        <select
          value={result}
          onChange={(e) => setResult(e.target.value)}
          className={`flex-1 ${inputCls}`}
        >
          <option value="">{t('filter.anyResult')}</option>
          <option value="1-0">1-0</option>
          <option value="0-1">0-1</option>
          <option value="1/2-1/2">1/2-1/2</option>
        </select>
        <button
          type="submit"
          className="px-2 py-1 text-[10px] rounded bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          {t('filter.search')}
        </button>
        <button
          type="button"
          onClick={clear}
          className="px-2 py-1 text-[10px] rounded text-gray-500 hover:text-gray-300 transition-colors"
        >
          {t('filter.clear')}
        </button>
      </div>
    </form>
  )
}
