import { useState, useRef, useEffect } from 'react'
import { useT } from '@renderer/i18n/useI18n'

interface CommentEditorProps {
  comment: string
  onSave: (comment: string) => void
  onCancel: () => void
}

export default function CommentEditor({ comment, onSave, onCancel }: CommentEditorProps) {
  const t = useT()
  const [text, setText] = useState(comment)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSave(text)
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="p-2 bg-surface-tertiary rounded my-1">
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full bg-surface text-gray-200 text-xs p-1.5 rounded border border-[var(--border-color)]
                   focus:outline-none focus:border-accent resize-none"
        rows={2}
        placeholder={t('comment.placeholder')}
      />
      <div className="flex justify-end gap-1 mt-1">
        <button onClick={onCancel}
          className="px-2 py-0.5 text-[10px] rounded text-gray-400 hover:text-gray-200 transition-colors">
          {t('comment.cancel')}
        </button>
        <button onClick={() => onSave(text)}
          className="px-2 py-0.5 text-[10px] rounded bg-accent text-white hover:bg-accent-hover transition-colors">
          {t('comment.save')}
        </button>
      </div>
    </div>
  )
}
