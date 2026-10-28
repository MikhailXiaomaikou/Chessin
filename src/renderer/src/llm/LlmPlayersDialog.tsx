import { useState } from 'react'
import { useLlmStore } from '@renderer/stores/llmStore'
import { useT } from '@renderer/i18n/useI18n'
import { DEFAULT_ANTHROPIC_MODEL, type LlmEffort, type LlmPlayerConfig, type LlmProvider } from '@shared/llm/types'

const OPENAI_PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' }
]

const EFFORTS: LlmEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function blankPlayer(provider: LlmProvider): LlmPlayerConfig {
  return {
    id: `llm_${Date.now()}`,
    name: provider === 'openai' ? '' : 'Claude',
    provider,
    model: provider === 'openai' ? '' : DEFAULT_ANTHROPIC_MODEL,
    apiKey: '',
    baseUrl: provider === 'openai' ? OPENAI_PRESETS[0].baseUrl : '',
    effort: provider === 'openai' ? undefined : 'medium',
    showLegalMoves: true,
    maxRetries: 2
  }
}

const inputCls =
  'w-full bg-surface text-gray-200 text-xs p-2 rounded border border-[var(--border-color)] focus:outline-none focus:border-accent'
const labelCls = 'text-xs text-gray-400 mb-1 block'

