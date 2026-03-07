import { useState } from 'react'
import { useT } from '@renderer/i18n/useI18n'

interface GameFilterProps {
  onSearch: (params: {
    white?: string
    black?: string
    result?: string
    eco?: string
  }) => void
}

export default function GameFilter({ onSearch }: GameFilterProps) {
  const t = useT()
  const [white, setWhite] = useState('')
  const [black, setBlack] = useState('')
  const [eco, setEco] = useState('')
  const [result, setResult] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch({
      white: white || undefined,
      black: black || undefined,
      eco: eco || undefined,
      result: result || undefined
    })
  }

  const handleClear = () => {
    setWhite('')
    setBlack('')
    setEco('')
    setResult('')
    onSearch({})
  }

  return (
    <form onSubmit={handleSubmit} className="px-2 py-2 border-b border-[var(--border-color)] space-y-1">
      <div className="flex gap-1">
        <input type="text" placeholder={t('filter.white')} value={white}
          onChange={(e) => setWhite(e.target.value)}
          className="flex-1 bg-surface text-gray-200 text-[10px] px-2 py-1 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent" />
        <input type="text" placeholder={t('filter.black')} value={black}
          onChange={(e) => setBlack(e.target.value)}
          className="flex-1 bg-surface text-gray-200 text-[10px] px-2 py-1 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent" />
      </div>
      <div className="flex gap-1">
        <input type="text" placeholder={t('filter.eco')} value={eco}
          onChange={(e) => setEco(e.target.value)}
          className="w-16 bg-surface text-gray-200 text-[10px] px-2 py-1 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent" />
        <select value={result} onChange={(e) => setResult(e.target.value)}
          className="flex-1 bg-surface text-gray-200 text-[10px] px-2 py-1 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent">
          <option value="">{t('filter.anyResult')}</option>
          <option value="1-0">1-0</option>
          <option value="0-1">0-1</option>
          <option value="1/2-1/2">1/2-1/2</option>
        </select>
        <button type="submit"
          className="px-2 py-1 text-[10px] rounded bg-accent text-white hover:bg-accent-hover transition-colors">
          {t('filter.search')}
        </button>
        <button type="button" onClick={handleClear}
          className="px-2 py-1 text-[10px] rounded text-gray-500 hover:text-gray-300 transition-colors">
          {t('filter.clear')}
        </button>
      </div>
    </form>
  )
}
