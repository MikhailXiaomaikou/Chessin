// Bridge between the app's engine API and Stockfish WASM running in a Web Worker.
// Each "engine" instance maps to a separate Worker.

type OutputCallback = (data: {
  engineId: string
  type: 'info' | 'bestmove'
  info?: unknown
  bestmove?: unknown
}) => void

interface EngineInstance {
  id: string
  worker: Worker
  ready: boolean
}

const engines = new Map<string, EngineInstance>()
const outputListeners = new Set<OutputCallback>()

// Parse a single UCI "info" line into a structured object
function parseInfoLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('info ')) return null

  const tokens = line.split(/\s+/)
  const info: Record<string, unknown> = {}
  let i = 1 // skip 'info'

  while (i < tokens.length) {
    const key = tokens[i]
    switch (key) {
      case 'depth':
        info.depth = parseInt(tokens[++i])
        break
      case 'seldepth':
        info.seldepth = parseInt(tokens[++i])
        break
      case 'multipv':
        info.multipv = parseInt(tokens[++i])
        break
      case 'score': {
        const scoreType = tokens[++i] as 'cp' | 'mate'
        const scoreValue = parseInt(tokens[++i])
        info.score = { type: scoreType, value: scoreValue }
        break
      }
      case 'nodes':
        info.nodes = parseInt(tokens[++i])
        break
      case 'nps':
        info.nps = parseInt(tokens[++i])
        break
      case 'time':
        info.time = parseInt(tokens[++i])
        break
      case 'hashfull':
        info.hashfull = parseInt(tokens[++i])
        break
      case 'pv': {
        const pv: string[] = []
        i++
        while (i < tokens.length && !['info', 'bestmove'].includes(tokens[i])) {
          pv.push(tokens[i])
          i++
        }
        info.pv = pv
        i-- // will be incremented at end of loop
        break
      }
      case 'wdl': {
        const w = parseInt(tokens[++i])
        const d = parseInt(tokens[++i])
        const l = parseInt(tokens[++i])
        info.wdl = [w, d, l]
        break
      }
      default:
        break
    }
    i++
  }

  // Only emit if we have essential fields
  if (info.depth !== undefined && info.score && info.pv) {
    if (info.multipv === undefined) info.multipv = 1
    return info
  }
  return null
}

function parseBestmove(line: string): { move: string; ponder?: string } | null {
  const match = line.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/)
  if (!match) return null
  return { move: match[1], ponder: match[2] }
}

function emitOutput(engineId: string, line: string) {
  const info = parseInfoLine(line)
  if (info) {
    const data = { engineId, type: 'info' as const, info }
    outputListeners.forEach((cb) => cb(data))
    return
  }

  const bm = parseBestmove(line)
  if (bm) {
    const data = { engineId, type: 'bestmove' as const, bestmove: bm }
    outputListeners.forEach((cb) => cb(data))
  }
}

function createWorkerFromUrl(wasmJsUrl: string): Worker {
  // Create a worker that loads stockfish.wasm.js
  const workerCode = `importScripts("${wasmJsUrl}");`
  const blob = new Blob([workerCode], { type: 'application/javascript' })
  return new Worker(URL.createObjectURL(blob))
}

// Detect the base URL for stockfish files
function getStockfishUrl(): string {
  // In Capacitor/Android, files are served from the assets directory
  // In web, from the public directory
  const base = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
    ? '.'
    : ''
  return `${base}/stockfish/stockfish.wasm.js`
}

export const stockfishBridge = {
  add: async (id: string, _path: string): Promise<{
    success: boolean
    identity: { name: string; author: string }
    options: { name: string; type: string; default?: unknown; min?: number; max?: number }[]
  }> => {
    try {
      const worker = createWorkerFromUrl(getStockfishUrl())

      const engine: EngineInstance = { id, worker, ready: false }
      engines.set(id, engine)

      // Listen for messages from the worker
      worker.onmessage = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : ''
        if (line === 'uciok') {
          engine.ready = true
        }
        emitOutput(id, line)
      }

      // Initialize UCI
      worker.postMessage('uci')

      // Wait for uciok
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (engine.ready) {
            clearInterval(check)
            resolve()
          }
        }, 50)
        setTimeout(() => { clearInterval(check); resolve() }, 5000)
      })

      worker.postMessage('isready')

      return {
        success: true,
        identity: { name: 'Stockfish WASM', author: 'T. Romstad, M. Costalba, J. Kiiski, G. Linscott' },
        options: [
          { name: 'MultiPV', type: 'spin', default: 1, min: 1, max: 500 },
          { name: 'Threads', type: 'spin', default: 1, min: 1, max: 1 },
          { name: 'Hash', type: 'spin', default: 16, min: 1, max: 128 },
          { name: 'UCI_ShowWDL', type: 'check', default: false }
        ]
      }
    } catch (err) {
      return {
        success: false,
        identity: { name: '', author: '' },
        options: []
      }
    }
  },

  remove: async (engineId: string) => {
    const engine = engines.get(engineId)
    if (engine) {
      engine.worker.postMessage('quit')
      engine.worker.terminate()
      engines.delete(engineId)
    }
    return { success: true }
  },

  startAnalysis: async (params: {
    engineId: string
    fen: string
    moves: string[]
    params: { infinite?: boolean; depth?: number; movetime?: number }
  }) => {
    const engine = engines.get(params.engineId)
    if (!engine) return { success: false }

    // Stop any current analysis
    engine.worker.postMessage('stop')

    // Set position
    let posCmd = `position fen ${params.fen}`
    if (params.moves.length > 0) {
      posCmd += ` moves ${params.moves.join(' ')}`
    }
    engine.worker.postMessage(posCmd)

    // Start search
    let goCmd = 'go'
    if (params.params.infinite) goCmd += ' infinite'
    if (params.params.depth) goCmd += ` depth ${params.params.depth}`
    if (params.params.movetime) goCmd += ` movetime ${params.params.movetime}`
    engine.worker.postMessage(goCmd)

    return { success: true }
  },

  stopAnalysis: async (engineId: string) => {
    const engine = engines.get(engineId)
    if (engine) {
      engine.worker.postMessage('stop')
    }
    return { success: true }
  },

  setOption: async (engineId: string, name: string, value: string | number | boolean) => {
    const engine = engines.get(engineId)
    if (engine) {
      engine.worker.postMessage(`setoption name ${name} value ${value}`)
    }
    return { success: true }
  },

  getOptions: async (_engineId: string) => {
    return [
      { name: 'MultiPV', type: 'spin', default: 1, min: 1, max: 500 },
      { name: 'Threads', type: 'spin', default: 1, min: 1, max: 1 },
      { name: 'Hash', type: 'spin', default: 16, min: 1, max: 128 },
      { name: 'UCI_ShowWDL', type: 'check', default: false }
    ]
  },

  onOutput: (callback: OutputCallback): (() => void) => {
    outputListeners.add(callback)
    return () => outputListeners.delete(callback)
  }
}
