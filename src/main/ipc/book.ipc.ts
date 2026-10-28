import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'
import { PolyglotBook, BOOK_ENTRY_SIZE } from '../../shared/chess/polyglotBook'
import { DatabaseManager } from '../database/DatabaseManager'
import type { BookExportOptions } from '../../shared/database/GameDatabase'
import { IPC } from '../../shared/ipc-channels'

let book: PolyglotBook | null = null

export function registerBookIpc(): void {
  ipcMain.handle(IPC.BOOK_OPEN_DIALOG, async () => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Open Opening Book',
      properties: ['openFile'],
      filters: [
        { name: 'Polyglot Books', extensions: ['bin'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.BOOK_LOAD, async (_, filePath: string) => {
    try {
      const data = await readFile(filePath)
      if (data.byteLength === 0 || data.byteLength % BOOK_ENTRY_SIZE !== 0) {
        throw new Error('Not a Polyglot book (size must be a multiple of 16 bytes)')
      }
      book = new PolyglotBook(data)
      return { success: true, name: basename(filePath), entries: book.entryCount }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.BOOK_LOOKUP, async (_, fen: string) => (book ? book.lookup(fen) : []))

  ipcMain.handle(IPC.BOOK_CLOSE, async () => {
    book = null
    return { success: true }
  })

  // Build a book from the open database and save it where the user chooses.
  ipcMain.handle(IPC.BOOK_EXPORT, async (_, opts?: BookExportOptions) => {
    const manager = DatabaseManager.getInstance()
    if (manager.getGameCount() === 0) return { success: false, error: 'No database open' }
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return { success: false, error: 'No window' }

    const stem = manager.getName().replace(/\.[^.]+$/, '') || 'book'
    const result = await dialog.showSaveDialog(window, {
      title: 'Export Opening Book',
      defaultPath: `${stem}.bin`,
      filters: [{ name: 'Polyglot Books', extensions: ['bin'] }]
    })
    if (result.canceled || !result.filePath) return { success: false, canceled: true }

    try {
      const data = manager.exportPolyglotBook(opts)
      if (!data) return { success: false, error: 'No database open' }
      await writeFile(result.filePath, data)
      return { success: true, path: result.filePath, entries: data.byteLength / BOOK_ENTRY_SIZE }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
