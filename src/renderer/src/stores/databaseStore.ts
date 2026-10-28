import { create } from 'zustand'
import type { SearchParams } from '@renderer/database/types'

/**
 * Tracks which database is currently open in the main process. The `epoch`
 * bumps whenever a new database is opened so position-dependent views (the
 * opening tree / reference panel) know to refetch.
 *
 * The list's filter, page and selection live here too, so switching tabs
 * (which unmounts the database panel) comes back to the same view.
 */
export interface DatabaseState {
  name: string
  count: number
  epoch: number
  query: SearchParams
  page: number
  selectedId: number | null
  /** An import is running (it may take minutes; the panel can be left meanwhile). */
  importing: boolean
  setImporting: (importing: boolean) => void
  setOpened: (name: string, count: number) => void
  setQuery: (query: SearchParams, page: number) => void
  setSelectedId: (id: number | null) => void
  clear: () => void
}

export const useDatabaseStore = create<DatabaseState>((set) => ({
  name: '',
  count: 0,
  epoch: 0,
  query: {},
  page: 0,
  selectedId: null,
  importing: false,
  setImporting: (importing) => set({ importing }),
  setOpened: (name, count) =>
    set((s) => ({ name, count, epoch: s.epoch + 1, query: {}, page: 0, selectedId: null })),
  setQuery: (query, page) => set({ query, page }),
  setSelectedId: (selectedId) => set({ selectedId }),
  clear: () =>
    set((s) => ({ name: '', count: 0, epoch: s.epoch + 1, query: {}, page: 0, selectedId: null }))
}))
