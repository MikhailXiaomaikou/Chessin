import type { SearchParams, SearchResult } from '../../shared/database/GameDatabase'
import type { DatabaseMethods, WorkerRequest, WorkerResponse } from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const NO_GAMES: SearchResult = { games: [], total: 0 }

/**
 * The page's side of the database worker. The worker (and its WebAssembly
 * SQLite) starts on the first open, so pages that never open a database
 * don't pay for it.
 */
export class DatabaseClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly progressListeners = new Set<(data: { count: number }) => void>()
  /** The open database's name; '' when none is open. */
  name = ''

  call<M extends keyof DatabaseMethods>(
    method: M,
    ...args: Parameters<DatabaseMethods[M]>
  ): Promise<ReturnType<DatabaseMethods[M]>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.start().postMessage({ id, method, args } as WorkerRequest)
    })
  }

  onProgress(listener: (data: { count: number }) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./database.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if ('progress' in msg) {
        for (const listener of this.progressListeners) listener({ count: msg.progress })
        return
      }
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if ('error' in msg) pending.reject(new Error(msg.error))
      else pending.resolve(msg.result)
    }
    worker.onerror = (e) => {
      // The worker died (out of memory on a huge file, say): fail what was
      // waiting and start a fresh one next time.
      e.preventDefault()
      for (const pending of this.pending.values()) {
        pending.reject(new Error(e.message || 'The database stopped working'))
      }
      this.pending.clear()
      worker.terminate()
      this.worker = null
      this.name = ''
    }
    this.worker = worker
    return worker
  }
}

/** `window.electronAPI.database` for the browser, backed by the worker. */
export function webDatabaseApi(client: DatabaseClient, pickFiles: () => Promise<string | null>, filesFor: (token: string) => File[] | undefined) {
  // Until something is open, answer from here instead of starting the worker.
  const ifOpen = <T>(fallback: T, query: () => Promise<T>): Promise<T> =>
    client.name ? query() : Promise.resolve(fallback)

  return {
    openFileDialog: pickFiles,
    open: async (token: string) => {
      const files = filesFor(token)
      if (!files) return { success: false, error: 'The file is no longer available' }
      try {
        const result = await client.call('open', files)
        client.name = result.name
        return { success: true, ...result }
      } catch (err) {
        client.name = ''
        return { success: false, error: (err as Error).message }
      }
    },
    search: (params: SearchParams) => ifOpen(NO_GAMES, () => client.call('search', params)),
    getGame: (id: number) => ifOpen(null, () => client.call('getGame', id)),
    getOpeningStats: (fen: string) =>
      ifOpen({ total: 0, whiteWins: 0, draws: 0, blackWins: 0, moves: [] }, () =>
        client.call('positionStats', fen)
      ),
    positionGames: (params: { fen: string; limit?: number; offset?: number }) =>
      ifOpen(NO_GAMES, () => client.call('positionGames', params)),
    addGame: async (pgn: string) => {
      try {
        const id = await ifOpen(-1, () => client.call('addGame', pgn))
        return { success: id >= 0, id }
      } catch (err) {
        return { success: false, id: -1, error: (err as Error).message }
      }
    },
    deleteGame: async (id: number) => {
      try {
        await ifOpen(undefined, () => client.call('deleteGame', id))
        return { success: true }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
    playerSuggest: (prefix: string) => ifOpen([], () => client.call('playerSuggest', prefix)),
    onImportProgress: (callback: (data: { count: number }) => void) => client.onProgress(callback)
  }
}
