import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { DatabaseManager } from '../database/DatabaseManager'
import type { DatabaseSearchParams } from '../database/DatabaseManager'
import { IPC } from '../../shared/ipc-channels'
import { readFile } from 'fs/promises'

export function registerDatabaseIpc(): void {
  const manager = DatabaseManager.getInstance()
  manager.setCacheDir(join(app.getPath('userData'), 'db-cache'))

  ipcMain.handle(IPC.FILE_OPEN_DATABASE, async () => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Open Database',
      properties: ['openFile'],
      filters: [
        { name: 'Chess Databases', extensions: ['pgn', 'cbh', 'cbv', 'chessin', 'db'] },
        { name: 'PGN Files', extensions: ['pgn'] },
        { name: 'ChessBase Files', extensions: ['cbh', 'cbv'] },
        { name: 'Chessin Index', extensions: ['chessin', 'db', 'sqlite'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.DATABASE_OPEN, async (event, filePath: string) => {
    try {
      let lastSent = 0
      const result = await manager.openDatabase(filePath, (count) => {
        // The engine already chunks progress; forward it to the renderer.
        if (count !== lastSent) {
          lastSent = count
          event.sender.send(IPC.DATABASE_IMPORT_PROGRESS, { count })
        }
      })
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.DATABASE_SEARCH, async (_, params: DatabaseSearchParams) => {
    return manager.search(params)
  })

  ipcMain.handle(IPC.DATABASE_GET_GAME, async (_, id: number) => {
    const game = manager.getGame(id)
    if (!game) return null
    return { ...game, pgn: manager.getGamePgn(id) }
  })

  ipcMain.handle(IPC.DATABASE_GET_OPENING_STATS, async (_, fen: string) => {
    return manager.positionStats(fen)
  })

  ipcMain.handle(
    IPC.DATABASE_POSITION_GAMES,
    async (_, params: { fen: string; limit?: number; offset?: number }) => {
      return manager.gamesWithPosition(params.fen, params.limit, params.offset)
    }
  )

  ipcMain.handle(IPC.DATABASE_ADD_GAME, async (_, pgn: string) => {
    try {
      const id = manager.addGamePgn(pgn)
      return { success: id >= 0, id }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.DATABASE_DELETE_GAME, async (_, id: number) => {
    try {
      manager.deleteGame(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.DATABASE_PLAYER_SUGGEST, async (_, prefix: string) => {
    return manager.playerSuggestions(prefix)
  })

  // Read PGN file content (for loading into a game)
  ipcMain.handle(IPC.FILE_OPEN_PGN + ':read', async (_, filePath: string) => {
    try {
      const content = await readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
