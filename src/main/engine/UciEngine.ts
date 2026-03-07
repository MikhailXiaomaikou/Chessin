import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { parseLine, type ParsedLine } from './UciParser'
import type { UciOption, GoParams, EngineIdentity } from './types'

export class UciEngine extends EventEmitter {
  private process: ChildProcess | null = null
  private buffer = ''
  public identity: EngineIdentity = { name: 'Unknown', author: 'Unknown' }
  public options: UciOption[] = []
  public isReady = false
  private _isAnalyzing = false

  constructor(private executablePath: string) {
    super()
  }

  get isAnalyzing(): boolean {
    return this._isAnalyzing
  }

  async init(): Promise<{ identity: EngineIdentity; options: UciOption[] }> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.executablePath, [], {
          stdio: ['pipe', 'pipe', 'pipe']
        })

        this.process.on('error', (err) => {
          this.emit('error', err)
          reject(err)
        })

        this.process.on('exit', (code) => {
          this.emit('exit', code)
          this.process = null
          this._isAnalyzing = false
        })

        this.process.stderr?.on('data', (data: Buffer) => {
          // Some engines output debug info to stderr
          this.emit('stderr', data.toString())
        })

        this.process.stdout?.on('data', (data: Buffer) => {
          this.handleData(data.toString())
        })

        // Wait for uciok
        const timeout = setTimeout(() => {
          reject(new Error('Engine initialization timeout'))
        }, 10000)

        this.once('uciok', () => {
          clearTimeout(timeout)
          resolve({ identity: this.identity, options: this.options })
        })

        this.send('uci')
      } catch (err) {
        reject(err)
      }
    })
  }

  async waitReady(): Promise<void> {
    return new Promise((resolve) => {
      this.once('readyok', () => {
        this.isReady = true
        resolve()
      })
      this.send('isready')
    })
  }

  setOption(name: string, value: string | number | boolean): void {
    this.send(`setoption name ${name} value ${value}`)
  }

  setPosition(fen: string, moves?: string[]): void {
    let cmd = `position fen ${fen}`
    if (moves && moves.length > 0) {
      cmd += ` moves ${moves.join(' ')}`
    }
    this.send(cmd)
  }

  go(params: GoParams): void {
    this._isAnalyzing = true
    const parts = ['go']

    if (params.infinite) {
      parts.push('infinite')
    } else {
      if (params.depth !== undefined) parts.push('depth', String(params.depth))
      if (params.movetime !== undefined) parts.push('movetime', String(params.movetime))
      if (params.wtime !== undefined) parts.push('wtime', String(params.wtime))
      if (params.btime !== undefined) parts.push('btime', String(params.btime))
      if (params.winc !== undefined) parts.push('winc', String(params.winc))
      if (params.binc !== undefined) parts.push('binc', String(params.binc))
      if (params.movestogo !== undefined) parts.push('movestogo', String(params.movestogo))
      if (params.nodes !== undefined) parts.push('nodes', String(params.nodes))
    }

    if (params.searchmoves && params.searchmoves.length > 0) {
      parts.push('searchmoves', ...params.searchmoves)
    }

    this.send(parts.join(' '))
  }

  stop(): void {
    if (this._isAnalyzing) {
      this.send('stop')
      this._isAnalyzing = false
    }
  }

  quit(): void {
    this._isAnalyzing = false
    this.send('quit')
    setTimeout(() => {
      if (this.process) {
        this.process.kill()
        this.process = null
      }
    }, 500)
  }

  newGame(): void {
    this.send('ucinewgame')
  }

  private send(command: string): void {
    if (!this.process?.stdin?.writable) return
    this.process.stdin.write(command + '\n')
  }

  private handleData(data: string): void {
    this.buffer += data
    const lines = this.buffer.split('\n')
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const parsed = parseLine(trimmed)
      if (!parsed) continue

      this.handleParsed(parsed)
    }
  }

  private handleParsed(parsed: ParsedLine): void {
    switch (parsed.type) {
      case 'uciok':
        this.emit('uciok')
        break
      case 'readyok':
        this.emit('readyok')
        break
      case 'id':
        if (parsed.data.name) this.identity.name = parsed.data.name
        if (parsed.data.author) this.identity.author = parsed.data.author
        break
      case 'option':
        this.options.push(parsed.data)
        break
      case 'info':
        this.emit('info', parsed.data)
        break
      case 'bestmove':
        this._isAnalyzing = false
        this.emit('bestmove', parsed.data)
        break
    }
  }
}