export default function LlmPlayersDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const players = useLlmStore((s) => s.players)
  const removePlayer = useLlmStore((s) => s.removePlayer)
  const [editing, setEditing] = useState<LlmPlayerConfig | null>(null)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-surface-secondary rounded-lg shadow-xl w-[480px] max-h-[90vh] overflow-y-auto p-5">
        {editing ? (
          <PlayerForm initial={editing} onDone={() => setEditing(null)} />
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{t('llm.players')}</h2>
              <button onClick={() => setEditing(blankPlayer('anthropic'))}
                className="text-sm text-accent hover:text-accent-hover transition-colors">
                {t('llm.add')}
              </button>
            </div>
            {players.length === 0 && (
              <p className="text-xs text-gray-500 italic mb-4">{t('newGame.noLlmPlayers')}</p>
            )}
            <div className="flex flex-col gap-1 mb-4">
              {players.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-surface-tertiary rounded px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-200 truncate">{p.name}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {p.provider === 'anthropic' ? 'Anthropic' : p.provider === 'claude-code' ? t('llm.providerSubscription') : p.baseUrl} · {p.model}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => setEditing(p)} className="text-xs text-gray-400 hover:text-gray-200">
                      {t('llm.edit')}
                    </button>
                    <button onClick={() => removePlayer(p.id)} className="text-xs text-red-400 hover:text-red-300">
                      {t('llm.delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-500">{t('llm.keyNote')}</span>
              <button onClick={onClose}
                className="px-4 py-2 text-xs rounded bg-accent text-white hover:bg-accent-hover transition-colors font-medium">
                {t('llm.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PlayerForm({ initial, onDone }: { initial: LlmPlayerConfig; onDone: () => void }) {
  const t = useT()
  const players = useLlmStore((s) => s.players)
  const addPlayer = useLlmStore((s) => s.addPlayer)
  const updatePlayer = useLlmStore((s) => s.updatePlayer)
  const [p, setP] = useState<LlmPlayerConfig>(initial)
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; msg?: string }>({ state: 'idle' })

  const set = <K extends keyof LlmPlayerConfig>(key: K, value: LlmPlayerConfig[K]) =>
    setP((prev) => ({ ...prev, [key]: value }))

  const switchProvider = (provider: LlmProvider) => {
    if (provider === p.provider) return
    const blank = blankPlayer(provider)
    setP({ ...blank, id: p.id, name: p.name || blank.name, apiKey: '' })
  }

  const runTest = async () => {
    setTest({ state: 'running' })
    const res = await window.electronAPI.llm.chat({
      config: p,
      system: 'Reply with the single word OK.',
      messages: [{ role: 'user', content: 'Are you there?' }]
    })
    setTest(res.ok ? { state: 'ok', msg: res.text.slice(0, 80) } : { state: 'error', msg: res.error })
  }

  const save = () => {
    const toSave = { ...p, name: p.name.trim() || p.model }
    if (players.some((x) => x.id === toSave.id)) updatePlayer(toSave)
    else addPlayer(toSave)
    onDone()
  }

  const subscription = p.provider === 'claude-code'
  const canSave = p.model.trim() !== '' && (p.provider !== 'anthropic' || p.apiKey.trim() !== '')

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">{t('llm.players')}</h2>

      <div className="mb-3">
        <label className={labelCls}>{t('llm.provider')}</label>
        <div className="flex gap-1">
          {(['claude-code', 'anthropic', 'openai'] as const).map((prov) => (
            <button key={prov} onClick={() => switchProvider(prov)}
              className={`flex-1 py-1.5 text-xs rounded transition-colors ${
                p.provider === prov ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
              }`}>
              {prov === 'anthropic' ? t('llm.providerAnthropic') : prov === 'openai' ? t('llm.providerOpenai') : t('llm.providerSubscription')}
            </button>
          ))}
        </div>
        {subscription && <p className="text-xs text-gray-500 mt-2">{t('llm.subscriptionNote')}</p>}
      </div>

      {p.provider === 'openai' && (
        <div className="mb-3">
          <label className={labelCls}>{t('llm.preset')}</label>
          <div className="flex flex-wrap gap-1">
            {OPENAI_PRESETS.map((preset) => (
              <button key={preset.label} onClick={() => set('baseUrl', preset.baseUrl)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  p.baseUrl === preset.baseUrl ? 'bg-accent text-white' : 'bg-surface-tertiary text-gray-300 hover:bg-surface-hover'
                }`}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className={labelCls}>{t('llm.name')}</label>
          <input className={inputCls} value={p.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>{t('llm.model')}</label>
          <input className={inputCls} value={p.model} onChange={(e) => set('model', e.target.value)}
            placeholder={p.provider === 'openai' ? 'gpt-5, deepseek-chat, qwen-max ...' : DEFAULT_ANTHROPIC_MODEL} />
        </div>
      </div>

      <div className="mb-3">
        <label className={labelCls}>{subscription ? t('llm.claudePath') : t('llm.baseUrl')}</label>
        <input className={inputCls} value={p.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)}
          placeholder={subscription ? 'claude' : p.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
      </div>

      {!subscription && (
        <div className="mb-3">
          <label className={labelCls}>{t('llm.apiKey')}</label>
          <input type="password" className={inputCls} value={p.apiKey} onChange={(e) => set('apiKey', e.target.value)}
            placeholder={p.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        {p.provider !== 'openai' ? (
          <div>
            <label className={labelCls}>{t('llm.effort')}</label>
            <select className={inputCls} value={p.effort ?? ''}
              onChange={(e) => set('effort', (e.target.value || undefined) as LlmEffort | undefined)}>
              <option value="">(default)</option>
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label className={labelCls}>{t('llm.temperature')}</label>
            <input type="number" step="0.1" min="0" max="2" className={inputCls} value={p.temperature ?? ''}
              onChange={(e) => set('temperature', e.target.value === '' ? undefined : Number(e.target.value))} />
          </div>
        )}
        <div>
          <label className={labelCls}>{t('llm.maxRetries')}</label>
          <input type="number" min="0" max="10" className={inputCls} value={p.maxRetries}
            onChange={(e) => set('maxRetries', Math.max(0, Math.min(10, Number(e.target.value) || 0)))} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-300 mb-4 cursor-pointer">
        <input type="checkbox" checked={p.showLegalMoves} onChange={(e) => set('showLegalMoves', e.target.checked)} />
        {t('llm.showLegalMoves')}
      </label>

      {test.state !== 'idle' && (
        <div className={`text-xs mb-3 break-words ${test.state === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
          {test.state === 'running' ? t('llm.testing') : test.state === 'ok' ? `${t('llm.testOk')}: ${test.msg}` : test.msg}
        </div>
      )}

      <div className="flex justify-between gap-2">
        <button onClick={runTest} disabled={!canSave || test.state === 'running'}
          className="px-4 py-2 text-xs rounded bg-surface-tertiary text-gray-300 hover:bg-surface-hover disabled:opacity-40 transition-colors">
          {t('llm.test')}
        </button>
        <div className="flex gap-2">
          <button onClick={onDone} className="px-4 py-2 text-xs rounded text-gray-400 hover:text-gray-200 transition-colors">
            {t('editor.cancel')}
          </button>
          <button onClick={save} disabled={!canSave}
            className="px-4 py-2 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40 transition-colors font-medium">
            {t('llm.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
