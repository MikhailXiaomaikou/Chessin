import type { IndexCache } from './host'

const DB_NAME = 'chessin-db-cache'
const INDEXES = 'indexes' // key -> { key, bytes }
const RECENT = 'recent' // key -> { key, name, usedAt }; small, for eviction
const KEEP = 3

interface RecentEntry {
  key: string
  name: string
  usedAt: number
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(INDEXES, { keyPath: 'key' })
      req.result.createObjectStore(RECENT, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Imported indexes kept in IndexedDB, so opening the same file again skips the
 * import — what the desktop app's cache directory does. The last few are kept.
 * Best effort: when storage fails or is full, the file is just imported again.
 */
export function idbIndexCache(): IndexCache {
  let db: Promise<IDBDatabase> | null = null
  const store = () => (db ??= openStore())

  return {
    async load(key) {
      try {
        const tx = (await store()).transaction([INDEXES, RECENT], 'readwrite')
        const entry = (await done(tx.objectStore(INDEXES).get(key))) as
          | { bytes: Uint8Array }
          | undefined
        if (!entry) return null
        const recent = (await done(tx.objectStore(RECENT).get(key))) as RecentEntry | undefined
        if (recent) tx.objectStore(RECENT).put({ ...recent, usedAt: Date.now() })
        await committed(tx)
        return entry.bytes
      } catch {
        return null
      }
    },

    async save(key, name, bytes) {
      try {
        const tx = (await store()).transaction([INDEXES, RECENT], 'readwrite')
        tx.objectStore(INDEXES).put({ key, bytes })
        tx.objectStore(RECENT).put({ key, name, usedAt: Date.now() } satisfies RecentEntry)
        const recent = (await done(tx.objectStore(RECENT).getAll())) as RecentEntry[]
        recent.sort((a, b) => b.usedAt - a.usedAt)
        for (const old of recent.slice(KEEP)) {
          tx.objectStore(INDEXES).delete(old.key)
          tx.objectStore(RECENT).delete(old.key)
        }
        await committed(tx)
      } catch {
        // Quota or private mode: the next open imports again.
      }
    }
  }
}
