import { useState } from 'react'
import { useTabStore } from '@renderer/stores/tabStore'
import { useT } from '@renderer/i18n/useI18n'

export default function TabBar() {
  const t = useT()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const addTab = useTabStore((s) => s.addTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const switchTab = useTabStore((s) => s.switchTab)
  const renameTab = useTabStore((s) => s.renameTab)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const handleDoubleClick = (id: string, name: string) => {
    setEditingId(id)
    setEditValue(name)
  }

  const handleRenameSubmit = (id: string) => {
    if (editValue.trim()) {
      renameTab(id, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="flex items-center bg-[var(--bg-primary)] border-b border-[var(--border-color)] h-9 shrink-0 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => switchTab(tab.id)}
          className={`group flex items-center gap-1 px-3 h-full cursor-pointer border-r border-[var(--border-color)] text-sm shrink-0 transition-colors ${
            tab.id === activeTabId
              ? 'bg-[var(--bg-secondary)] text-gray-200'
              : 'text-gray-500 hover:text-gray-300 hover:bg-surface-tertiary'
          }`}
        >
          {editingId === tab.id ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => handleRenameSubmit(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit(tab.id)
                if (e.key === 'Escape') setEditingId(null)
              }}
              className="bg-transparent border-b border-accent outline-none w-16 text-sm"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              onDoubleClick={() => handleDoubleClick(tab.id, tab.name)}
              className="select-none"
            >
              {tab.name}
            </span>
          )}
          {tabs.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="ml-1 text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
              title={t('tab.close')}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        onClick={() => addTab()}
        className="px-3 h-full text-gray-500 hover:text-gray-300 hover:bg-surface-tertiary transition-colors text-lg shrink-0"
        title={t('tab.new')}
      >
        +
      </button>
    </div>
  )
}
