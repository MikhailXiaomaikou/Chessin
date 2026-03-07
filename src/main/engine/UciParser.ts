import type { UciInfo, UciBestMove, UciOption, EngineIdentity } from './types'

export type ParsedLine =
  | { type: 'info'; data: UciInfo }
  | { type: 'bestmove'; data: UciBestMove }
  | { type: 'uciok' }
  | { type: 'readyok' }
  | { type: 'id'; data: Partial<EngineIdentity> }
  | { type: 'option'; data: UciOption }

export function parseLine(line: string): ParsedLine | null {
  if (!line || line.length === 0) return null

  const trimmed = line.trim()

  if (trimmed === 'uciok') return { type: 'uciok' }
  if (trimmed === 'readyok') return { type: 'readyok' }

  if (trimmed.startsWith('id ')) {
    return parseId(trimmed)
  }

  if (trimmed.startsWith('option ')) {
    return parseOption(trimmed)
  }

  if (trimmed.startsWith('info ')) {
    return parseInfo(trimmed)
  }

  if (trimmed.startsWith('bestmove ')) {
    return parseBestMove(trimmed)
  }

  return null
}

function parseId(line: string): ParsedLine {
  if (line.startsWith('id name ')) {
    return { type: 'id', data: { name: line.slice(8) } }
  }
  if (line.startsWith('id author ')) {
    return { type: 'id', data: { author: line.slice(10) } }
  }
  return { type: 'id', data: {} }
}

function parseOption(line: string): ParsedLine {
  const option: UciOption = { name: '', type: 'string' }

  const nameMatch = line.match(/option name (.+?) type (\w+)/)
  if (!nameMatch) return { type: 'option', data: option }

  option.name = nameMatch[1]
  option.type = nameMatch[2] as UciOption['type']

  const rest = line.slice(nameMatch.index! + nameMatch[0].length)

  const defaultMatch = rest.match(/\s+default\s+(.+?)(?:\s+min\s|\s+max\s|\s+var\s|$)/)
  if (defaultMatch) {
    const val = defaultMatch[1].trim()
    if (option.type === 'check') {
      option.default = val === 'true'
    } else if (option.type === 'spin') {
      option.default = parseInt(val, 10)
    } else {
      option.default = val
    }
  }

  if (option.type === 'spin') {
    const minMatch = rest.match(/\s+min\s+(-?\d+)/)
    const maxMatch = rest.match(/\s+max\s+(-?\d+)/)
    if (minMatch) option.min = parseInt(minMatch[1], 10)
    if (maxMatch) option.max = parseInt(maxMatch[1], 10)
  }

  if (option.type === 'combo') {
    const vars: string[] = []
    const varRegex = /\s+var\s+(.+?)(?=\s+var\s|$)/g
    let match
    while ((match = varRegex.exec(rest)) !== null) {
      vars.push(match[1].trim())
    }
    option.vars = vars
  }

  return { type: 'option', data: option }
}

function parseInfo(line: string): ParsedLine | null {
  // Skip string-only info lines (like "info string ...")
  if (line.startsWith('info string')) {
    return null
  }

  const tokens = line.split(/\s+/)
  const info: UciInfo = {
    depth: 0,
    multipv: 1,
    score: { type: 'cp', value: 0 },
    pv: []
  }

  let i = 1 // Skip 'info'
  while (i < tokens.length) {
    switch (tokens[i]) {
      case 'depth':
        info.depth = parseInt(tokens[++i], 10)
        break
      case 'seldepth':
        info.seldepth = parseInt(tokens[++i], 10)
        break
      case 'multipv':
        info.multipv = parseInt(tokens[++i], 10)
        break
      case 'score':
        i++
        if (tokens[i] === 'cp') {
          info.score = { type: 'cp', value: parseInt(tokens[++i], 10) }
        } else if (tokens[i] === 'mate') {
          info.score = { type: 'mate', value: parseInt(tokens[++i], 10) }
        }
        // Skip lowerbound/upperbound markers
        if (i + 1 < tokens.length && (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound')) {
          i++
        }
        break
      case 'nodes':
        info.nodes = parseInt(tokens[++i], 10)
        break
      case 'nps':
        info.nps = parseInt(tokens[++i], 10)
        break
      case 'time':
        info.time = parseInt(tokens[++i], 10)
        break
      case 'hashfull':
        info.hashfull = parseInt(tokens[++i], 10)
        break
      case 'tbhits':
        info.tbhits = parseInt(tokens[++i], 10)
        break
      case 'wdl':
        info.wdl = [
          parseInt(tokens[++i], 10),
          parseInt(tokens[++i], 10),
          parseInt(tokens[++i], 10)
        ]
        break
      case 'pv':
        // Everything after 'pv' is the principal variation
        info.pv = tokens.slice(i + 1)
        i = tokens.length // Exit loop
        break
      default:
        break
    }
    i++
  }

  // Only return info with meaningful data (has depth)
  if (info.depth === 0 && info.pv.length === 0) return null

  return { type: 'info', data: info }
}

function parseBestMove(line: string): ParsedLine {
  const tokens = line.split(/\s+/)
  const result: UciBestMove = {
    bestmove: tokens[1]
  }
  if (tokens[2] === 'ponder' && tokens[3]) {
    result.ponder = tokens[3]
  }
  return { type: 'bestmove', data: result }
}
