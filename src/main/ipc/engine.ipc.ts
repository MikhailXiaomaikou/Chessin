import { ipcMain } from 'electron'
import { EngineManager } from '../engine/EngineManager'
import { IPC } from '../../shared/ipc-channels'
import type { GoParams } from '../engine/types'

export function registerEngineIpc(): void {
  const manager = EngineManager.getInstance()

  ipcMain.handle(
    IPC.ENGINE_ADD,
    async (_, { id, path }: { id: string; path: string }) => {
      try {
        const result = await manager.addEngine(id, path)
        return { success: true, ...result }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(IPC.ENGINE_REMOVE, async (_, engineId: string) => {
    await manager.removeEngine(engineId)
    return { success: true }
  })

  ipcMain.handle(
    IPC.ENGINE_START_ANALYSIS,
    async (
      _,
      {
        engineId,
        fen,
        moves,
        params
      }: {
        engineId: string
        fen: string
        moves: string[]
        params: GoParams
      }
    ) => {
      manager.startAnalysis(engineId, fen, moves, params)
      return { success: true }
    }
  )

  ipcMain.handle(IPC.ENGINE_STOP_ANALYSIS, async (_, engineId: string) => {
    manager.stopAnalysis(engineId)
    return { success: true }
  })

  ipcMain.handle(
    IPC.ENGINE_SET_OPTION,
    async (
      _,
      {
        engineId,
        name,
        value
      }: {
        engineId: string
        name: string
        value: string | number | boolean
      }
    ) => {
      manager.setOption(engineId, name, value)
      return { success: true }
    }
  )

  ipcMain.handle(IPC.ENGINE_GET_OPTIONS, async (_, engineId: string) => {
    return manager.getOptions(engineId)
  })
}
