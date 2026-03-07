import { useState } from 'react'
import { useEngine } from './hooks/useEngine'
import { useEngineStore, ENGINE_COLORS } from '@renderer/stores/engineStore'
import { useT } from '@renderer/i18n/useI18n'
import EngineLines from './EngineLines'
import EngineStats from './EngineStats'
import WdlBar from './WdlBar'
import EngineConfigDialog from './EngineConfigDialog'

export default function EnginePanel() {
  const t = useT()
  const { engines, isAnalyzing, toggleAnalysis, addEngine, removeEngine } = useEngine()
  const analysisResults = useEngineStore((s) => s.analysisResults)
  const setEngineActive = useEngineStore((s) => s.setEngineActive)
  const [configEngineId, setConfigEngineId] = useState<string | null>(null)

  const hasEngines = engines.length > 0

  const handleAddEngine = async () => {
    if (!window.electronAPI?.file) return
    const path = await window.electronAPI.file.selectEngine()
    if (path) {
      await addEngine(path)
    }
  }

  if (!hasEngines) {
    return (
      <div className="bg-[var(--bg-secondary)] border-b border-[var(--border-color)] px-5 py-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-lg font-medium text-gray-400">{t('engine.title')}</span>
          <button onClick={handleAddEngine}
            className="text-lg text-accent hover:text-accent-hover transition-colors">
            {t('engine.add')}
          </button>
        </div>
        <div className="text-base text-gray-600 italic">{t('engine.noEngine')}</div>
      </div>
    )
  }

  return (
    <div className="bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
      {engines.map((engine, idx) => {
        const result = analysisResults.get(engine.id)
        const color = ENGINE_COLORS[idx % ENGINE_COLORS.length]

        return (
          <div key={engine.id} className="border-b border-[var(--border-color)] last:border-b-0">
            <div className="flex items-center justify-between px-5 py-2">
              <div className="flex items-center gap-2">
                {/* Active toggle */}
                <button
                  onClick={() => setEngineActive(engine.id, !engine.isActive)}
                  className="w-5 h-5 rounded border-2 flex items-center justify-center transition-colors"
                  style={{
                    borderColor: color,
                    backgroundColor: engine.isActive ? color : 'transparent'
                  }}
                  title={engine.isActive ? t('engine.deactivate') : t('engine.activate')}
                >
                  {engine.isActive && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>

                {/* Engine color indicator */}
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />

                {/* Analyzing indicator */}
                {engine.isActive && isAnalyzing && (
                  <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                )}

                <span className="text-base font-medium text-gray-300">{engine.name}</span>
              </div>

              <div className="flex items-center gap-1">
                {/* Config button */}
                <button
                  onClick={() => setConfigEngineId(engine.id)}
                  className="text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 text-sm"
                  title={t('engine.config')}
                >
                  ⚙
                </button>
                {/* Remove button */}
                <button
                  onClick={() => removeEngine(engine.id)}
                  className="text-gray-600 hover:text-red-400 transition-colors px-2 py-1 text-sm"
                  title={t('engine.remove')}
                >
                  ✕
                </button>
              </div>
            </div>

            {engine.isActive && result && (
              <>
                <EngineStats result={result} />
                {result.wdl && <WdlBar wdl={result.wdl} />}
                <EngineLines lines={result.lines} />
              </>
            )}
            {engine.isActive && !result && isAnalyzing && (
              <div className="px-5 py-2 text-sm text-gray-600 italic">{t('engine.analyzing')}</div>
            )}
          </div>
        )
      })}

      {/* Bottom bar: analyze + add */}
      <div className="flex items-center justify-between px-5 py-2">
        <button
          onClick={toggleAnalysis}
          className={`px-4 py-1.5 text-sm rounded font-medium transition-colors ${
            isAnalyzing
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-surface-tertiary hover:bg-surface-hover text-gray-300'
          }`}
        >
          {isAnalyzing ? t('engine.stopAnalysis') : t('engine.startAnalysis')}
        </button>
        <button onClick={handleAddEngine}
          className="text-sm text-accent hover:text-accent-hover transition-colors">
          {t('engine.add')}
        </button>
      </div>

      {configEngineId && (
        <EngineConfigDialog
          engineId={configEngineId}
          onClose={() => setConfigEngineId(null)}
        />
      )}
    </div>
  )
}
