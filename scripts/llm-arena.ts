// Headless LLM-vs-LLM games, no GUI needed.
//
//   npm run arena -- arena.json
//
// arena.json:
// {
//   "games": 2,
//   "maxPlies": 300,
//   "out": "arena-games.pgn",
//   "players": [
//     { "name": "Claude", "provider": "anthropic", "model": "claude-opus-5-5", "effort": "medium" },
//     { "name": "DeepSeek", "provider": "openai", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" }
//   ]
// }
//
// apiKey can be set per player, or comes from ANTHROPIC_API_KEY / OPENAI_API_KEY.
// Colors alternate between games. Players are plain chat requests with no tools,
// so they cannot reach Stockfish or any other engine.
import { readFileSync, appendFileSync } from 'node:fs'
import { Chess } from 'chess.js'
import { chatWithLlm } from '../src/shared/llm/client'
import { detectOutcome, requestLlmMove, type GameResult } from '../src/shared/llm/turn'
import type { LlmPlayerConfig } from '../src/shared/llm/types'

interface ArenaFile {
  games?: number
  maxPlies?: number
  out?: string
  quiet?: boolean
  players: Partial<LlmPlayerConfig>[]
}

function toConfig(p: Partial<LlmPlayerConfig>, i: number): LlmPlayerConfig {
  const provider = p.provider ?? 'anthropic'
  return {
    id: `p${i}`,
    name: p.name ?? p.model ?? `Player ${i + 1}`,
    provider,
    model: p.model ?? '',
    apiKey: p.apiKey ?? (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ?? '',
    baseUrl: p.baseUrl,
    effort: p.effort,
    temperature: p.temperature,
    showLegalMoves: p.showLegalMoves ?? true,
    maxRetries: p.maxRetries ?? 2
  }
}

export async function playGame(
  white: LlmPlayerConfig,
  black: LlmPlayerConfig,
  opts: { maxPlies: number; log?: (s: string) => void }
): Promise<{ pgn: string; result: GameResult | '*'; termination: string; illegalAttempts: number }> {
  const startFen = new Chess().fen()
  const sanMoves: string[] = []
  let illegalAttempts = 0
  let result: GameResult | '*' = '*'
  let termination = ''

  for (;;) {
    const chess = new Chess(startFen)
    for (const m of sanMoves) chess.move(m)
    const outcome = detectOutcome(chess, opts.maxPlies)
    if (outcome) {
      result = outcome.result
      termination = outcome.reason
      break
    }
    const side = chess.turn() === 'w' ? white : black
    const res = await requestLlmMove({ config: side, position: { startFen, sanMoves }, chat: (r) => chatWithLlm(r) })
    illegalAttempts += res.attempts.filter((a) => a.problem).length
    if (res.kind === 'error') {
      termination = `API error for ${side.name}: ${res.error}`
      break
    }
    if (res.kind === 'forfeit') {
      result = chess.turn() === 'w' ? '0-1' : '1-0'
      termination = `${side.name} forfeits: ${res.reason}`
      break
    }
    sanMoves.push(res.move.san)
    opts.log?.(`${chess.moveNumber()}${chess.turn() === 'w' ? '.' : '...'} ${res.move.san} (${side.name})`)
  }

  const game = new Chess(startFen)
  for (const m of sanMoves) game.move(m)
  game.header('Event', 'Chessin LLM arena', 'White', white.name, 'Black', black.name, 'Result', result, 'Termination', termination)
  return { pgn: game.pgn(), result, termination, illegalAttempts }
}

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: npm run arena -- <arena.json>')
    process.exit(1)
  }
  const cfg = JSON.parse(readFileSync(file, 'utf-8')) as ArenaFile
  if (!cfg.players || cfg.players.length !== 2) throw new Error('"players" must list exactly two players')
  const [a, b] = cfg.players.map(toConfig)
  const games = cfg.games ?? 1
  const score = { [a.name]: 0, [b.name]: 0 }

  for (let g = 0; g < games; g++) {
    const [white, black] = g % 2 === 0 ? [a, b] : [b, a]
    console.log(`\nGame ${g + 1}: ${white.name} (White) vs ${black.name} (Black)`)
    const r = await playGame(white, black, {
      maxPlies: cfg.maxPlies ?? 300,
      log: cfg.quiet ? undefined : (s) => console.log(s)
    })
    console.log(`Result ${r.result} — ${r.termination} (illegal attempts: ${r.illegalAttempts})`)
    if (r.result === '1-0') score[white.name] += 1
    else if (r.result === '0-1') score[black.name] += 1
    else if (r.result === '1/2-1/2') {
      score[white.name] += 0.5
      score[black.name] += 0.5
    }
    if (cfg.out) appendFileSync(cfg.out, r.pgn + '\n\n')
  }
  console.log(`\nScore: ${a.name} ${score[a.name]} – ${score[b.name]} ${b.name}`)
}

if (process.argv[1] && /llm-arena\.(m?js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
