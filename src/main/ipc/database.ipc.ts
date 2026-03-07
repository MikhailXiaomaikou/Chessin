import { ipcMain, dialog, BrowserWindow } from 'electron'
import { DatabaseManager } from '../database/DatabaseManager'
import { IPC } from '../../shared/ipc-channels'
import { readFile } from 'fs/promises'

export function registerDatabaseIpc(): void {
  const manager = DatabaseManager.getInstance()

  ipcMain.handle(IPC.FILE_OPEN_DATABASE, async () => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Open Database',
      properties: ['openFile'],
      filters: [
        { name: 'Chess Databases', extensions: ['pgn', 'cbh', 'cbv'] },
        { name: 'PGN Files', extensions: ['pgn'] },
        { name: 'ChessBase Files', extensions: ['cbh', 'cbv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.DATABASE_OPEN, async (_, filePath: string) => {
    try {
      const count = await manager.openDatabase(filePath)
      return { success: true, count }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.DATABASE_SEARCH, async (_, params) => {
    return manager.search(params)
  })

  ipcMain.handle(IPC.DATABASE_GET_GAME, async (_, index: number) => {
    const game = manager.getGame(index)
    if (!game) return null

    // Also include PGN if available
    const pgn = manager.getGamePgn(index)
    return { ...game, pgn }
  })

  ipcMain.handle(IPC.DATABASE_GET_OPENING_STATS, async (_, fen: string) => {
    return manager.getOpeningStats(fen)
  })

  // Read PGN file content (for loading into game)
  ipcMain.handle(IPC.FILE_OPEN_PGN + ':read', async (_, filePath: string) => {
    try {
      const content = await readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
