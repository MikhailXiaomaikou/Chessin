import { ipcMain } from 'electron'
import { TablebaseClient } from '../../shared/chess/tablebase'
import { IPC } from '../../shared/ipc-channels'

// Lookups go out from the main process, so the renderer isn't subject to CORS.
const client = new TablebaseClient()

export function registerTablebaseIpc(): void {
  ipcMain.handle(IPC.TABLEBASE_PROBE, (_, fen: string) => client.probeSafe(fen))
}
