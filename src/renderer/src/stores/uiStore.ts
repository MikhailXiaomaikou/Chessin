import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Locale } from '@renderer/i18n/locales'

export interface UIState {
  theme: 'dark' | 'light'
  boardTheme: 'brown' | 'green' | 'blue' | 'gray' | 'purple'
  pieceSet: 'cburnett' | 'merida' | 'alpha' | 'california'
  showCoordinates: boolean
  showLegalMoves: boolean
  soundEnabled: boolean
  showEvalBar: boolean
  showEngineArrows: boolean
  boardEditorMode: boolean
  evalBarMode: 'eval' | 'wdl'
  locale: Locale

  setTheme: (theme: 'dark' | 'light') => void
  setBoardTheme: (theme: UIState['boardTheme']) => void
  setPieceSet: (set: UIState['pieceSet']) => void
  toggleCoordinates: () => void
  toggleLegalMoves: () => void
  toggleSound: () => void
  toggleEvalBar: () => void
  toggleEngineArrows: () => void
  setBoardEditorMode: (on: boolean) => void
  setEvalBarMode: (mode: 'eval' | 'wdl') => void
  setLocale: (locale: Locale) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'dark',
      boardTheme: 'brown',
      pieceSet: 'cburnett',
      showCoordinates: true,
      showLegalMoves: true,
      soundEnabled: true,
      showEvalBar: true,
      showEngineArrows: true,
      boardEditorMode: false,
      evalBarMode: 'eval',
      locale: 'zh',

      setTheme: (theme) => {
        document.documentElement.className = theme
        set({ theme })
      },
      setBoardTheme: (boardTheme) => set({ boardTheme }),
      setPieceSet: (pieceSet) => set({ pieceSet }),
      toggleCoordinates: () =>
        set((state) => ({ showCoordinates: !state.showCoordinates })),
      toggleLegalMoves: () =>
        set((state) => ({ showLegalMoves: !state.showLegalMoves })),
      toggleSound: () => set((state) => ({ soundEnabled: !state.soundEnabled })),
      toggleEvalBar: () =>
        set((state) => ({ showEvalBar: !state.showEvalBar })),
      toggleEngineArrows: () =>
        set((state) => ({ showEngineArrows: !state.showEngineArrows })),
      setBoardEditorMode: (on) => set({ boardEditorMode: on }),
      setEvalBarMode: (mode) => set({ evalBarMode: mode }),
      setLocale: (locale) => set({ locale })
    }),
    {
      name: 'chess-gui-ui-settings',
      version: 2,
      migrate: () => {
        // Discard old persisted state entirely, use fresh defaults
        return {} as UIState
      },
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<UIState>)
      })
    }
  )
)
