import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * The opening book currently loaded in the main process. Only the path is
 * persisted, so the last book is reopened on the next launch.
 */
export interface BookState {
  path: string
  name: string
  entries: number
  epoch: number
  setLoaded: (path: string, name: string, entries: number) => void
  clear: () => void
}

export const useBookStore = create<BookState>()(
  persist(
    (set) => ({
      path: '',
      name: '',
      entries: 0,
      epoch: 0,
      setLoaded: (path, name, entries) =>
        set((s) => ({ path, name, entries, epoch: s.epoch + 1 })),
      clear: () => set((s) => ({ path: '', name: '', entries: 0, epoch: s.epoch + 1 }))
    }),
    { name: 'chessin-book', partialize: (s) => ({ path: s.path }) }
  )
)
