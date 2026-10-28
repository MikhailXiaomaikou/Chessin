import { contextBridge, ipcRenderer, clipboard } from 'electron'
import { IPC } from '../shared/ipc-channels'

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
      ignoreColors?: boolean
      result?: string
      eco?: string
      event?: string
      dateFrom?: string
      dateTo?: string
      minElo?: number
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(IPC.DATABASE_SEARCH, params),
    getGame: (id: number) =>
      ipcRenderer.invoke(IPC.DATABASE_GET_GAME, id),
    getOpeningStats: (fen: string) =>
      ipcRenderer.invoke(IPC.DATABASE_GET_OPENING_STATS, fen),
    positionGames: (params: { fen: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke(IPC.DATABASE_POSITION_GAMES, params),
    addGame: (pgn: string) =>
      ipcRenderer.invoke(IPC.DATABASE_ADD_GAME, pgn),
    deleteGame: (id: number) =>
      ipcRenderer.invoke(IPC.DATABASE_DELETE_GAME, id),
    playerSuggest: (prefix: string) =>
      ipcRenderer.invoke(IPC.DATABASE_PLAYER_SUGGEST, prefix),
    onImportProgress: (callback: (data: { count: number }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { count: number }): void =>
        callback(data)
      ipcRenderer.on(IPC.DATABASE_IMPORT_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.DATABASE_IMPORT_PROGRESS, handler)
    }
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
