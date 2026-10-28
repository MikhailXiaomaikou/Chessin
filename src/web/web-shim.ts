// Web/Android compatibility shim for window.electronAPI
// This replaces Electron IPC with browser-compatible implementations.

import { stockfishBridge } from './stockfish-worker-bridge'
import { PolyglotBook, BOOK_ENTRY_SIZE } from '../shared/chess/polyglotBook'
import { TablebaseClient } from '../shared/chess/tablebase'
import { DatabaseClient, webDatabaseApi } from './database/client'

const tablebaseClient = new TablebaseClient()

// Game databases run in a worker on SQLite compiled to WebAssembly.
const databaseClient = new DatabaseClient()
const pickedDatabases = new Map<string, File[]>()

/** Asks for a PGN, or a ChessBase database's files (.cbh, .cbg, .cba...) together. */
function pickDatabaseFiles(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.pgn,.cbh,.cbg,.cba,.cbp,.cbt,.cbc,.cbs,.cbv'
    input.onchange = () => {
      const files = [...(input.files ?? [])]
      if (files.length === 0) return resolve(null)
      const main = files.find((f) => /\.(pgn|cbh)$/i.test(f.name)) ?? files[0]
      pickedDatabases.set(main.name, files)
      resolve(main.name)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Opening books work fully in the browser: the reader is plain TypeScript.
let webBook: PolyglotBook | null = null
const pickedBooks = new Map<string, Uint8Array>()

function pickBookFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.bin'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      pickedBooks.set(file.name, new Uint8Array(await file.arrayBuffer()))
      resolve(file.name)
    }
    input.click()
  })
}

export function installWebShim() {
  // Only install if electronAPI is not already provided (i.e., not in Electron)
  if (window.electronAPI) return

  ;(window as any).electronAPI = {
    platform: 'web',

    file: {
      selectEngine: async (): Promise<string | null> => {
        // On web/Android, we use the built-in Stockfish WASM
        // Return a sentinel path that the engine.add handler recognizes
        return '__stockfish_wasm__'
      },
      openPgn: async (): Promise<string | null> => {
        return new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.pgn'
          input.onchange = async () => {
            const file = input.files?.[0]
            if (file) {
              resolve(file.name)
              // Store the file content for readFile
              const text = await file.text()
              ;(window as any).__lastOpenedFile = { path: file.name, content: text }
            } else {
              resolve(null)
            }
          }
          input.click()
        })
      },
      readFile: async (filePath: string): Promise<string | null> => {
        const cached = (window as any).__lastOpenedFile
        if (cached && cached.path === filePath) {
          return cached.content
        }
        return null
      },
      savePgn: async (content: string): Promise<string | null> => {
        const blob = new Blob([content], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'game.pgn'
        a.click()
        URL.revokeObjectURL(url)
        return 'game.pgn'
      }
    },

    engine: stockfishBridge,

    database: webDatabaseApi(databaseClient, pickDatabaseFiles, (token) =>
      pickedDatabases.get(token)
    ),

    book: {
      openFileDialog: pickBookFile,
      load: async (name: string) => {
        const bytes = pickedBooks.get(name)
        if (!bytes) return { success: false, error: 'Book file is no longer available' }
        if (bytes.byteLength === 0 || bytes.byteLength % BOOK_ENTRY_SIZE !== 0) {
          return { success: false, error: 'Not a Polyglot book' }
        }
        webBook = new PolyglotBook(bytes)
        return { success: true, name, entries: webBook.entryCount }
      },
      lookup: async (fen: string) => (webBook ? webBook.lookup(fen) : []),
      close: async () => {
        webBook = null
        return { success: true }
      },
      exportFromDatabase: async () => {
        if (!databaseClient.name) return { success: false, error: 'No database open' }
        try {
          const bytes = await databaseClient.call('exportBook')
          if (!bytes) return { success: false, error: 'No database open' }
          const fileName = `${databaseClient.name.replace(/\.[^.]+$/, '') || 'book'}.bin`
          downloadBytes(bytes, fileName)
          return { success: true, path: fileName, entries: bytes.byteLength / BOOK_ENTRY_SIZE }
        } catch (err) {
          return { success: false, error: (err as Error).message }
        }
      }
    },

    tablebase: {
      probe: (fen: string) => tablebaseClient.probeSafe(fen)
    },

    clipboard: {
      writeText: (text: string) => {
        navigator.clipboard.writeText(text).catch(() => {
          // Fallback for older browsers
          const textarea = document.createElement('textarea')
          textarea.value = text
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          document.execCommand('copy')
          document.body.removeChild(textarea)
        })
      }
    },

    onMenuEvent: (_channel: string, _callback: () => void) => {
      // No menu events on web/Android
      return () => {}
    }
  }
}
