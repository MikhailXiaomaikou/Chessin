// Web/Android compatibility shim for window.electronAPI
// This replaces Electron IPC with browser-compatible implementations.

import { stockfishBridge } from './stockfish-worker-bridge'
import { chatWithLlm } from '../shared/llm/client'
import type { LlmChatRequest } from '../shared/llm/types'

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

    database: {
      openFileDialog: async () => null,
      open: async () => ({ success: false, count: 0 }),
      search: async () => [],
      getGame: async () => null,
      getOpeningStats: async () => []
    },

    // No main process here, so LLM requests go straight from the page.
    // OpenAI-compatible servers must allow CORS (for Ollama: OLLAMA_ORIGINS=*).
    llm: {
      chat: (req: LlmChatRequest) => chatWithLlm(req, { browser: true })
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
