import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { registerEngineIpc } from './engine.ipc'
import { registerDatabaseIpc } from './database.ipc'
import { registerLlmIpc } from './llm.ipc'

export function registerIpcHandlers(): void {
  registerEngineIpc()
  registerDatabaseIpc()
  registerLlmIpc()

  // File selection for engine binary
  ipcMain.handle(IPC.FILE_SELECT_ENGINE, async () => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Select Chess Engine',
      properties: ['openFile'],
      filters: [
        { name: 'Executables', extensions: ['exe', ''] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Open PGN file
  ipcMain.handle(IPC.FILE_OPEN_PGN, async () => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      title: 'Open PGN File',
      properties: ['openFile'],
      filters: [
        { name: 'PGN Files', extensions: ['pgn'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Read file content
  ipcMain.handle(IPC.FILE_READ, async (_, filePath: string) => {
    const { readFile } = await import('fs/promises')
    try {
      return await readFile(filePath, 'utf-8')
    } catch {
      return null
    }
  })

  // Save PGN file
  ipcMain.handle(IPC.FILE_SAVE_PGN, async (_, content: string) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showSaveDialog(window, {
      title: 'Save PGN File',
      defaultPath: 'game.pgn',
      filters: [
        { name: 'PGN Files', extensions: ['pgn'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || !result.filePath) return null

    const { writeFile } = await import('fs/promises')
    await writeFile(result.filePath, content, 'utf-8')
    return result.filePath
  })
}
