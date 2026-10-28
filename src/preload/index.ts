import { contextBridge, ipcRenderer, clipboard } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { LlmChatRequest, LlmChatResponse } from '../shared/llm/types'

const electronAPI = {
  platform: process.platform,

  file: {
    selectEngine: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.FILE_SELECT_ENGINE),
    openPgn: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.FILE_OPEN_PGN),
    readFile: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.FILE_READ, filePath),
    savePgn: (content: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.FILE_SAVE_PGN, content)
  },

  engine: {
    add: (id: string, path: string) =>
      ipcRenderer.invoke(IPC.ENGINE_ADD, { id, path }),
    remove: (engineId: string) =>
      ipcRenderer.invoke(IPC.ENGINE_REMOVE, engineId),
    startAnalysis: (params: {
      engineId: string
      fen: string
      moves: string[]
      params: { infinite?: boolean; depth?: number; movetime?: number }
    }) => ipcRenderer.invoke(IPC.ENGINE_START_ANALYSIS, params),
    stopAnalysis: (engineId: string) =>
      ipcRenderer.invoke(IPC.ENGINE_STOP_ANALYSIS, engineId),
    setOption: (engineId: string, name: string, value: string | number | boolean) =>
      ipcRenderer.invoke(IPC.ENGINE_SET_OPTION, { engineId, name, value }),
    getOptions: (engineId: string) =>
      ipcRenderer.invoke(IPC.ENGINE_GET_OPTIONS, engineId),
    onOutput: (
      callback: (data: {
        engineId: string
        type: 'info' | 'bestmove'
        info?: unknown
        bestmove?: unknown
      }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: Parameters<typeof callback>[0]
      ): void => callback(data)
      ipcRenderer.on(IPC.ENGINE_OUTPUT, handler)
      return () => ipcRenderer.removeListener(IPC.ENGINE_OUTPUT, handler)
    }
  },

  database: {
    openFileDialog: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.FILE_OPEN_DATABASE),
    open: (filePath: string) =>
      ipcRenderer.invoke(IPC.DATABASE_OPEN, filePath),
    search: (params: {
      white?: string
      black?: string
      result?: string
      eco?: string
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(IPC.DATABASE_SEARCH, params),
    getGame: (index: number) =>
      ipcRenderer.invoke(IPC.DATABASE_GET_GAME, index),
    getOpeningStats: (fen: string) =>
      ipcRenderer.invoke(IPC.DATABASE_GET_OPENING_STATS, fen)
  },

  llm: {
    chat: (req: LlmChatRequest): Promise<LlmChatResponse> =>
      ipcRenderer.invoke(IPC.LLM_CHAT, req)
  },

  clipboard: {
    writeText: (text: string): void => clipboard.writeText(text)
  },

  onMenuEvent: (channel: string, callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
