import { create } from 'zustand'

/**
 * Tracks which database is currently open in the main process. The `epoch`
 * bumps whenever a new database is opened so position-dependent views (the
 * opening tree / reference panel) know to refetch.
 */
export interface DatabaseState {
  name: string
  count: number
  epoch: number
  setOpened: (name: string, count: number) => void
  clear: () => void
}

export const useDatabaseStore = create<DatabaseState>((set) => ({
  name: '',
  count: 0,
  epoch: 0,
  setOpened: (name, count) => set((s) => ({ name, count, epoch: s.epoch + 1 })),
  clear: () => set((s) => ({ name: '', count: 0, epoch: s.epoch + 1 }))
}))
