export interface UciOption {
  name: string
  type: 'check' | 'spin' | 'combo' | 'button' | 'string'
  default?: string | number | boolean
  min?: number
  max?: number
  vars?: string[]
  value?: string | number | boolean
}

export interface UciInfo {
  depth: number
  seldepth?: number
  multipv: number
  score: { type: 'cp' | 'mate'; value: number }
  nodes?: number
  nps?: number
  time?: number
  pv: string[]
  wdl?: [number, number, number]
  hashfull?: number
  tbhits?: number
  string?: string
}

export interface UciBestMove {
  bestmove: string
  ponder?: string
}

export interface EngineIdentity {
  name: string
  author: string
}

export interface GoParams {
  infinite?: boolean
  depth?: number
  movetime?: number
  wtime?: number
  btime?: number
  winc?: number
  binc?: number
  movestogo?: number
  nodes?: number
  searchmoves?: string[]
}

export interface EngineConfig {
  id: string
  name: string
  path: string
  options: Record<string, string | number | boolean>
}

export interface EngineOutput {
  engineId: string
  type: 'info' | 'bestmove'
  info?: UciInfo
  bestmove?: UciBestMove
}
