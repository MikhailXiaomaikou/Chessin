import { BrowserWindow } from 'electron'
import { UciEngine } from './UciEngine'
import type { EngineConfig, UciInfo, UciBestMove, UciOption, GoParams } from './types'
import { IPC } from '../../shared/ipc-channels'

interface ManagedEngine {
  engine: UciEngine
  config: EngineConfig
  options: UciOption[]
}

export class EngineManager {
  private engines: Map<string, ManagedEngine> = new Map()
  private static instance: EngineManager | null = null

  static getInstance(): EngineManager {
    if (!EngineManager.instance) {
      EngineManager.instance = new EngineManager()
    }
    return EngineManager.instance
  }

  private getWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
  }

  private sendToRenderer(channel: string, data: unknown): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, data)
    }
  }

  async addEngine(id: string, path: string): Promise<{
    identity: { name: string; author: string }
    options: UciOption[]
  }> {
    // Remove existing engine with same ID
    if (this.engines.has(id)) {
      await this.removeEngine(id)
    }

    const engine = new UciEngine(path)
    const { identity, options } = await engine.init()
    await engine.waitReady()

    const config: EngineConfig = {
      id,
      name: identity.name,
      path,
      options: {}
    }

    // Set up event handlers
    engine.on('info', (info: UciInfo) => {
      this.sendToRenderer(IPC.ENGINE_OUTPUT, {
        engineId: id,
        type: 'info',
        info
      })
    })

    engine.on('bestmove', (bestmove: UciBestMove) => {
      this.sendToRenderer(IPC.ENGINE_OUTPUT, {
        engineId: id,
        type: 'bestmove',
        bestmove
      })
    })

    engine.on('error', (err: Error) => {
      console.error(`Engine ${id} error:`, err.message)
    })

    engine.on('exit', () => {
      console.log(`Engine ${id} exited`)
      this.engines.delete(id)
    })

    this.engines.set(id, { engine, config, options })

    return { identity, options }
  }

  async removeEngine(id: string): Promise<void> {
    const managed = this.engines.get(id)
    if (!managed) return

    managed.engine.stop()
    managed.engine.quit()
    managed.engine.removeAllListeners()
    this.engines.delete(id)
  }

  startAnalysis(
    engineId: string,
    fen: string,
    moves: string[],
    params: GoParams
  ): void {
    const managed = this.engines.get(engineId)
    if (!managed) return

    managed.engine.stop()
    managed.engine.setPosition(fen, moves)
    managed.engine.go(params)
  }

  stopAnalysis(engineId: string): void {
    const managed = this.engines.get(engineId)
    if (!managed) return
    managed.engine.stop()
  }

  setOption(engineId: string, name: string, value: string | number | boolean): void {
    const managed = this.engines.get(engineId)
    if (!managed) return

    managed.engine.setOption(name, value)
    managed.config.options[name] = value
  }

  getOptions(engineId: string): UciOption[] {
    const managed = this.engines.get(engineId)
    if (!managed) return []
    return managed.options
  }

  getEngineInfo(engineId: string): { config: EngineConfig; options: UciOption[] } | null {
    const managed = this.engines.get(engineId)
    if (!managed) return null
    return { config: managed.config, options: managed.options }
  }

  getAllEngineIds(): string[] {
    return Array.from(this.engines.keys())
  }

  newGame(engineId: string): void {
    const managed = this.engines.get(engineId)
    if (!managed) return
    managed.engine.newGame()
  }

  shutdownAll(): void {
    for (const [id] of this.engines) {
      this.removeEngine(id)
    }
  }
}
