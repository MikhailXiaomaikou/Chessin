// The browser's game database, off the main thread so a long import never
// freezes the board. Requests come from ./client.ts.
import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'
import { WebDatabaseHost } from './host'
import { BlobSource } from './files'
import { idbIndexCache } from './indexCache'
import type { WorkerRequest, WorkerResponse } from './protocol'

// The worker global, typed without pulling the WebWorker lib into the DOM project.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const host = initSqlJs({ locateFile: () => wasmUrl }).then(
  (SQL) => new WebDatabaseHost(SQL, idbIndexCache(), (blob) => new BlobSource(blob))
)

async function handle(h: WebDatabaseHost, req: WorkerRequest): Promise<unknown> {
  switch (req.method) {
    case 'open':
      return h.open(req.args[0], (count) => scope.postMessage({ progress: count }))
    case 'search':
      return h.search(req.args[0])
    case 'getGame':
      return h.getGame(req.args[0])
    case 'positionStats':
      return h.positionStats(req.args[0])
    case 'positionGames':
      return h.positionGames(req.args[0])
    case 'addGame':
      return h.addGame(req.args[0])
    case 'deleteGame':
      return h.deleteGame(req.args[0])
    case 'playerSuggest':
      return h.playerSuggest(req.args[0])
    case 'exportBook':
      return h.exportBook(req.args[0])
  }
}

// Requests are handled one at a time, in order: an import must finish before
// the queries that follow it run against the new database.
let queue: Promise<void> = Promise.resolve()

scope.onmessage = (e) => {
  const req = e.data
  queue = queue.then(async () => {
    try {
      const result = await handle(await host, req)
      const transfer = result instanceof Uint8Array ? [result.buffer] : []
      scope.postMessage({ id: req.id, result }, transfer)
    } catch (err) {
      scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
