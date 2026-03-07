import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface PVLine {
  multipv: number
  score: { type: 'cp' | 'mate'; value: number }
  depth: number
  pv: string[] // SAN notation
  pvUci: string[] // UCI notation
}

export interface AnalysisResult {
  engineId: string
  depth: number
  seldepth?: number
  nodes?: number
  nps?: number
  time?: number
  lines: PVLine[]
  wdl?: [number, number, number]
  hashfull?: number
}

export const ENGINE_COLORS = ['#96bc4b', '#5c8bb0', '#e58f2a', '#ca3431', '#1baca6', '#a855f7'] as const

export interface EngineEntry {
  id: string
  name: string
  path: string
  isActive: boolean
  multiPv: number
}

export interface EngineState {
  engines: EngineEntry[]
  analysisResults: Map<string, AnalysisResult>
  isAnalyzing: boolean

  addEngine: (entry: EngineEntry) => void
  removeEngine: (id: string) => void
  setEngineActive: (id: string, active: boolean) => void
  setMultiPv: (id: string, multiPv: number) => void
  updateAnalysis: (engineId: string, result: Partial<AnalysisResult>) => void
  updatePVLine: (engineId: string, line: PVLine) => void
  clearAnalysis: (engineId: string) => void
  setAnalyzing: (analyzing: boolean) => void
}

export const useEngineStore = create<EngineState>()(
  persist(
    (set, get) => ({
      engines: [],
      analysisResults: new Map(),
      isAnalyzing: false,

      addEngine: (entry) =>
        set((state) => ({
          engines: [...state.engines, entry]
        })),

      removeEngine: (id) =>
        set((state) => ({
          engines: state.engines.filter((e) => e.id !== id)
        })),

      setEngineActive: (id, active) =>
        set((state) => ({
          engines: state.engines.map((e) =>
            e.id === id ? { ...e, isActive: active } : e
          )
        })),

      setMultiPv: (id, multiPv) =>
        set((state) => ({
          engines: state.engines.map((e) =>
            e.id === id ? { ...e, multiPv } : e
          )
        })),

      updateAnalysis: (engineId, result) => {
        const { analysisResults } = get()
        const existing = analysisResults.get(engineId) || {
          engineId,
          depth: 0,
          lines: []
        }
        const updated = new Map(analysisResults)
        updated.set(engineId, { ...existing, ...result })
        set({ analysisResults: updated })
      },

      updatePVLine: (engineId, line) => {
        const { analysisResults } = get()
        const existing = analysisResults.get(engineId) || {
          engineId,
          depth: 0,
          lines: []
        }

        const lines = [...existing.lines]
        const idx = lines.findIndex((l) => l.multipv === line.multipv)
        if (idx >= 0) {
          lines[idx] = line
        } else {
          lines.push(line)
          lines.sort((a, b) => a.multipv - b.multipv)
        }

        const updated = new Map(analysisResults)
        updated.set(engineId, {
          ...existing,
          depth: Math.max(existing.depth, line.depth),
          lines
        })
        set({ analysisResults: updated })
      },

      clearAnalysis: (engineId) => {
        const updated = new Map(get().analysisResults)
        updated.delete(engineId)
        set({ analysisResults: updated })
      },

      setAnalyzing: (analyzing) => set({ isAnalyzing: analyzing })
    }),
    {
      name: 'chess-gui-engines',
      partialize: (state) => ({
        engines: state.engines
      })
    }
  )
)
